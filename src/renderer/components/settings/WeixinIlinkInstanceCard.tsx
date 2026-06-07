/**
 * WeChat iLink Instance Card
 *
 * Renders a single WeChat iLink Bot instance with its QR-code authentication
 * flow, connection status, and digital-human binding selector.
 *
 * Extracted from MessageChannelsSection to keep that file focused on
 * channel-list orchestration rather than per-provider implementation.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import QRCode from 'qrcode'
import {
  Loader2, ChevronDown, RefreshCw, Smartphone,
  Trash2, MoreVertical, Bot,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type {
  ImChannelInstanceConfig,
  ImChannelInstanceStatus,
} from '../../../shared/types/im-channel'

// ============================================
// Types
// ============================================

export interface AutomationApp {
  id: string
  spec: { name: string }
}

/** Connection state for the WeChat iLink QR-code auth flow */
type WeixinIlinkAuthState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'qr-shown'; qrcode: string; qrcodeImgContent: string; baseUrl: string }
  | { status: 'scanning'; qrcode: string; qrcodeImgContent: string; baseUrl: string }
  | { status: 'connected' }
  | { status: 'expired' }

export interface WeixinIlinkInstanceCardProps {
  instance: ImChannelInstanceConfig
  status: ImChannelInstanceStatus | undefined
  automationApps: AutomationApp[]
  /** Teams selectable as a backend (a team = its lead digital human + members). */
  teams: { id: string; name: string; leadAppId: string | null }[]
  isExpanded: boolean
  onToggle: () => void
  onChange: (instance: ImChannelInstanceConfig) => void
  onDelete: () => void
}

// ============================================
// QR Code Canvas
// ============================================

/** Renders a QR code from a URL string onto a canvas using the qrcode library */
function WeixinQrCode({ value, muted = false }: { value: string; muted?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!canvasRef.current || !value) return
    QRCode.toCanvas(canvasRef.current, value, {
      width: 128,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    }).catch(console.error)
  }, [value])
  return (
    <canvas
      ref={canvasRef}
      width={128}
      height={128}
      className={`rounded border border-border mx-auto bg-white${muted ? ' opacity-60' : ''}`}
    />
  )
}

// ============================================
// Component
// ============================================

