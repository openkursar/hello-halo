/**
 * Enterprise identity scan dialog
 *
 * Company sign-in. Main asks the build's identity provider to start an attempt:
 * a QR method shows a code the user scans with the company app and confirms
 * there; a browser method opens the approval page in the default browser. The dialog
 * owns the screen while the sign-in runs and polls only while it is open:
 * closing it cancels the attempt, so nothing keeps waiting in the background.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Check, CheckCircle2, Copy, ExternalLink, Globe, Loader2, QrCode, RefreshCw, Smartphone, X, XCircle } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { EnterpriseIdentityMethod, EnterpriseIdentityState, EnterpriseLoginOutcome } from '../../../shared/types/enterprise-identity'
import { copyToClipboard } from '../../utils/clipboard'
import { unwrapIdentity } from './enterprise-identity-result'

export interface EnterpriseIdentityScanDialogProps {
  open: boolean
  methodId: string
  methodLabel: string
  methodKind: EnterpriseIdentityMethod['kind']
  onClose: () => void
  /** Called with the new state whenever the sign-in ends (signed in or not). */
  onStateChange: (state: EnterpriseIdentityState) => void
}

type DialogState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; flowId: string; qrContent?: string; url?: string; expiresAt: number; scanned: boolean; hint?: string }
  | { kind: 'success'; name: string }
  | { kind: 'error'; outcome: EnterpriseLoginOutcome | 'start'; message?: string }

function ScanQrCode({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!canvasRef.current || !value) return
    QRCode.toCanvas(canvasRef.current, value, {
      width: 192,
      margin: 1,
      // Fixed black-on-white: scanners expect dark modules on a light background.
      color: { dark: '#000000', light: '#ffffff' },
    }).catch(console.error)
  }, [value])
  return <canvas ref={canvasRef} width={192} height={192} className="rounded-md border border-border bg-white" data-testid="enterprise-identity-qr" />
}

