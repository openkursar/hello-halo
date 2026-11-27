import { create } from 'zustand'
import { api } from '../api'
import { isElectron, onServerUrlChange, onWsAuthenticated, orgSignInOffered } from '../api/transport'
import type { RpcResponse } from '../../shared/rpc/define'
import type { OrgSignInResult, OrgSignInState } from '../../shared/types/enterprise-identity'
import type { HaloConfig } from '../types'
import { useAppStore } from './app.store'

interface OrgSignInStore {
  state: OrgSignInState | null
  readFailed: boolean
  lastResult: OrgSignInResult | null
  start: () => void
  retry: () => Promise<void>
  /** Joins a sign-in already running, including the direct account sign-in chosen in its window. */
  signIn: () => Promise<OrgSignInResult>
  signOut: (scope: 'session' | 'device') => Promise<void>
}

function unwrap<T>(res: RpcResponse<T>): T {
  if (!res.success || res.data === undefined) throw new Error(res.error || 'Request failed')
  return res.data
}

const CLOSED_BY_USER = new Set(['Login window closed', 'Login cancelled'])

/** Signs in to a model account on its own and loads the saved account. */
async function signInDirectly(provider: string): Promise<OrgSignInResult> {
  let loginId: string | undefined
  try {
    const started = await api.authStartLogin(provider)
    loginId = started.data?.loginId
    if (!started.success || !started.data || !loginId) throw new Error(started.error || 'Login did not start')
    const { loginUrl, state, redirectUri } = started.data
    const done = redirectUri && loginUrl
      ? await api.authOpenLoginWindow(provider, loginId)
      : await api.authCompleteLogin(provider, state, loginId)
    if (!done.success) {
      void api.authCancelLogin(provider, loginId).catch(() => undefined)
      return CLOSED_BY_USER.has(done.error ?? '') ? 'cancelled' : 'failed'
    }
  } catch (error) {
    console.warn('[OrgSignIn] Direct account sign-in failed', error)
    if (loginId) void api.authCancelLogin(provider, loginId).catch(() => undefined)
    return 'failed'
  }
  // The account is saved; a failed read is retried, never a second sign-in.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const latest = await api.getConfig({ snapshot: true })
      if (latest.success && latest.data) {
        useAppStore.getState().setConfig(latest.data as HaloConfig)
        break
      }
    } catch {
      console.warn('[OrgSignIn] Could not reload settings after direct sign-in')
    }
  }
  return { alternative: provider }
}

export const useOrgSignInStore = create<OrgSignInStore>((set) => {
  let stop: (() => void) | undefined
  let revision = 0
  let signingIn: Promise<OrgSignInResult> | undefined

  const read = async (request: () => Promise<RpcResponse<OrgSignInState>>, isCurrent = () => true) => {
    const before = ++revision
    try {
      const state = unwrap(await request())
      if (revision === before && isCurrent()) set({ state, readFailed: false })
    } catch (error) {
      console.warn('[OrgSignIn] Could not refresh organization sign-in', error)
      if (revision === before && isCurrent()) set({ readFailed: true })
    }
  }

  return {
    state: null,
    readFailed: false,
    lastResult: null,

    start: () => {
      if (stop || !orgSignInOffered()) return
      const unsubscribe = api.onEnterpriseIdentityChanged(next => {
        revision++
        set({ state: next, readFailed: false })
      })
      if (isElectron()) {
        stop = unsubscribe
        void read(api.enterpriseIdentityState)
        return
      }
      const stopRefresh = onWsAuthenticated(isCurrent => void read(api.enterpriseIdentityState, isCurrent))
      const stopServer = onServerUrlChange(() => {
        stop?.()
        stop = undefined
        revision++
        set({ state: null, readFailed: false, lastResult: null })
      })
      stop = () => { unsubscribe(); stopRefresh(); stopServer() }
    },

    retry: () => read(isElectron() ? api.enterpriseIdentityRetry : api.enterpriseIdentityState),

    signIn: () => signingIn ??= (async () => {
      set({ lastResult: null })
      let result: OrgSignInResult
      try {
        result = unwrap(await api.enterpriseIdentitySignIn())
      } catch (error) {
        console.warn('[OrgSignIn] Sign-in failed', error)
        result = 'failed'
      }
      if (typeof result === 'object') result = await signInDirectly(result.alternative)
      set({ lastResult: result })
      return result
    })().finally(() => { signingIn = undefined }),

    signOut: async (scope) => {
      const before = ++revision
      const state = unwrap(await api.enterpriseIdentitySignOut({ scope }))
      if (revision === before) set({ state, readFailed: false })
    },
  }
})
