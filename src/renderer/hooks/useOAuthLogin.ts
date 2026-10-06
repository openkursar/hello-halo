/**
 * useOAuthLogin — the OAuth sign-in a screen runs (first-run setup, AI sources
 * settings), one at a time.
 *
 * The main process owns the login. This hook tracks only the login this screen
 * started: an answer for a login the user already abandoned never updates the
 * screen, and leaving the screen cancels whatever is still pending. Starting
 * again after a reload needs no recovery — a new start supersedes the old one.
 */

import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useTranslation } from '../i18n'

export type OAuthLoginPhase = 'starting' | 'waiting' | 'redirect'

/** A redirect flow: sign in through the login window, or paste the code by hand. */
export interface RedirectLoginView {
  loginUrl: string
  manualCode: string
  windowOpen: boolean
  submitting: boolean
  copied: boolean
  error: string | null
}

export interface OAuthLoginView {
  provider: string
  phase: OAuthLoginPhase
  /** Device-code flows: the code to enter and where to enter it. */
  userCode?: string
  verificationUri?: string
  redirect?: RedirectLoginView
}

interface LoginOwner {
  provider: string
  loginId?: string
}

interface UseOAuthLoginOptions {
  /** Runs after the account is saved; a throw is reported like a failed login. */
  onSignedIn: () => Promise<void>
  /** The screen's error line; null clears it when a new login starts. */
  onError: (message: string | null) => void
}

export function useOAuthLogin({ onSignedIn, onError }: UseOAuthLoginOptions) {
  const { t } = useTranslation()
  const [login, setLogin] = useState<OAuthLoginView | null>(null)
  const mountedRef = useRef(false)
  const ownerRef = useRef<LoginOwner | null>(null)
  const callbacksRef = useRef({ onSignedIn, onError })
  callbacksRef.current = { onSignedIn, onError }

  const isCurrent = (owner: LoginOwner) => mountedRef.current && ownerRef.current === owner

  /** Returns the failure text, or null when the login is gone either way. */
  const cancelOwned = async (owner: LoginOwner): Promise<string | null> => {
    if (!owner.loginId) return null
    try {
      const result = await api.authCancelLogin(owner.provider, owner.loginId)
      if (result.success) return null
      // The error text may echo authorization details; the log names only the provider.
      console.warn(`[OAuthLogin] Could not cancel login for ${owner.provider}`)
      return result.error || t('Unable to cancel login')
    } catch {
      console.warn(`[OAuthLogin] Could not cancel login for ${owner.provider}`)
      return t('Unable to cancel login')
    }
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const owner = ownerRef.current
      ownerRef.current = null
      if (owner) void cancelOwned(owner)
    }
    // Runs once: the cleanup must cancel whatever login is pending at unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cancel = async () => {
    const owner = ownerRef.current
    ownerRef.current = null
    setLogin(null)
    if (!owner) return
    const failure = await cancelOwned(owner)
    if (failure && mountedRef.current && !ownerRef.current) callbacksRef.current.onError(failure)
  }

  const finish = async (owner: LoginOwner) => {
    await callbacksRef.current.onSignedIn()
    if (!isCurrent(owner)) return
    ownerRef.current = null
    setLogin(null)
  }

  const fail = async (owner: LoginOwner, error: unknown) => {
    if (!isCurrent(owner)) return
    callbacksRef.current.onError(error instanceof Error ? error.message : t('Login failed'))
    await cancel()
  }

  const updateRedirect = (patch: Partial<RedirectLoginView>) => {
    setLogin(prev => prev?.redirect ? { ...prev, redirect: { ...prev.redirect, ...patch } } : prev)
  }

  /** Adds an account, or reauthenticates `sourceId`. Ignored while another login runs. */
  const start = async (provider: string, sourceId?: string) => {
    if (ownerRef.current) return
    const owner: LoginOwner = { provider }
    ownerRef.current = owner
    callbacksRef.current.onError(null)
    setLogin({ provider, phase: 'starting' })
    try {
      const result = await api.authStartLogin(provider, sourceId)
      if (result.data?.loginId) owner.loginId = result.data.loginId
      if (!isCurrent(owner)) {
        await cancelOwned(owner)
        return
      }
      if (!result.success || !result.data) throw new Error(result.error || t('Failed to start login'))
      const { loginId, loginUrl, state, userCode, verificationUri, redirectUri } = result.data

      if (redirectUri && loginUrl) {
        setLogin({
          provider,
          phase: 'redirect',
          redirect: { loginUrl, manualCode: '', windowOpen: false, submitting: false, copied: false, error: null }
        })
        return
      }

      setLogin({ provider, phase: 'waiting', userCode, verificationUri })
      const completed = await api.authCompleteLogin(provider, state, loginId)
      if (!isCurrent(owner)) return
      if (!completed.success) throw new Error(completed.error || t('Login failed'))
      await finish(owner)
    } catch (error) {
      await fail(owner, error)
    }
  }

  const completeRedirect = async (manual: boolean) => {
    const owner = ownerRef.current
    const redirect = login?.redirect
    if (!owner?.loginId || !redirect || redirect.windowOpen || redirect.submitting) return
    const code = redirect.manualCode.trim()
    if (manual && !code) return
    updateRedirect({ windowOpen: !manual, submitting: manual, error: null })
    try {
      const result = manual
        ? await api.authCompleteLogin(owner.provider, code, owner.loginId)
        : await api.authOpenLoginWindow(owner.provider, owner.loginId)
      if (!isCurrent(owner)) return
      if (!result.success) throw new Error(result.error || t('Login failed'))
      await finish(owner)
    } catch (error) {
      await fail(owner, error)
    }
  }

  const copyLoginUrl = async () => {
    const owner = ownerRef.current
    const url = login?.redirect?.loginUrl
    if (!owner || !url) return
    try {
      await navigator.clipboard.writeText(url)
      if (isCurrent(owner)) updateRedirect({ copied: true })
    } catch {
      if (isCurrent(owner)) updateRedirect({ error: t('Could not copy the link. Select and copy it manually.') })
    }
  }

  return {
    login,
    start,
    cancel,
    openLoginWindow: () => completeRedirect(false),
    submitCode: () => completeRedirect(true),
    setManualCode: (manualCode: string) => updateRedirect({ manualCode }),
    copyLoginUrl
  }
}
