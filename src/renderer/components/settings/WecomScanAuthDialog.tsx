/**
 * WeCom Scan-Auth Dialog
 *
 * 3-step QR-code onboarding for the WeCom Intelligent Bot (企业微信智能机器人):
 *
 *   1. Click "Scan to add" — dialog opens, requests a fresh scode from main
 *   2. User scans the QR with WeCom App on their phone and taps "Agree"
 *   3. Dialog auto-creates a default assistant + new instance config and closes
 *
 * The dialog owns its own lifecycle: it generates the scode, renders the QR
 * (via the qrcode library already bundled for WeChat iLink), polls for the
 * result, and (on success) installs the default assistant + appends the new
 * instance to imChannels.instances via the supplied onComplete callback.
 *
 * Cancellation is wired through to main via wecomBotScanAuthCancel(scode),
 * so closing the dialog mid-poll immediately abort()s the HTTPS read on the
 * server side and frees the AbortController slot.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Loader2, RefreshCw, CheckCircle2, XCircle, X, QrCode } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'

// ============================================
// Types
// ============================================

export interface WecomScanAuthDialogProps {
  /** Whether the dialog is open. */
  open: boolean
  /** Called when the dialog is dismissed (cancel button, backdrop, or after success). */
  onClose: () => void
  /**
   * Bind the scanned bot to this digital human instead of minting a new one.
   * Omit it for the cold-start path, where the user has no digital human yet.
   */
  targetAppId?: string
  /** Display name for targetAppId, used in the success message. */
  targetAppName?: string
  /**
   * Called after a successful scan. Receives the bot credentials and the bound
   * app metadata; the parent is responsible for persisting the instance.
   */
  onComplete: (result: {
    botId: string
    secret: string
    appId: string
    appName: string
  }) => void | Promise<void>
}

type DialogState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; scode: string; authUrl: string; expiresAt: number }
  | { kind: 'finalizing' }
  | { kind: 'success'; appName: string }
  | { kind: 'error'; message: string; kind2?: string }

// 5 minute scode TTL per the WeCom protocol — used for countdown display.
const SCODE_TTL_MS = 5 * 60_000

// ============================================
// QR Code Canvas
// ============================================

function ScanQrCode({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!canvasRef.current || !value) return
    QRCode.toCanvas(canvasRef.current, value, {
      width: 192,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    }).catch(console.error)
  }, [value])
  return (
    <canvas
      ref={canvasRef}
      width={192}
      height={192}
      className="rounded-md border border-border bg-white"
    />
  )
}

// ============================================
// Component
// ============================================

