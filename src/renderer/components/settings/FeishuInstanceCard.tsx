/**
 * Feishu Bot Instance Card
 *
 * Renders a single Feishu / Lark bot instance: credentials, deployment domain,
 * mention and quote behaviour, digital-human binding, reply scope, streaming,
 * and the shared owner/guest permission editor.
 *
 * Lives in its own file (like WeixinIlinkInstanceCard) so MessageChannelsSection
 * stays channel-list orchestration rather than per-provider detail.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Info, MoreVertical, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type {
  ImChannelInstanceConfig,
  ImChannelInstanceStatus,
} from '../../../shared/types/im-channel'
import { ChannelBackendSelect, ChannelBackendName } from './ChannelBackendSelect'
import type {
  ChannelBackendApp,
  ChannelBackendTeam,
  ChannelBackendValue,
} from './ChannelBackendSelect'
import { ImInstancePermissionSection } from './ImInstancePermissionSection'
import type { ImPermissionDefaults } from './ImInstancePermissionSection'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import { Switch } from '../ui/Switch'

export interface FeishuInstanceCardProps {
  instance: ImChannelInstanceConfig
  status: ImChannelInstanceStatus | undefined
  automationApps: ChannelBackendApp[]
  /** Teams whose members can back this channel (see ChannelBackendSelect). */
  teams: ChannelBackendTeam[]
  isExpanded: boolean
  onToggle: () => void
  onChange: (instance: ImChannelInstanceConfig) => void
  /** Rebinding goes through main so its validation applies to both binding surfaces. */
  onRebind: (appId: string) => void
  onDelete: () => void
  onReconnect: () => void
  /** Warning shown when this instance's App ID collides with another instance. */
  duplicateWarning?: string
  permissionDefaults?: ImPermissionDefaults | null
}

/** Shorten an App ID for the collapsed header. */
function truncateAppId(appId: string): string {
  if (appId.length <= 16) return appId
  return `${appId.slice(0, 14)}…`
}

