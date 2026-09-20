/**
 * AppBotBindingSection
 *
 * Binds IM bots to this digital human from its own settings page.
 *
 * The global message-channel page stays the bot-centric view (connection
 * parameters, which bot belongs where). This surface is app-centric: the
 * digital human is the known quantity and only the bot is missing. That
 * inversion is the point — the recommended scan flow in global settings always
 * mints a *new* digital human, so it was unusable for "give this existing one a
 * WeCom bot", which is the more common case.
 *
 * Provider connection fields (Bot ID / secret / wsUrl) deliberately stay out of
 * here: they describe what the bot is, not what this digital human uses.
 */

import { useState, useEffect, useCallback } from 'react'
import { Bot, Plus, Link2, Loader2, AlertTriangle, ExternalLink, Unlink, ChevronRight } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useAppStore } from '../../stores/app.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { api } from '../../api'
import { CHANNEL_LABELS } from './im-channel-labels'
import { WecomScanAuthDialog } from '../settings/WecomScanAuthDialog'
import { WeixinIlinkScanDialog } from '../settings/WeixinIlinkScanDialog'
import type { ImChannelInstanceStatus, ImChannelInstanceConfig, ImSessionRecord } from '../../../shared/types/im-channel'

function newInstanceId(): string {
  return `im-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

interface AppBotBindingSectionProps {
  appId: string
  appName: string
  /** Global apps cannot receive IM messages — inbound dispatch needs a space. */
  spaceId: string | null
}

export function AppBotBindingSection({ appId, appName, spaceId }: AppBotBindingSectionProps) {
  const { t } = useTranslation()
  const { navigate, refreshConfig } = useAppStore()
  const openBotSessions = useAppsPageStore(s => s.openBotSessions)

  const [instances, setInstances] = useState<ImChannelInstanceStatus[]>([])
  const [sessions, setSessions] = useState<ImSessionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showScan, setShowScan] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [showAddMenu, setShowAddMenu] = useState(false)
  // iLink writes its token onto an existing instance, so the instance is
  // created first and the QR dialog fills it in.
  const [ilinkInstanceId, setIlinkInstanceId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [statusRes, sessionsRes] = await Promise.all([
      api.imChannelsStatus(),
      api.imSessionsList(appId),
    ])
    if (statusRes.success && Array.isArray(statusRes.data)) {
      setInstances(statusRes.data as ImChannelInstanceStatus[])
    }
    if (sessionsRes.success && Array.isArray(sessionsRes.data)) {
      setSessions((sessionsRes.data as ImSessionRecord[]).filter(s => s.source === 'im'))
    }
    setLoading(false)
  }, [appId])

  useEffect(() => { void load() }, [load])

  const bound = instances.filter(i => i.appId === appId)
  const bindable = instances.filter(i => i.appId !== appId)

  const handleBind = useCallback(async (instanceId: string) => {
    setBusyId(instanceId)
    setError(null)
    const res = await api.imChannelsSetInstanceApp(instanceId, appId)
    if (!res.success) setError(res.error ?? t('Failed to bind'))
    setBusyId(null)
    setShowPicker(false)
    void load()
    void refreshConfig()
  }, [appId, load, refreshConfig, t])

  const handleUnbind = useCallback(async (instanceId: string) => {
    setBusyId(instanceId)
    setError(null)
    const res = await api.imChannelsUnbindInstance(instanceId)
    if (!res.success) setError(res.error ?? t('Failed to unbind'))
    setBusyId(null)
    void load()
    void refreshConfig()
  }, [load, refreshConfig, t])

  const handleScanComplete = useCallback(async (result: { botId: string; secret: string }) => {
    const instance: ImChannelInstanceConfig = {
      id: newInstanceId(),
      type: 'wecom-bot',
      enabled: true,
      appId,
      config: { botId: result.botId, secret: result.secret, wsUrl: '' },
      replyScope: 'all',
      // The scan protocol does not return the scanner's userid, so owner
      // auto-claim binds the first direct-message sender — same rationale as
      // the global scan path.
      permissionEnabled: true,
    }
    const res = await api.imChannelsCreateInstance(instance)
    if (!res.success) setError(res.error ?? t('Failed to bind'))
    void load()
    void refreshConfig()
  }, [appId, load, refreshConfig, t])

  const handleAddWechat = useCallback(async () => {
    setShowAddMenu(false)
    setError(null)
    const instance: ImChannelInstanceConfig = {
      id: newInstanceId(),
      type: 'weixin-ilink-bot',
      enabled: true,
      appId,
      config: { botToken: '', baseUrl: '', accountId: '' },
      replyScope: 'all',
    }
    const res = await api.imChannelsCreateInstance(instance)
    if (!res.success) {
      setError(res.error ?? t('Failed to bind'))
      return
    }
    setIlinkInstanceId(instance.id)
  }, [appId, t])

  if (!spaceId) return null

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Bot className="w-3.5 h-3.5" />
        {t('Bot Access')}
      </h3>
      <p className="text-xs text-muted-foreground">
        {t('Let people reach this digital human from an IM app. Messages sent to a bound bot are handled by it.')}
      </p>

      {error && (
        <div className="flex items-start gap-2 p-2.5 rounded-lg border border-halo-warning/[0.18] bg-halo-warning/[0.08]">
          <AlertTriangle className="w-3.5 h-3.5 text-halo-warning flex-shrink-0 mt-0.5" />
          <p className="text-xs text-foreground">{error}</p>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">{t('Loading...')}</p>
      ) : bound.length > 0 ? (
        <div className="rounded-lg border border-border/60 divide-y divide-border/60">
          {bound.map(instance => {
            const contactCount = sessions.filter(s => s.instanceId === instance.id).length
            return (
              <div key={instance.id} className="flex items-center gap-2.5 px-3 py-2">
                <button
                  onClick={() => openBotSessions(appId, instance.id)}
                  className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                >
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${instance.connected ? 'bg-halo-success' : 'bg-muted-foreground/30'}`} />
                  <span className="text-sm text-foreground truncate">
                    {CHANNEL_LABELS[instance.type] ?? instance.type}
                  </span>
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    {t('{{count}} contacts', { count: contactCount })}
                  </span>
                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                </button>
                <span className="text-xs text-muted-foreground flex-shrink-0">
                  {instance.connected ? t('Connected') : instance.reason || t('Not connected')}
                </span>
                <button
                  onClick={() => handleUnbind(instance.id)}
                  disabled={busyId !== null}
                  title={t('Unbind')}
                  className="p-1 text-muted-foreground hover:text-halo-warning rounded transition-colors disabled:opacity-50"
                >
                  {busyId === instance.id
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Unlink className="w-3.5 h-3.5" />}
                </button>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('No bot bound yet.')}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <div className="relative">
          <button
            onClick={() => { setError(null); setShowAddMenu(v => !v) }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-foreground border border-border rounded-lg hover:border-primary/60 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('Scan to add a bot')}
          </button>
          {showAddMenu && (
            <div className="absolute left-0 top-full mt-1 z-20 w-48 bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
              <button
                onClick={() => { setShowAddMenu(false); setShowScan(true) }}
                className="w-full px-3 py-2 text-left text-sm text-foreground hover:bg-secondary transition-colors"
              >
                {t('WeCom bot')}
              </button>
              <button
                onClick={handleAddWechat}
                className="w-full px-3 py-2 text-left text-sm text-foreground hover:bg-secondary transition-colors"
              >
                {t('WeChat bot')}
              </button>
            </div>
          )}
        </div>
        {bindable.length > 0 && (
          <button
            onClick={() => { setError(null); setShowPicker(v => !v) }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors"
          >
            <Link2 className="w-3.5 h-3.5" />
            {t('Bind an existing bot')}
          </button>
        )}
      </div>

      {showPicker && (
        <div className="rounded-lg border border-border divide-y divide-border">
          {bindable.map(instance => (
            <button
              key={instance.id}
              onClick={() => handleBind(instance.id)}
              disabled={busyId !== null}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-secondary/60 transition-colors disabled:opacity-60"
            >
              {busyId === instance.id
                ? <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground flex-shrink-0" />
                : <Bot className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
              <span className="text-sm text-foreground flex-1 min-w-0 truncate">
                {CHANNEL_LABELS[instance.type] ?? instance.type}
              </span>
              {instance.appName && (
                <span className="text-xs text-halo-warning flex-shrink-0">
                  {t('now bound to {{name}}', { name: instance.appName })}
                </span>
              )}
            </button>
          ))}
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {t('Rebinding reconnects the bot, and the digital human it currently serves stops receiving its messages.')}
          </p>
        </div>
      )}

      <button
        onClick={() => navigate('settings')}
        className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
      >
        {t('Bot connection settings')}
        <ExternalLink className="w-3 h-3" />
      </button>

      <WeixinIlinkScanDialog
        open={ilinkInstanceId !== null}
        instanceId={ilinkInstanceId ?? ''}
        onClose={() => { setIlinkInstanceId(null); void load(); void refreshConfig() }}
        onConnected={async () => { await load(); await refreshConfig() }}
      />

      <WecomScanAuthDialog
        open={showScan}
        onClose={() => { setShowScan(false); void load() }}
        targetAppId={appId}
        targetAppName={appName}
        onComplete={handleScanComplete}
      />
    </div>
  )
}
