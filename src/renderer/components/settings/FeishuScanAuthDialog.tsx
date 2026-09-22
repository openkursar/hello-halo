/**
 * Feishu Scan-Auth Dialog
 *
 * QR-code onboarding for a Feishu / Lark bot. Unlike the WeCom flow, the scan
 * does not just hand over an existing bot's credentials — it *creates* the
 * Feishu app: the user reviews a pre-filled name and icon in the Feishu client,
 * agrees, and Feishu returns the new App ID / App Secret with bot capability,
 * messaging scopes, the message event and WebSocket delivery already configured.
 *
 *   1. Dialog opens and requests a device code + QR URL from main
 *   2. User scans with the Feishu app, edits the name/icon if they want, agrees
 *   3. Dialog creates a default digital human (cold start) and hands the
 *      credentials to its parent, which persists the channel instance
 *
 * Cancellation is wired through to main, so closing the dialog mid-poll aborts
 * the in-flight HTTPS read instead of leaving it running.
 *
 * One tenant-shaped outcome the copy has to prepare the user for: in a company
 * tenant with app review enabled, the created app may need an administrator to
 * approve its release before the bot answers. That is Feishu policy, not
 * something Halo can wait out, so the success state says so.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { CheckCircle2, Loader2, QrCode, RefreshCw, X, XCircle } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'

// ============================================
// Types
// ============================================

export interface FeishuScanAuthDialogProps {
  /** Whether the dialog is open. */
  open: boolean
  /** Called when the dialog is dismissed (close button, backdrop, or after success). */
  onClose: () => void
  /**
   * Bind the new bot to this digital human instead of minting one. Omit it for
   * the cold-start path, where the user has no digital human yet.
   */
  targetAppId?: string
  /** Display name for targetAppId, used in the success message. */
  targetAppName?: string
  /**
   * Called after a successful scan. Receives the created app's credentials and
   * the bound digital human; the parent persists the channel instance.
   */
  onComplete: (result: {
    appId: string
    appSecret: string
    tenantBrand: 'feishu' | 'lark'
    assistantAppId: string
    assistantAppName: string
  }) => void | Promise<void>
}

type DialogState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; deviceCode: string; authUrl: string; expiresAt: number }
  | { kind: 'finalizing' }
  | { kind: 'success'; assistantAppName: string; tenantBrand: 'feishu' | 'lark' }
  | { kind: 'error'; message: string; errorKind?: string }

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
      // Fixed black-on-white on purpose: scanners expect dark modules on a
      // light background, and dark-theme tokens would invert the code.
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

