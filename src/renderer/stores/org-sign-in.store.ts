import { create } from 'zustand'
import { api } from '../api'
import { isElectron, onServerUrlChange, onWsAuthenticated, orgSignInOffered } from '../api/transport'
import type { RpcResponse } from '../../shared/rpc/define'
import type { OrgSignInResult, OrgSignInState } from '../../shared/types/enterprise-identity'

interface OrgSignInStore {
  state: OrgSignInState | null
  readFailed: boolean
  lastResult: OrgSignInResult | null
  start: () => void
  retry: () => Promise<void>
  signIn: () => Promise<OrgSignInResult>
  signOut: (scope: 'session' | 'device') => Promise<void>
}

function unwrap<T>(res: RpcResponse<T>): T {
  if (!res.success || res.data === undefined) throw new Error(res.error || 'Request failed')
  return res.data
}

export const useOrgSignInStore = create<OrgSignInStore>((set) => {
  let stop: (() => void) | undefined
  let revision = 0

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

    signIn: async () => {
      set({ lastResult: null })
      let result: OrgSignInResult
      try {
        result = unwrap(await api.enterpriseIdentitySignIn())
      } catch (error) {
        console.warn('[OrgSignIn] Sign-in failed', error)
        result = 'failed'
      }
      set({ lastResult: result })
      return result
    },

    signOut: async (scope) => {
      const before = ++revision
      const state = unwrap(await api.enterpriseIdentitySignOut({ scope }))
      if (revision === before) set({ state, readFailed: false })
    },
  }
})