export function WecomScanAuthDialog({ open, onClose, onComplete, targetAppId, targetAppName }: WecomScanAuthDialogProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<DialogState>({ kind: 'idle' })
  const [now, setNow] = useState(() => Date.now())

  // Keep the latest onComplete in a ref so the polling effect doesn't restart
  // when the parent re-creates the callback.
  const onCompleteRef = useRef(onComplete)
  useEffect(() => { onCompleteRef.current = onComplete })

  // Tick once a second to refresh the countdown without re-rendering on
  // every animation frame.
  useEffect(() => {
    if (state.kind !== 'waiting') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [state.kind])

  // Cancel any in-flight scan when the dialog closes or unmounts. We capture
  // the active scode in a ref so we don't accidentally cancel a fresh scan.
  const activeScodeRef = useRef<string | null>(null)

  const cancelActiveScan = useCallback(async () => {
    const scode = activeScodeRef.current
    if (!scode) return
    activeScodeRef.current = null
    try {
      await api.wecomBotScanAuthCancel(scode)
    } catch (err) {
      console.warn('[WecomScanAuth] cancel failed (non-critical)', err)
    }
  }, [])

  // Reset to idle whenever the dialog closes.
  useEffect(() => {
    if (open) return
    cancelActiveScan()
    setState({ kind: 'idle' })
  }, [open, cancelActiveScan])

  // Cancel on unmount.
  useEffect(() => () => { cancelActiveScan() }, [cancelActiveScan])

  // ── Action: start a new scan session ─────────────────────────────
  const startScan = useCallback(async () => {
    setState({ kind: 'starting' })
    // Cancel any previous session before starting fresh.
    await cancelActiveScan()

    let scode = ''
    try {
      const res = await api.wecomBotScanAuthStart()
      if (!res.success || !res.data) {
        setState({ kind: 'error', message: res.error || t('Failed to start QR scan') })
        return
      }
      scode = res.data.scode
      activeScodeRef.current = scode
      setState({
        kind: 'waiting',
        scode,
        authUrl: res.data.authUrl,
        expiresAt: Date.now() + SCODE_TTL_MS,
      })
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      return
    }

    // Poll loop runs once on entry to 'waiting'; the IPC handler is itself
    // long-polling so we just await its single response.
    try {
      const pollRes = await api.wecomBotScanAuthPoll(scode)
      // Guard against late responses arriving after the dialog moved on.
      if (activeScodeRef.current !== scode) return

      if (!pollRes.success || !pollRes.data) {
        const kindStr = (pollRes as { kind?: string }).kind
        if (kindStr === 'cancelled') {
          // Cancelled by the user — leave state alone (close handler resets).
          return
        }
        if (kindStr === 'timeout' || kindStr === 'expired') {
          setState({ kind: 'error', message: t('QR code expired. Please regenerate.'), kind2: kindStr })
        } else {
          setState({
            kind: 'error',
            message: pollRes.error || t('Scan failed'),
            kind2: kindStr,
          })
        }
        return
      }

      setState({ kind: 'finalizing' })
      const { botId, secret } = pollRes.data

      let appId: string
      let appName: string
      if (targetAppId) {
        appId = targetAppId
        appName = targetAppName ?? ''
      } else {
        // Cold start: no digital human to bind to, so mint one.
        const createRes = await api.wecomBotScanAuthCreateAssistant({
          botIdPrefix: botId.slice(0, 8),
        })
        if (!createRes.success || !createRes.data) {
          setState({
            kind: 'error',
            message: createRes.error || t('Failed to create default digital human'),
          })
          return
        }
        appId = createRes.data.appId
        appName = createRes.data.appName
      }
      try {
        await onCompleteRef.current({ botId, secret, appId, appName })
      } catch (err) {
        console.error('[WecomScanAuth] onComplete handler threw:', err)
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
        return
      }
      setState({ kind: 'success', appName })
      // No auto-close: the success state contains a required next-step prompt
      // (send first message in WeCom to bind ownership). Dismissing the dialog
      // before the user reads that hint would leave them confused about why
      // they appear to be a "guest" on a bot they just created. The user
      // explicitly clicks "Got it" or the backdrop to close.
    } catch (err) {
      if (activeScodeRef.current !== scode) return
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [cancelActiveScan, t, onClose, targetAppId, targetAppName])

  // Kick off the scan automatically when the dialog opens — saves a click and
  // matches the "scan once" user mental model. Errors land in the error state
  // with a Retry button.
  useEffect(() => {
    if (open && state.kind === 'idle') {
      startScan()
    }
  }, [open, state.kind, startScan])

  // ── Render ───────────────────────────────────────────────────────
  if (!open) return null

  const remainingSec =
    state.kind === 'waiting'
      ? Math.max(0, Math.ceil((state.expiresAt - now) / 1000))
      : 0

  const mins = Math.floor(remainingSec / 60)
  const secs = remainingSec % 60
  const countdown = `${mins}:${secs.toString().padStart(2, '0')}`

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md bg-card border border-border rounded-xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5 min-w-0">
            <QrCode className="w-5 h-5 text-primary flex-shrink-0" />
            <h2 className="text-base font-medium truncate">{t('Scan to add WeCom Bot')}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-muted transition-colors flex-shrink-0"
            aria-label={t('Close')}
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-6 sm:px-6">
          {/* Starting */}
          {state.kind === 'starting' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
              <p className="text-sm text-muted-foreground">{t('Generating QR code...')}</p>
            </div>
          )}

          {/* Waiting for scan */}
          {state.kind === 'waiting' && (
            <div className="flex flex-col items-center gap-4">
              <ScanQrCode value={state.authUrl} />
              <div className="text-center space-y-1">
                <p className="text-sm font-medium">
                  {t('Open WeCom on your phone and scan to authorize')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('After scanning, tap "Agree" to grant access. The new bot will be added automatically.')}
                </p>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{t('Expires in')} {countdown}</span>
                <button
                  type="button"
                  onClick={startScan}
                  className="flex items-center gap-1 text-primary hover:underline"
                >
                  <RefreshCw className="w-3 h-3" />
                  {t('Regenerate')}
                </button>
              </div>
            </div>
          )}

          {/* Finalizing (credentials received, installing assistant) */}
          {state.kind === 'finalizing' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="w-6 h-6 text-primary animate-spin" />
              <p className="text-sm text-foreground">{t('Creating default digital human...')}</p>
              <p className="text-xs text-muted-foreground text-center">
                {t('Almost done — wiring up your new bot.')}
              </p>
            </div>
          )}

          {/* Success */}
          {state.kind === 'success' && (
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="w-10 h-10 text-green-500" />
              <p className="text-sm font-medium">{t('Bot added successfully')}</p>
              <p className="text-xs text-muted-foreground text-center max-w-xs">
                {t('Bound to "{{name}}".', { name: state.appName })}
              </p>

              {/* Required next-step prompt — without sending a first message,
                  the bot cannot learn the owner's WeCom userid and the
                  permission control stays in a "pending claim" state. */}
              <div className="mt-2 flex items-start gap-2 rounded-lg bg-primary/10 border border-primary/30 px-3 py-2 max-w-xs">
                <QrCode className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                <p className="text-xs text-foreground/80 leading-relaxed text-left">
                  {t('Next step: open WeCom and send any message to this bot. Your user ID will be bound as the owner automatically — no manual setup needed.')}
                </p>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="mt-2 px-4 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                {t('Got it')}
              </button>
            </div>
          )}

          {/* Error */}
          {state.kind === 'error' && (
            <div className="flex flex-col items-center gap-3 py-6">
              <XCircle className="w-10 h-10 text-red-500" />
              <p className="text-sm font-medium text-center">{t('Setup failed')}</p>
              <p className="text-xs text-muted-foreground text-center break-words max-w-xs">
                {state.message}
              </p>
              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={startScan}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t('Try again')}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 text-sm rounded-lg border border-border text-muted-foreground hover:bg-muted transition-colors"
                >
                  {t('Cancel')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer hint — only show while waiting */}
        {state.kind === 'waiting' && (
          <div className="px-5 py-3 sm:px-6 border-t border-border bg-muted/30">
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {t('Note: WeCom App auto-assigns the bot name (e.g. "Your Name\'s Bot"). You can rename it in WeCom > Workbench > Intelligent Bot.')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