export function FeishuScanAuthDialog({
  open,
  onClose,
  onComplete,
  targetAppId,
  targetAppName,
}: FeishuScanAuthDialogProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<DialogState>({ kind: 'idle' })
  const [now, setNow] = useState(() => Date.now())

  // Keep the latest onComplete in a ref so the polling effect doesn't restart
  // when the parent re-creates the callback.
  const onCompleteRef = useRef(onComplete)
  useEffect(() => { onCompleteRef.current = onComplete })

  // Tick once a second to refresh the countdown without re-rendering on every
  // animation frame.
  useEffect(() => {
    if (state.kind !== 'waiting') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [state.kind])

  // Cancel any in-flight scan when the dialog closes or unmounts. The active
  // device code lives in a ref so a fresh scan is never cancelled by accident.
  const activeCodeRef = useRef<string | null>(null)

  const cancelActiveScan = useCallback(async () => {
    const deviceCode = activeCodeRef.current
    if (!deviceCode) return
    activeCodeRef.current = null
    try {
      await api.feishuBotScanAuthCancel(deviceCode)
    } catch (err) {
      console.warn('[FeishuScanAuth] cancel failed (non-critical)', err)
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
    await cancelActiveScan()

    let deviceCode = ''
    try {
      const res = await api.feishuBotScanAuthStart()
      if (!res.success || !res.data) {
        setState({ kind: 'error', message: res.error || t('Failed to start QR scan') })
        return
      }
      deviceCode = res.data.deviceCode
      activeCodeRef.current = deviceCode
      setState({
        kind: 'waiting',
        deviceCode,
        authUrl: res.data.authUrl,
        // The server decides how long its device code lives, so the countdown
        // uses that rather than a hardcoded window.
        expiresAt: Date.now() + res.data.expiresInMs,
      })
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      return
    }

    // The main-side handler long-polls, so a single await is the whole wait.
    try {
      const pollRes = await api.feishuBotScanAuthPoll(deviceCode)
      // Guard against a late response arriving after the dialog moved on.
      if (activeCodeRef.current !== deviceCode) return

      if (!pollRes.success || !pollRes.data) {
        const errorKind = (pollRes as { kind?: string }).kind
        if (errorKind === 'cancelled') {
          // Cancelled by the user — the close handler owns the state reset.
          return
        }
        if (errorKind === 'timeout' || errorKind === 'expired') {
          setState({ kind: 'error', message: t('QR code expired. Please regenerate.'), errorKind })
        } else if (errorKind === 'denied') {
          setState({ kind: 'error', message: t('Authorization was declined in Feishu.'), errorKind })
        } else {
          setState({ kind: 'error', message: pollRes.error || t('Scan failed'), errorKind })
        }
        return
      }

      setState({ kind: 'finalizing' })
      const { appId, appSecret, tenantBrand } = pollRes.data

      let assistantAppId: string
      let assistantAppName: string
      if (targetAppId) {
        assistantAppId = targetAppId
        assistantAppName = targetAppName ?? ''
      } else {
        // Cold start: no digital human to bind to, so mint one.
        const createRes = await api.feishuBotScanAuthCreateAssistant({
          appIdSuffix: appId.replace(/^cli_/, '').slice(0, 8),
        })
        if (!createRes.success || !createRes.data) {
          setState({
            kind: 'error',
            message: createRes.error || t('Failed to create default digital human'),
          })
          return
        }
        assistantAppId = createRes.data.appId
        assistantAppName = createRes.data.appName
      }

      try {
        await onCompleteRef.current({
          appId,
          appSecret,
          tenantBrand,
          assistantAppId,
          assistantAppName,
        })
      } catch (err) {
        console.error('[FeishuScanAuth] onComplete handler threw:', err)
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
        return
      }
      setState({ kind: 'success', assistantAppName, tenantBrand })
      // No auto-close: the success state carries the two things the user still
      // has to know — send the first message to claim ownership, and that a
      // company tenant may require an admin to approve the new app.
    } catch (err) {
      if (activeCodeRef.current !== deviceCode) return
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [cancelActiveScan, t, targetAppId, targetAppName])

  // Kick off the scan automatically when the dialog opens — saves a click and
  // matches the "scan once" mental model. Errors land in the error state with a
  // retry button.
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
            <h2 className="text-base font-medium truncate">{t('Scan to add Feishu Bot')}</h2>
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
                  {t('Open Feishu on your phone and scan to create the bot')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('You can change the bot name and icon on the confirmation page before agreeing. Halo requests only the minimum permissions it needs to send and receive messages.')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('Keep the availability scope at yourself or a few members — most tenants then publish it without admin review.')}
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

          {/* Finalizing */}
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
                {t('Bound to "{{name}}".', { name: state.assistantAppName })}
              </p>

              {/* Required next step: without a first message the bot cannot learn
                  its owner's Feishu ID, and permission control stays unclaimed. */}
              <div className="mt-2 flex items-start gap-2 rounded-lg bg-primary/10 border border-primary/30 px-3 py-2 max-w-xs">
                <QrCode className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-xs text-foreground/80 leading-relaxed text-left">
                    {t('Next step: open Feishu, find the bot by name and send it any message. Your user ID will be bound as the owner automatically.')}
                  </p>
                  <p className="text-xs text-foreground/80 leading-relaxed text-left">
                    {t('Do it right away — the first person to message the bot in a direct chat becomes its owner.')}
                  </p>
                </div>
              </div>

              <p className="text-[11px] text-muted-foreground text-center max-w-xs leading-relaxed">
                {t('If the app landed in your company\'s review queue, an administrator has to approve it before the bot can reply.')}
              </p>

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

        {/* Footer hint — only while waiting */}
        {state.kind === 'waiting' && (
          <div className="px-5 py-3 sm:px-6 border-t border-border bg-muted/30">
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {t('Works with both Feishu and Lark accounts. Reading group messages you were not mentioned in is a sensitive Feishu permission — turn it on yourself in the Feishu console if you need it.')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
