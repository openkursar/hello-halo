/**
 * WeixinIlinkScanDialog
 *
 * QR login for a WeChat personal bot, bound to a digital human the caller
 * already has.
 *
 * The iLink protocol stores its token against an existing channel instance, so
 * the caller must create the instance first and pass its id here; on success
 * the token lands on that instance and the connection comes up.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import QRCode from 'qrcode'
import { X, Loader2, RefreshCw } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'

const POLL_INTERVAL_MS = 2000

type ScanState =
  | { status: 'loading' }
  | { status: 'qr-shown'; qrcode: string; qrcodeImgContent: string; baseUrl: string }
  | { status: 'scanning'; qrcode: string; qrcodeImgContent: string; baseUrl: string }
  | { status: 'saving' }
  | { status: 'expired' }
  | { status: 'error'; message: string }

interface WeixinIlinkScanDialogProps {
  open: boolean
  /** Instance the scanned token is written to. */
  instanceId: string
  onClose: () => void
  onConnected: () => void | Promise<void>
}

function QrCanvas({ value, muted = false }: { value: string; muted?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!canvasRef.current || !value) return
    QRCode.toCanvas(canvasRef.current, value, { width: 160, margin: 1 }).catch(() => {})
  }, [value])
  return <canvas ref={canvasRef} className={muted ? 'opacity-40' : ''} />
}

export function WeixinIlinkScanDialog({ open, instanceId, onClose, onConnected }: WeixinIlinkScanDialogProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<ScanState>({ status: 'loading' })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onConnectedRef = useRef(onConnected)
  useEffect(() => { onConnectedRef.current = onConnected })

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startScan = useCallback(async () => {
    stopPolling()
    setState({ status: 'loading' })
    const res = await api.weixinIlinkRequestQrcode()
    if (!res.success || !res.data) {
      setState({ status: 'error', message: res.error || t('Failed to load QR code') })
      return
    }
    const { qrcode, qrcodeImgContent, baseUrl } = res.data
    setState({ status: 'qr-shown', qrcode, qrcodeImgContent, baseUrl })

    pollRef.current = setInterval(async () => {
      try {
        const poll = await api.weixinIlinkPollAuthStatus(qrcode)
        if (!poll.success || !poll.data) return
        const { status, botToken, accountId } = poll.data
        if (status === 'scaned') {
          setState({ status: 'scanning', qrcode, qrcodeImgContent, baseUrl })
        } else if (status === 'confirmed' && botToken) {
          stopPolling()
          setState({ status: 'saving' })
          const saved = await api.weixinIlinkSaveToken(instanceId, botToken, poll.data.baseUrl ?? baseUrl, accountId)
          if (!saved.success) {
            setState({ status: 'error', message: saved.error || t('Failed to bind') })
            return
          }
          await api.imChannelsReload()
          await onConnectedRef.current()
          onClose()
        } else if (status === 'expired') {
          stopPolling()
          setState({ status: 'expired' })
        }
      } catch {
        // Transient poll failures retry on the next tick.
      }
    }, POLL_INTERVAL_MS)
  }, [instanceId, onClose, stopPolling, t])

  useEffect(() => {
    if (!open) {
      stopPolling()
      return
    }
    void startScan()
    return stopPolling
  }, [open, startScan, stopPolling])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl shadow-lg w-[320px] p-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">{t('Add WeChat bot')}</h3>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-3 min-h-[200px] justify-center">
          {state.status === 'loading' && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}

          {state.status === 'qr-shown' && (
            <>
              <QrCanvas value={state.qrcodeImgContent} />
              <p className="text-xs text-muted-foreground text-center">{t('Scan with WeChat to connect')}</p>
            </>
          )}

          {state.status === 'scanning' && (
            <>
              <QrCanvas value={state.qrcodeImgContent} muted />
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('Waiting for confirmation...')}
              </div>
            </>
          )}

          {state.status === 'saving' && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {t('Connecting...')}
            </div>
          )}

          {(state.status === 'expired' || state.status === 'error') && (
            <>
              <p className="text-xs text-halo-warning text-center">
                {state.status === 'expired' ? t('QR code expired') : state.message}
              </p>
              <button
                onClick={() => void startScan()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-foreground border border-border rounded-lg hover:border-primary/60 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                {t('Retry')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