export function WeixinIlinkInstanceCard({
  instance,
  status,
  automationApps,
  teams,
  isExpanded,
  onToggle,
  onChange,
  onDelete,
}: WeixinIlinkInstanceCardProps) {
  const { t } = useTranslation()
  const isConnected = status?.connected ?? false
  const isEnabled = instance.enabled

  const [authState, setAuthState] = useState<WeixinIlinkAuthState>({ status: 'idle' })
  const [showMenu, setShowMenu] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
        setShowDeleteConfirm(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu])

  // Stop polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [])

  // When already connected in status, show connected state
  useEffect(() => {
    if (isConnected && authState.status === 'idle') {
      setAuthState({ status: 'connected' })
    }
  }, [isConnected, authState.status])

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  const startPolling = useCallback((qrcode: string, qrcodeImgContent: string, baseUrl: string) => {
    stopPolling()
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await api.weixinIlinkPollAuthStatus(qrcode)
        if (!res.success || !res.data) return
        const { status: pollStatus, botToken, accountId } = res.data
        if (pollStatus === 'scaned') {
          setAuthState({ status: 'scanning', qrcode, qrcodeImgContent, baseUrl })
        } else if (pollStatus === 'confirmed' && botToken) {
          stopPolling()
          setAuthState({ status: 'connected' })
          const confirmedBaseUrl = res.data.baseUrl ?? baseUrl
          // Save token + reload channels
          await api.weixinIlinkSaveToken(instance.id, botToken, confirmedBaseUrl, accountId)
          await api.imChannelsReload()
          // Update instance config in persisted state
          onChangeRef.current({
            ...instance,
            enabled: true,
            config: { botToken, baseUrl: confirmedBaseUrl, accountId: accountId ?? '' },
          })
        } else if (pollStatus === 'expired') {
          stopPolling()
          setAuthState({ status: 'expired' })
        }
      } catch {
        // Ignore poll errors — will retry on next tick
      }
    }, 2000)
  }, [stopPolling, instance])

  const handleConnect = useCallback(async () => {
    setAuthState({ status: 'loading' })
    try {
      const res = await api.weixinIlinkRequestQrcode()
      if (!res.success || !res.data) {
        setAuthState({ status: 'idle' })
        return
      }
      const { qrcode, qrcodeImgContent, baseUrl } = res.data
      setAuthState({ status: 'qr-shown', qrcode, qrcodeImgContent, baseUrl })
      startPolling(qrcode, qrcodeImgContent, baseUrl)
    } catch {
      setAuthState({ status: 'idle' })
    }
  }, [startPolling])

  const handleRefresh = useCallback(() => {
    stopPolling()
    handleConnect()
  }, [stopPolling, handleConnect])

  const handleDisconnect = useCallback(async () => {
    stopPolling()
    setAuthState({ status: 'idle' })
    await api.weixinIlinkDisconnect(instance.id)
    await api.imChannelsReload()
    onChangeRef.current({
      ...instance,
      enabled: false,
      config: { botToken: '', baseUrl: '', accountId: '' },
    })
  }, [stopPolling, instance])

  // Combined backend selector value: "app:<id>" or "team:<id>".
  const targetValue = instance.teamId ? `team:${instance.teamId}` : instance.appId ? `app:${instance.appId}` : ''

  const handleTargetChange = useCallback((value: string) => {
    if (value.startsWith('team:')) {
      const teamId = value.slice('team:'.length)
      const team = teams.find(tm => tm.id === teamId)
      onChange({ ...instance, teamId, appId: team?.leadAppId ?? '' })
    } else {
      const appId = value.startsWith('app:') ? value.slice('app:'.length) : value
      onChange({ ...instance, teamId: undefined, appId })
    }
  }, [instance, onChange, teams])

  // Resolve bound target name (a team, or a single digital human).
  const boundTeam = instance.teamId ? teams.find(tm => tm.id === instance.teamId) : undefined
  const boundApp = automationApps.find(a => a.id === instance.appId)
  const displayName = boundTeam
    ? t('Team: {{name}}', { name: boundTeam.name })
    : boundApp?.spec.name || t('Not bound')

  const statusDot = !isEnabled
    ? 'bg-muted-foreground/30'
    : (authState.status === 'connected' || isConnected)
      ? 'bg-green-500'
      : 'bg-amber-500'

  const statusText = !isEnabled
    ? t('Disabled')
    : (authState.status === 'connected' || isConnected)
      ? t('Connected')
      : t('Not connected')

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden bg-card/50">
      {/* Instance header */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot}`} />
          <div className="text-left min-w-0">
            <p className="text-sm font-medium truncate">{displayName}</p>
            <p className="text-[11px] text-muted-foreground truncate">
              {statusText}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Context menu */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu) }}
              className="p-1 rounded hover:bg-muted transition-colors"
            >
              <MoreVertical className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            {showMenu && (
              <div className="absolute right-0 top-full mt-1 bg-popover border border-border rounded-lg shadow-lg z-10 min-w-[140px] py-1">
                {showDeleteConfirm ? (
                  <div className="px-3 py-2 space-y-1.5">
                    <p className="text-xs text-muted-foreground">{t('Delete this instance?')}</p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setShowMenu(false); setShowDeleteConfirm(false); onDelete() }}
                        className="flex-1 px-2 py-1 text-xs rounded bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                      >
                        {t('Confirm')}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(false) }}
                        className="flex-1 px-2 py-1 text-xs rounded hover:bg-muted text-muted-foreground transition-colors"
                      >
                        {t('Cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true) }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted text-destructive transition-colors flex items-center gap-2"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('Delete')}
                  </button>
                )}
              </div>
            )}
          </div>
          <ChevronDown
            className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
          />
        </div>
      </button>

      {/* Instance body */}
      {isExpanded && (
        <div className="px-3 pb-3 pt-2 border-t border-border/60 space-y-3 animate-in slide-in-from-top-1 duration-150">
          {/* Auth flow */}
          <div className="flex flex-col items-center gap-3 py-2">
            {authState.status === 'idle' && (
              <button
                type="button"
                onClick={handleConnect}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
              >
                <Smartphone className="w-4 h-4" />
                {t('Connect WeChat')}
              </button>
            )}

            {authState.status === 'loading' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{t('Loading...')}</span>
              </div>
            )}

            {authState.status === 'qr-shown' && (
              <div className="flex flex-col items-center gap-2">
                <WeixinQrCode value={authState.qrcodeImgContent} />
                <p className="text-xs text-muted-foreground text-center">
                  {t('Scan with WeChat to connect')}
                </p>
              </div>
            )}

            {authState.status === 'scanning' && (
              <div className="flex flex-col items-center gap-2">
                <WeixinQrCode value={authState.qrcodeImgContent} muted />
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t('Waiting for confirmation...')}</span>
                </div>
              </div>
            )}

            {(authState.status === 'connected' || isConnected) && (
              <div className="flex flex-col items-center gap-2 w-full">
                <div className="flex items-center gap-1.5 text-sm text-green-500">
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  <span>{t('Connected')}</span>
                </div>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm border border-border rounded-lg text-muted-foreground hover:text-foreground hover:border-destructive/50 hover:bg-destructive/5 transition-colors"
                >
                  {t('Disconnect')}
                </button>
              </div>
            )}

            {authState.status === 'expired' && (
              <div className="flex flex-col items-center gap-2">
                <p className="text-xs text-muted-foreground">{t('QR code expired')}</p>
                <button
                  type="button"
                  onClick={handleRefresh}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t('Refresh')}
                </button>
              </div>
            )}
          </div>

          {/* Backend selector — a single digital human OR a team (team = its
              lead + members, same binding surface). */}
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">
              {t('Backend')} <span className="text-red-400">*</span>
            </label>
            <div className="relative">
              <Bot className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <select
                value={targetValue}
                onChange={(e) => handleTargetChange(e.target.value)}
                className="w-full bg-muted border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary appearance-none cursor-pointer"
              >
                <option value="">{t('Select a digital human or team')}</option>
                {automationApps.length > 0 && (
                  <optgroup label={t('Digital Humans')}>
                    {automationApps.map(app => (
                      <option key={app.id} value={`app:${app.id}`}>
                        {app.spec.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {teams.length > 0 && (
                  <optgroup label={t('Teams')}>
                    {teams.map(tm => (
                      <option key={tm.id} value={`team:${tm.id}`} disabled={!tm.leadAppId}>
                        {tm.leadAppId ? tm.name : t('{{name}} (no lead yet)', { name: tm.name })}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              {instance.teamId
                ? t('All messages from this Bot are handled by this team (its lead replies and can delegate to members)')
                : t('All messages from this Bot will be handled by this digital human')}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