export function FeishuInstanceCard({
  instance,
  status,
  automationApps,
  teams,
  isExpanded,
  onToggle,
  onChange,
  onRebind,
  onDelete,
  onReconnect,
  duplicateWarning,
  permissionDefaults,
}: FeishuInstanceCardProps) {
  const { t } = useTranslation()
  const state = status?.state ?? (status?.connected ? 'online' : 'offline')
  const isConnected = state === 'online'
  const isEnabled = instance.enabled
  const cfg = instance.config as Record<string, unknown>

  const statusDot = !isEnabled
    ? 'bg-muted-foreground/30'
    : isConnected
      ? 'bg-green-500'
      : 'bg-amber-500'

  const statusText = !isEnabled
    ? t('Disabled')
    : isConnected
      ? t('Connected')
      : t('Disconnected')

  const [showMenu, setShowMenu] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Debounced save for text fields. pendingSaveRef always holds the most-recent
  // unsaved value so it can be flushed synchronously on unmount (e.g. the card
  // is collapsed within the debounce window).
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<ImChannelInstanceConfig | null>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })

  const scheduleChange = useCallback((updated: ImChannelInstanceConfig) => {
    pendingSaveRef.current = updated
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      onChangeRef.current(updated)
      pendingSaveRef.current = null
      saveTimerRef.current = null
    }, 500)
  }, [])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null && pendingSaveRef.current !== null) {
        clearTimeout(saveTimerRef.current)
        onChangeRef.current(pendingSaveRef.current)
        saveTimerRef.current = null
        pendingSaveRef.current = null
      }
    }
  }, [])

  /**
   * Whether the bot has ever actually received a message.
   *
   * A Feishu app still awaiting release connects perfectly well and receives
   * nothing, so "connected" on its own is not a claim this card can honestly
   * make — it sends the user hunting for a fault that is not here.
   */
  const [reachability, setReachability] = useState<{
    connectedSinceMs: number | null
    lastInboundAgoMs: number | null
    inboundCount: number
  } | null>(null)

  useEffect(() => {
    if (!isExpanded || !isEnabled || !isConnected) {
      setReachability(null)
      return
    }
    let cancelled = false
    const read = async () => {
      try {
        const res = await api.feishuBotReachability(instance.id)
        if (!cancelled && res.success && res.data) setReachability(res.data)
      } catch { /* the card falls back to the plain connection state */ }
    }
    void read()
    const timer = setInterval(read, 15_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [isExpanded, isEnabled, isConnected, instance.id])

  // Long enough that a bot which simply has not been messaged yet is not
  // flagged the moment it connects, short enough to catch the real case.
  const silentSinceConnect =
    reachability !== null
    && reachability.inboundCount === 0
    && (reachability.connectedSinceMs ?? 0) > 60_000

  // Local draft avoids cursor jumping while the debounce is pending.
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const currentCfg = draft ?? cfg

  const handleConfigChange = (key: string, value: unknown) => {
    const newCfg = { ...currentCfg, [key]: value }
    setDraft(newCfg)
    scheduleChange({ ...instance, config: newCfg })
  }

  /** Immediate save for toggles/selects — no debounce, and drop any draft. */
  const commit = (updated: ImChannelInstanceConfig) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setDraft(null)
    onChange(updated)
  }

  const handleTargetChange = (target: ChannelBackendValue) => {
    // Same split as the other cards: a digital-human target goes through main's
    // rebind validation; a team target has no validator yet.
    if (target.teamId) commit({ ...instance, ...target })
    else {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      setDraft(null)
      onRebind(target.appId)
    }
  }

  const isStreamingEnabled = instance.streaming === true
  const requireMention = (currentCfg.requireMention as boolean) !== false
  const quoteReply = (currentCfg.quoteReply as boolean) !== false
  const domain = (currentCfg.domain as string) === 'lark' ? 'lark' : 'feishu'
  const replyScope = instance.replyScope ?? 'all'
  const appId = (currentCfg.appId as string) || ''

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
            <p className="text-sm font-medium truncate">
              <ChannelBackendName value={instance} automationApps={automationApps} teams={teams} />
            </p>
            <p className="text-[11px] text-muted-foreground truncate">
              {truncateAppId(appId) || t('Not set')}
              {!isEnabled ? '' : isConnected ? '' : ` · ${statusText}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Context menu. The wrapper stops clicks from toggling the header. */}
          <div onClick={(e) => e.stopPropagation()}>
            <Popover
              open={showMenu}
              onOpenChange={(open) => {
                setShowMenu(open)
                if (!open) setShowDeleteConfirm(false)
              }}
            >
              <PopoverTrigger className="p-1 rounded hover:bg-muted transition-colors">
                <MoreVertical className="w-3.5 h-3.5 text-muted-foreground" />
              </PopoverTrigger>
              <PopoverContent align="end" className="min-w-[140px] py-1">
                <button
                  type="button"
                  onClick={() => { setShowMenu(false); onReconnect() }}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
                  disabled={!isEnabled}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t('Reconnect')}
                </button>
                {showDeleteConfirm ? (
                  <div className="px-3 py-2 space-y-1.5">
                    <p className="text-xs text-muted-foreground">{t('Delete this instance?')}</p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => { setShowMenu(false); setShowDeleteConfirm(false); onDelete() }}
                        className="flex-1 px-2 py-1 text-xs rounded bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                      >
                        {t('Confirm')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowDeleteConfirm(false)}
                        className="flex-1 px-2 py-1 text-xs rounded hover:bg-muted text-muted-foreground transition-colors"
                      >
                        {t('Cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(true)}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted text-destructive transition-colors flex items-center gap-2"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('Delete')}
                  </button>
                )}
              </PopoverContent>
            </Popover>
          </div>
          <ChevronDown
            className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
          />
        </div>
      </button>

      {/* Instance body */}
      {isExpanded && (
        <div className="px-3 pb-3 pt-2 border-t border-border/60 space-y-3 animate-in slide-in-from-top-1 duration-150">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{t('Enabled')}</p>
            <Switch
              checked={isEnabled}
              onCheckedChange={() => commit({ ...instance, enabled: !isEnabled })}
            />
          </div>

          {/* Credentials */}
          <div className="space-y-2.5">
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">
                {t('App ID')} <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={appId}
                onChange={(e) => handleConfigChange('appId', e.target.value)}
                placeholder="cli_xxxxxxxxxxxxxxxx"
                className={`w-full bg-muted border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary ${
                  duplicateWarning ? 'border-amber-500' : 'border-border'
                }`}
              />
              {duplicateWarning && (
                <p className="text-xs text-amber-500">{duplicateWarning}</p>
              )}
            </div>
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">
                {t('App Secret')} <span className="text-red-400">*</span>
              </label>
              <input
                type="password"
                value={(currentCfg.appSecret as string) ?? ''}
                onChange={(e) => handleConfigChange('appSecret', e.target.value)}
                className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t('Deployment')}</label>
              <select
                value={domain}
                onChange={(e) => commit({
                  ...instance,
                  config: { ...currentCfg, domain: e.target.value },
                })}
                className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary appearance-none cursor-pointer"
              >
                <option value="feishu">{t('Feishu (China)')}</option>
                <option value="lark">{t('Lark (International)')}</option>
              </select>
            </div>
          </div>

          <ChannelBackendSelect
            value={instance}
            automationApps={automationApps}
            teams={teams}
            onChange={handleTargetChange}
          />

          {/* Reply scope */}
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">{t('Reply Scope')}</label>
            <select
              value={replyScope}
              onChange={(e) => commit({
                ...instance,
                replyScope: e.target.value as ImChannelInstanceConfig['replyScope'],
              })}
              className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary appearance-none cursor-pointer"
            >
              <option value="all">{t('All messages')}</option>
              <option value="group">{t('Group chats only')}</option>
              <option value="direct">{t('Direct messages only')}</option>
            </select>
            {replyScope === 'all' && (
              <p className="text-xs text-muted-foreground">
                {t('Enabling direct messages allows any user to interact with this digital human privately')}
              </p>
            )}
            {replyScope === 'group' && (
              <p className="text-xs text-muted-foreground">
                {t('Private messages will be rejected for security')}
              </p>
            )}
          </div>

          {/* Require @mention in group chats */}
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5 min-w-0">
              <p className="text-sm text-muted-foreground">{t('Require @mention in groups')}</p>
              <p className="text-xs text-muted-foreground/70">
                {requireMention
                  ? t('Only answers group messages that @ the bot')
                  : t('Answers every group message it receives')}
              </p>
              {!requireMention && (
                <p className="text-xs text-amber-500">
                  {t('Feishu only delivers un-mentioned group messages if your tenant granted the sensitive "all group messages" permission.')}
                </p>
              )}
            </div>
            <Switch
              checked={requireMention}
              onCheckedChange={() => commit({
                ...instance,
                config: { ...currentCfg, requireMention: !requireMention },
              })}
            />
          </div>

          {/* Quote reply in group chats */}
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5 min-w-0">
              <p className="text-sm text-muted-foreground">{t('Quote Reply (Group)')}</p>
              <p className="text-xs text-muted-foreground/70">
                {quoteReply
                  ? t('Group replies quote the original message')
                  : t('Group replies are sent as plain messages')}
              </p>
            </div>
            <Switch
              checked={quoteReply}
              onCheckedChange={() => commit({
                ...instance,
                config: { ...currentCfg, quoteReply: !quoteReply },
              })}
            />
          </div>

          {/* Streaming */}
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5 min-w-0">
              <p className="text-sm text-muted-foreground">{t('Streaming')}</p>
              <p className="text-xs text-muted-foreground/70">
                {isStreamingEnabled
                  ? t('Shows progress live in a Feishu card, replaced by the final answer')
                  : t('Only sends the final reply')}
              </p>
            </div>
            <Switch
              checked={isStreamingEnabled}
              onCheckedChange={() => commit({
                ...instance,
                streaming: isStreamingEnabled ? undefined : true,
              })}
            />
          </div>

          {/* ── Permission Control ── */}
          <ImInstancePermissionSection
            instance={instance}
            onChange={onChange}
            onDebouncedChange={scheduleChange}
            permissionDefaults={permissionDefaults}
          />

          {/* Connection status */}
          {isEnabled && (
            <div className={`flex items-center gap-1.5 text-sm ${isConnected ? 'text-green-500' : 'text-amber-500'}`}>
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-amber-500'}`} />
              <span>
                {!isConnected
                  ? t('Disconnected')
                  : silentSinceConnect
                    ? t('Connected · no messages received yet')
                    : t('Connected')}
              </span>
            </div>
          )}

          {isEnabled && silentSinceConnect && (
            <div className="flex items-start gap-2 rounded-lg bg-primary/10 border border-primary/30 px-3 py-2">
              <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-xs text-foreground/80 leading-relaxed">
                  {t('The link is up, but nothing has arrived. If the Feishu app is still waiting for administrator approval, or the person messaging it is outside its availability scope, the bot connects normally and still receives nothing.')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('Send it a direct message in Feishu to check — this note disappears as soon as one arrives.')}
                </p>
              </div>
            </div>
          )}
          {isEnabled && !isConnected && status?.reason && (
            <p className="text-xs text-amber-500 break-words">{status.reason}</p>
          )}
        </div>
      )}
    </div>
  )
}
