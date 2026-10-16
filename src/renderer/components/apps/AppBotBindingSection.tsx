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

import { useState, useEffect, useCallback, useRef } from 'react'
import { Bot, Plus, Link2, Loader2, AlertTriangle, ExternalLink, Unlink, ChevronRight } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useAppStore } from '../../stores/app.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { api } from '../../api'
import { getImBotLabel } from './im-channel-labels'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { WecomScanAuthDialog } from '../settings/WecomScanAuthDialog'
import { WeixinIlinkScanDialog } from '../settings/WeixinIlinkScanDialog'
import { FeishuScanAuthDialog } from '../settings/FeishuScanAuthDialog'
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
  const { showConfirm, DialogComponent } = useConfirmDialog()
  const bindingBusy = useRef(false)

  const [instances, setInstances] = useState<ImChannelInstanceStatus[]>([])
  const [sessions, setSessions] = useState<ImSessionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showScan, setShowScan] = useState(false)
  const [showFeishuScan, setShowFeishuScan] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [showAddMenu, setShowAddMenu] = useState(false)
  // iLink writes its token onto an existing instance, so the instance is
  // created first and the QR dialog fills it in.
  const [ilinkInstanceId, setIlinkInstanceId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [statusRes, sessionsRes] = await Promise.all([
        api.imChannelsStatus(),
        api.imSessionsList(appId),
      ])
      if (!statusRes.success || !sessionsRes.success) {
        throw new Error(statusRes.error ?? sessionsRes.error ?? t('Failed to load bot connections'))
      }
      if (Array.isArray(statusRes.data)) {
        setInstances(statusRes.data as ImChannelInstanceStatus[])
      }
      if (Array.isArray(sessionsRes.data)) {
        setSessions((sessionsRes.data as ImSessionRecord[]).filter(s => s.source === 'im'))
      }
    } catch (error) {
      console.warn('[AppBotBindingSection] Bot connections could not be loaded', { appId, error })
      setError(t('Failed to load bot connections'))
    } finally {
      setLoading(false)
    }
  }, [appId, t])

  useEffect(() => { void load() }, [load])

  const bound = instances.filter(i => i.appId === appId)
  const bindable = instances.filter(i => i.appId !== appId)

  const handleBind = useCallback(async (instance: ImChannelInstanceStatus) => {
    if (bindingBusy.current) return
    bindingBusy.current = true
    setBusyId(instance.id)
    setError(null)
    try {
      if (instance.appId) {
        const confirmed = await showConfirm({
          title: t('Rebind this bot?'),
          message: t('Move {{bot}} from "{{from}}" to "{{to}}"? "{{from}}" will stop receiving new messages from this bot.', {
            bot: getImBotLabel(instance, t),
            from: instance.appName || t('Binding unavailable'),
            to: appName,
          }),
          confirmLabel: t('Rebind'),
          cancelLabel: t('Cancel'),
          variant: 'default',
        })
        if (!confirmed) return
      }
      const res = await api.imChannelsSetInstanceApp(instance.id, appId, instance.appId)
      if (!res.success) {
        if (res.code !== 'BINDING_CHANGED') {
          console.warn('[AppBotBindingSection] Bot binding was rejected', { instanceId: instance.id, appId, error: res.error })
        }
        setError(res.code === 'BINDING_CHANGED'
          ? t('The bot binding changed. Refresh and confirm again.')
          : res.error ?? t('Failed to bind'))
        await load()
        return
      }
      setShowPicker(false)
      await Promise.all([load(), refreshConfig()])
    } catch (error) {
      console.warn('[AppBotBindingSection] Bot binding failed', { instanceId: instance.id, appId, error })
      setError(t('Failed to bind'))
    } finally {
      bindingBusy.current = false
      setBusyId(null)
    }
  }, [appId, appName, showConfirm, load, refreshConfig, t])

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

  const handleFeishuScanComplete = useCallback(async (result: {
    appId: string
    appSecret: string
    tenantBrand: 'feishu' | 'lark'
  }) => {
    const instance: ImChannelInstanceConfig = {
      id: newInstanceId(),
      type: 'feishu-bot',
      enabled: true,
      appId,
      config: {
        appId: result.appId,
        appSecret: result.appSecret,
        domain: result.tenantBrand,
        requireMention: true,
        quoteReply: true,
      },
      replyScope: 'all',
      // The device flow returns the scanner's open_id, but not the id inbound
      // messages will carry, so owner auto-claim binds the first direct-message
      // sender — same rationale as the global scan path.
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
    <section aria-label={t('Bot Access')} className="space-y-2">
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
        <div className="rounded-lg border border-border-soft divide-y divide-border-soft">
          {bound.map(instance => {
            const contactCount = sessions.filter(s => s.instanceId === instance.id).length
            return (
              <div key={instance.id} className="flex items-center gap-2.5 px-3 py-2">
                <button
                  onClick={() => openBotSessions(appId, instance.id)}
                  className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                >
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${instance.connected ? 'bg-halo-success' : 'bg-muted-foreground/30'}`} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-foreground truncate">{getImBotLabel(instance, t)}</span>
                    <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                      <span>{t('{{count}} contacts', { count: contactCount })}</span>
                      <span className="break-words min-w-0">{instance.connected ? t('Connected') : instance.reason || t('Not connected')}</span>
                    </span>
                  </span>
                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                </button>
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
        <Popover
          open={showAddMenu}
          onOpenChange={(open) => {
            setShowAddMenu(open)
            if (open) { setError(null); setShowPicker(false) }
          }}
        >
          <PopoverTrigger className="items-center gap-1.5 px-3 py-1.5 text-sm text-foreground border border-border rounded-lg hover:border-primary/60 transition-colors">
            <Plus className="w-3.5 h-3.5" />
            {t('Scan to add a bot')}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-48 max-w-[calc(100vw-16px)] overflow-hidden">
            <button
              type="button"
              onClick={() => { setShowAddMenu(false); setShowScan(true) }}
              className="w-full px-3 py-2 text-left text-sm text-foreground hover:bg-secondary transition-colors"
            >
              {t('WeCom bot')}
            </button>
            <button
              type="button"
              onClick={() => { setShowAddMenu(false); setShowFeishuScan(true) }}
              className="w-full px-3 py-2 text-left text-sm text-foreground hover:bg-secondary transition-colors"
            >
              {t('Feishu bot')}
            </button>
            <button
              type="button"
              onClick={handleAddWechat}
              className="w-full px-3 py-2 text-left text-sm text-foreground hover:bg-secondary transition-colors"
            >
              {t('WeChat bot')}
            </button>
          </PopoverContent>
        </Popover>
        {bindable.length > 0 && (
          <button
            onClick={() => { setError(null); setShowAddMenu(false); setShowPicker(v => !v) }}
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
              onClick={() => { void handleBind(instance) }}
              disabled={busyId !== null}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-secondary/60 transition-colors disabled:opacity-60"
            >
              {busyId === instance.id
                ? <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground flex-shrink-0" />
                : <Bot className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
              <span className="flex-1 min-w-0 text-left">
                <span className="block text-sm text-foreground truncate">{getImBotLabel(instance, t)}</span>
                <span className={`block text-xs break-words ${instance.appId ? 'text-halo-warning' : 'text-muted-foreground'}`}>
                  {instance.appId
                    ? t('now bound to {{name}}', { name: instance.appName || t('Binding unavailable') })
                    : t('Not bound')}
                </span>
              </span>
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

      {DialogComponent}

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

      <FeishuScanAuthDialog
        open={showFeishuScan}
        onClose={() => { setShowFeishuScan(false); void load() }}
        targetAppId={appId}
        targetAppName={appName}
        onComplete={handleFeishuScanComplete}
      />
    </section>
  )
}