export function EnterpriseIdentityScanDialog({ open, methodId, methodLabel, methodKind, onClose, onStateChange }: EnterpriseIdentityScanDialogProps) {
  const { t } = useTranslation()
  const browser = methodKind === 'browser'
  const [state, setState] = useState<DialogState>({ kind: 'idle' })
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)
  const onStateChangeRef = useRef(onStateChange)
  useEffect(() => { onStateChangeRef.current = onStateChange })

  // The attempt this dialog is waiting for; a late answer for another one is ignored.
  const activeFlowRef = useRef<string | null>(null)

  const cancelActive = useCallback(async () => {
    const flowId = activeFlowRef.current
    if (!flowId) return
    activeFlowRef.current = null
    try {
      onStateChangeRef.current(unwrapIdentity(await api.enterpriseIdentityCancel({ flowId })))
    } catch (err) {
      console.warn('[EnterpriseIdentity] cancel failed (non-critical)', err)
    }
  }, [])

  useEffect(() => {
    if (state.kind !== 'waiting') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [state.kind])

  useEffect(() => {
    if (open) return
    void cancelActive()
    setState({ kind: 'idle' })
  }, [open, cancelActive])

  useEffect(() => () => { void cancelActive() }, [cancelActive])

  const start = useCallback(async () => {
    setState({ kind: 'starting' })
    await cancelActive()
    let flowId: string
    try {
      const begun = unwrapIdentity(await api.enterpriseIdentityBegin({ methodId }))
      if (!begun.flow) throw new Error(browser ? t('The sign-in service did not return a sign-in page') : t('The sign-in service did not return a QR code'))
      const { qrContent, url, expiresAt, hint } = begun.flow
      flowId = begun.flow.flowId
      activeFlowRef.current = flowId
      setNow(Date.now())
      setCopied(false)
      setState({ kind: 'waiting', flowId, qrContent, url, expiresAt, scanned: false, hint })
      if (browser && url) void api.openExternal(url)
    } catch (err) {
      setState({ kind: 'error', outcome: 'start', message: err instanceof Error ? err.message : String(err) })
      return
    }

    // Each poll waits a bounded time in main; repeat while the attempt is open.
    for (;;) {
      let result
      try {
        result = unwrapIdentity(await api.enterpriseIdentityPoll({ flowId }))
      } catch (err) {
        if (activeFlowRef.current !== flowId) return
        activeFlowRef.current = null
        setState({ kind: 'error', outcome: 'failed', message: err instanceof Error ? err.message : String(err) })
        return
      }
      if (activeFlowRef.current !== flowId) return
      if (result.outcome === 'pending') continue
      if (result.outcome === 'scanned') {
        setState(prev => prev.kind === 'waiting' && prev.flowId === flowId ? { ...prev, scanned: true } : prev)
        continue
      }
      activeFlowRef.current = null
      onStateChangeRef.current(result.state)
      if (result.outcome === 'ready') {
        setState({ kind: 'success', name: result.state.account?.displayName ?? '' })
      } else {
        setState({ kind: 'error', outcome: result.outcome, message: result.message })
      }
      return
    }
  }, [browser, cancelActive, methodId, t])

  useEffect(() => {
    if (open && state.kind === 'idle') void start()
  }, [open, state.kind, start])

  if (!open) return null

  const remaining = state.kind === 'waiting' ? Math.max(0, Math.ceil((state.expiresAt - now) / 1000)) : 0
  const countdown = `${Math.floor(remaining / 60)}:${(remaining % 60).toString().padStart(2, '0')}`

  const errorTitle = (outcome: EnterpriseLoginOutcome | 'start'): string => {
    switch (outcome) {
      case 'denied': return browser ? t('Sign-in was declined') : t('Sign-in was declined on your phone')
      case 'expired': return browser ? t('The sign-in page expired. Please start again.') : t('QR code expired. Please regenerate.')
      case 'cancelled': return t('Sign-in was cancelled')
      default: return t('Sign-in failed')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6" onClick={onClose} role="dialog" aria-modal="true" data-testid="enterprise-identity-dialog">
      <div className="w-full max-w-md bg-card border border-border rounded-xl shadow-xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5 min-w-0">
            {browser ? <Globe className="w-5 h-5 text-primary flex-shrink-0" /> : <QrCode className="w-5 h-5 text-primary flex-shrink-0" />}
            <h2 className="text-base font-medium truncate">{t('Sign in with {{method}}', { method: methodLabel })}</h2>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors flex-shrink-0" aria-label={t('Close')}>
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="px-5 py-6 sm:px-6">
          {state.kind === 'starting' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
              <p className="text-sm text-muted-foreground">{browser ? t('Preparing sign-in...') : t('Generating QR code...')}</p>
            </div>
          )}

          {state.kind === 'waiting' && browser && (
            <div className="flex flex-col items-center gap-4">
              {state.url ? <Globe className="w-10 h-10 text-primary" /> : <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />}
              <div className="text-center space-y-1">
                <p className="text-sm font-medium" data-testid="enterprise-identity-instruction">
                  {state.url ? t('Approve the sign-in on the page opened in your browser') : t('Signing in...')}
                </p>
                {state.hint && <p className="text-xs text-muted-foreground">{state.hint}</p>}
              </div>
              {state.url && (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button type="button" onClick={() => { if (state.url) void api.openExternal(state.url) }} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                    <ExternalLink className="w-3.5 h-3.5" />
                    {t('Open again')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!state.url) return
                      copyToClipboard(state.url).then(() => setCopied(true)).catch(err => console.warn('[EnterpriseIdentity] copy failed', err))
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-muted transition-colors"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? t('Copied') : t('Copy link')}
                  </button>
                </div>
              )}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{t('Expires in')} {countdown}</span>
                <button type="button" onClick={() => void start()} className="flex items-center gap-1 text-primary hover:underline">
                  <RefreshCw className="w-3 h-3" />
                  {t('Start again')}
                </button>
              </div>
            </div>
          )}

          {state.kind === 'waiting' && !browser && (
            <div className="flex flex-col items-center gap-4">
              <div className="relative">
                <ScanQrCode value={state.qrContent ?? ''} />
                {state.scanned && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-md bg-card/95">
                    <Smartphone className="w-8 h-8 text-primary" />
                    <p className="text-sm font-medium text-center px-4">{t('Scanned. Confirm the sign-in on your phone.')}</p>
                  </div>
                )}
              </div>
              <div className="text-center space-y-1">
                <p className="text-sm font-medium" data-testid="enterprise-identity-instruction">
                  {state.scanned ? t('Waiting for confirmation on your phone') : t('Scan with your company app to sign in')}
                </p>
                {state.hint && <p className="text-xs text-muted-foreground">{state.hint}</p>}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{t('Expires in')} {countdown}</span>
                <button type="button" onClick={() => void start()} className="flex items-center gap-1 text-primary hover:underline">
                  <RefreshCw className="w-3 h-3" />
                  {t('Regenerate')}
                </button>
              </div>
            </div>
          )}

          {state.kind === 'success' && (
            <div className="flex flex-col items-center gap-3 py-6" data-testid="enterprise-identity-success">
              <CheckCircle2 className="w-10 h-10 text-green-500" />
              <p className="text-sm font-medium">{t('Signed in')}</p>
              {state.name && <p className="text-xs text-muted-foreground text-center max-w-xs">{state.name}</p>}
              <p className="text-xs text-muted-foreground text-center max-w-xs">
                {t('Company tools can now use this sign-in. Halo hands them access itself; the AI never sees it.')}
              </p>
              <button type="button" onClick={onClose} className="mt-2 px-4 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                {t('Done')}
              </button>
            </div>
          )}

          {state.kind === 'error' && (
            <div className="flex flex-col items-center gap-3 py-6" data-testid="enterprise-identity-error">
              <XCircle className="w-10 h-10 text-red-500" />
              <p className="text-sm font-medium text-center">{errorTitle(state.outcome)}</p>
              {state.message && <p className="text-xs text-muted-foreground text-center break-words max-w-xs">{state.message}</p>}
              <div className="flex items-center gap-2 pt-2">
                <button type="button" onClick={() => void start()} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t('Try again')}
                </button>
                <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg border border-border text-muted-foreground hover:bg-muted transition-colors">
                  {t('Cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
