/**
 * Message Channels Section Component (消息渠道)
 *
 * Unified settings section that merges:
 * - IM Channels (bidirectional, multi-instance: WeCom Bot, Feishu Bot, etc.)
 * - Notification Channels (one-way push: email, wecom app, dingtalk, feishu, webhook)
 *
 * IM Channels support multiple instances per provider type, each bound to
 * a specific digital human. Instances are rendered as an accordion list
 * inside the provider's card.
 *
 * IM Sessions are NOT shown here — they live in the digital human config.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Mail, MessageSquare, Bell, Webhook, Loader2,
  CheckCircle, XCircle, ChevronDown, RefreshCw, Bot,
  Plus, Trash2, MoreVertical, Smartphone, Info,
  QrCode,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { useAppsStore } from '../../stores/apps.store'
import type { HaloConfig } from '../../types'
import { NOTIFICATION_CHANNEL_META } from '../../../shared/types/notification-channels'
import type {
  NotificationChannelType,
  NotificationChannelsConfig,
} from '../../../shared/types/notification-channels'
import type {
  ImChannelInstanceConfig,
  ImChannelInstanceStatus,
  GuestPolicy,
} from '../../../shared/types/im-channel'
import { WeixinIlinkInstanceCard } from './WeixinIlinkInstanceCard'
import { WecomScanAuthDialog } from './WecomScanAuthDialog'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'

/** Product-level permission defaults (from IPC). Mirrors auth-loader.ImChannelsPermissionDefaults. */
interface PermissionDefaults {
  defaultEnabled?: boolean
  defaultGuestAccess?: boolean
  defaultGuestPolicy?: { allowedTools?: string[] }
  ownerIdHint?: string
}

// ============================================
// Types
// ============================================

interface MessageChannelsSectionProps {
  config: HaloConfig | null
  setConfig: (config: HaloConfig) => void
}

interface TestResult {
  success: boolean
  error?: string
}

/** Field descriptor for data-driven form rendering */
interface FieldDef {
  key: string
  label: string
  type: 'text' | 'password' | 'number' | 'toggle' | 'select'
  placeholder?: string
  required?: boolean
  options?: { value: string; label: string }[]
  nested?: string
  /** Optional group for collapsible sections (e.g. 'advanced') */
  group?: string
}

/** Notification channel descriptor */
interface NotifyChannelDef {
  id: string
  notifyType: NotificationChannelType
  icon: typeof Mail
  labelKey: string
  descriptionKey: string
  fields: FieldDef[]
  defaults: Record<string, unknown>
}

// ============================================
// Notification Channel Definitions
// ============================================

function buildNotifyChannelDefs(): NotifyChannelDef[] {
  return [
    {
      id: 'email',
      notifyType: 'email',
      icon: Mail,
      labelKey: NOTIFICATION_CHANNEL_META.email.labelKey,
      descriptionKey: NOTIFICATION_CHANNEL_META.email.descriptionKey,
      fields: [
        { key: 'smtp.host', label: 'SMTP Host', type: 'text', placeholder: 'smtp.gmail.com', required: true, nested: 'smtp.host' },
        { key: 'smtp.port', label: 'SMTP Port', type: 'number', placeholder: '465', required: true, nested: 'smtp.port' },
        { key: 'smtp.secure', label: 'Use SSL/TLS', type: 'toggle', nested: 'smtp.secure' },
        { key: 'smtp.user', label: 'Username', type: 'text', placeholder: 'user@example.com', required: true, nested: 'smtp.user' },
        { key: 'smtp.password', label: 'Password', type: 'password', placeholder: 'App password', required: true, nested: 'smtp.password' },
        { key: 'defaultTo', label: 'Default Recipient', type: 'text', placeholder: 'recipient@example.com', required: true },
        { key: 'caldavUrl', label: 'CalDAV URL', type: 'text', placeholder: 'https://{host}/dav/users/{email}/calendars/default/', group: 'advanced' },
        { key: 'tlsCiphers', label: 'TLS Ciphers', type: 'text', placeholder: 'Auto (system default)', group: 'advanced' },
      ],
      defaults: { enabled: false, smtp: { host: '', port: 465, secure: true, user: '', password: '' }, defaultTo: '' },
    },
    {
      id: 'wecom',
      notifyType: 'wecom',
      icon: MessageSquare,
      labelKey: NOTIFICATION_CHANNEL_META.wecom.labelKey,
      descriptionKey: NOTIFICATION_CHANNEL_META.wecom.descriptionKey,
      fields: [
        { key: 'corpId', label: 'Corp ID', type: 'text', placeholder: 'ww...', required: true },
        { key: 'agentId', label: 'Agent ID', type: 'number', placeholder: '1000002', required: true },
        { key: 'secret', label: 'Secret', type: 'password', required: true },
        { key: 'defaultToUser', label: 'Default User ID', type: 'text', placeholder: 'userid (optional)' },
        { key: 'defaultToParty', label: 'Default Party ID', type: 'text', placeholder: 'party id (optional)' },
      ],
      defaults: { enabled: false, corpId: '', agentId: 0, secret: '', defaultToUser: '', defaultToParty: '' },
    },
    {
      id: 'dingtalk',
      notifyType: 'dingtalk',
      icon: Bell,
      labelKey: NOTIFICATION_CHANNEL_META.dingtalk.labelKey,
      descriptionKey: NOTIFICATION_CHANNEL_META.dingtalk.descriptionKey,
      fields: [
        { key: 'appKey', label: 'App Key', type: 'text', required: true },
        { key: 'appSecret', label: 'App Secret', type: 'password', required: true },
        { key: 'agentId', label: 'Agent ID', type: 'number', placeholder: '0', required: true },
        { key: 'robotCode', label: 'Robot Code', type: 'text', placeholder: 'Robot code (optional)' },
        { key: 'defaultChatId', label: 'Default Chat ID', type: 'text', placeholder: 'Chat ID (optional)' },
      ],
      defaults: { enabled: false, appKey: '', appSecret: '', agentId: 0, robotCode: '', defaultChatId: '' },
    },
    {
      id: 'feishu',
      notifyType: 'feishu',
      icon: MessageSquare,
      labelKey: NOTIFICATION_CHANNEL_META.feishu.labelKey,
      descriptionKey: NOTIFICATION_CHANNEL_META.feishu.descriptionKey,
      fields: [
        { key: 'appId', label: 'App ID', type: 'text', required: true },
        { key: 'appSecret', label: 'App Secret', type: 'password', required: true },
        { key: 'defaultChatId', label: 'Default Chat ID', type: 'text', placeholder: 'Chat ID (optional)' },
        { key: 'defaultUserId', label: 'Default User ID', type: 'text', placeholder: 'User open_id (optional)' },
      ],
      defaults: { enabled: false, appId: '', appSecret: '', defaultChatId: '', defaultUserId: '' },
    },
    {
      id: 'webhook',
      notifyType: 'webhook',
      icon: Webhook,
      labelKey: NOTIFICATION_CHANNEL_META.webhook.labelKey,
      descriptionKey: NOTIFICATION_CHANNEL_META.webhook.descriptionKey,
      fields: [
        { key: 'url', label: 'URL', type: 'text', placeholder: 'https://example.com/webhook', required: true },
        {
          key: 'method', label: 'Method', type: 'select',
          options: [{ value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }],
        },
        { key: 'headers', label: 'Headers (JSON)', type: 'text', placeholder: '{"Authorization": "Bearer ..."}' },
        { key: 'secret', label: 'HMAC Secret', type: 'password', placeholder: 'Signing secret (optional)' },
      ],
      defaults: { enabled: false, url: '', method: 'POST', headers: undefined, secret: '' },
    },
  ]
}

const NOTIFY_CHANNEL_DEFS = buildNotifyChannelDefs()

// ============================================
// Helpers
// ============================================

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.')
  if (parts.length === 1) {
    return { ...obj, [parts[0]]: value }
  }
  const [head, ...rest] = parts
  const child = (obj[head] != null && typeof obj[head] === 'object') ? obj[head] as Record<string, unknown> : {}
  return { ...obj, [head]: setNestedValue(child, rest.join('.'), value) }
}

function generateId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function truncateId(id: string, len = 12): string {
  if (id.length <= len) return id
  return id.slice(0, len) + '...'
}

// ============================================
// Channel Field Renderer
// ============================================

interface ChannelFieldProps {
  field: FieldDef
  value: unknown
  onChange: (value: unknown) => void
}

function ChannelField({ field, value, onChange }: ChannelFieldProps) {
  const { t } = useTranslation()

  if (field.type === 'toggle') {
    const checked = Boolean(value)
    return (
      <div className="flex items-center justify-between">
        <label className="text-sm text-muted-foreground">{t(field.label)}</label>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
            <div
              className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                checked ? 'translate-x-5' : 'translate-x-0.5'
              } mt-0.5`}
            />
          </div>
        </label>
      </div>
    )
  }

  if (field.type === 'select') {
    return (
      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">{t(field.label)}</label>
        <select
          value={(value as string) || field.options?.[0]?.value || ''}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    )
  }

  const inputType = field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text'

  let displayValue: string
  if (field.key === 'headers' && typeof value === 'object' && value !== null) {
    displayValue = JSON.stringify(value)
  } else {
    displayValue = value != null ? String(value) : ''
  }

  const handleChange = (raw: string) => {
    if (field.type === 'number') {
      onChange(raw === '' ? 0 : Number(raw))
    } else if (field.key === 'headers') {
      onChange(raw === '' ? undefined : raw)
    } else {
      onChange(raw)
    }
  }

  const handleBlur = () => {
    if (field.key === 'headers' && typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value)
        onChange(parsed)
      } catch {
        // Keep as raw string
      }
    }
  }

  return (
    <div className="space-y-1">
      <label className="text-sm text-muted-foreground">
        {t(field.label)}
        {field.required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      <input
        type={inputType}
        value={displayValue}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        placeholder={field.placeholder ? t(field.placeholder) : undefined}
        className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </div>
  )
}

// ============================================
// IM Channel Instance Card (Sub-card)
// ============================================

interface InstanceCardProps {
  instance: ImChannelInstanceConfig
  status: ImChannelInstanceStatus | undefined
  automationApps: { id: string; spec: { name: string } }[]
  isExpanded: boolean
  onToggle: () => void
  onChange: (instance: ImChannelInstanceConfig) => void
  onDelete: () => void
  onReconnect: () => void
  /** Warning message when this instance's Bot ID conflicts with another instance */
  duplicateWarning?: string
  /** Product-level permission defaults */
  permissionDefaults?: PermissionDefaults | null
}

function InstanceCard({
  instance,
  status,
  automationApps,
  isExpanded,
  onToggle,
  onChange,
  onDelete,
  onReconnect,
  duplicateWarning,
  permissionDefaults,
}: InstanceCardProps) {
  const { t } = useTranslation()
  const isConnected = status?.connected ?? false
  const isEnabled = instance.enabled
  const cfg = instance.config as Record<string, unknown>
  const botId = (cfg.botId as string) || ''

  // Resolve bound app name
  const boundApp = automationApps.find(a => a.id === instance.appId)
  const displayName = boundApp?.spec.name || t('Not bound')

  // Status indicator
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

  // Debounced save for config fields.
  // pendingSaveRef always holds the most-recent unsaved value so we can
  // flush it synchronously on unmount (e.g. card collapsed within 500 ms).
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<ImChannelInstanceConfig | null>(null)
  // Keep a stable ref to onChange so the unmount cleanup can call it without
  // adding onChange to the flush effect's dependency array.
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

  // Flush any pending debounced save when the card unmounts (e.g. card
  // collapsed or parent component unmounts before the 500 ms timer fires).
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

  // Use local draft to avoid cursor jumping
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const currentCfg = draft ?? cfg

  const handleConfigChange = (key: string, value: unknown) => {
    const newCfg = { ...currentCfg, [key]: value }
    setDraft(newCfg)
    scheduleChange({ ...instance, config: newCfg })
  }

  const handleEnabledChange = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setDraft(null)
    onChange({ ...instance, enabled: !isEnabled })
  }

  const handleAppChange = (appId: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setDraft(null)
    onChange({ ...instance, appId })
  }

  const handleStreamingChange = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setDraft(null)
    // Streaming defaults to off (undefined). Toggle on → explicit true; toggle off → undefined.
    onChange({ ...instance, streaming: instance.streaming === true ? undefined : true })
  }

  const handleQuoteReplyChange = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setDraft(null)
    // quoteReply defaults to on (true). Toggle off → explicit false; toggle on → undefined (legacy default).
    const nextQuote = (cfg.quoteReply as boolean) === false ? undefined : false
    const nextConfig = { ...cfg, quoteReply: nextQuote }
    // Disabling Quote Reply also disables Streaming, since streaming in group
    // chats relies on the passive reply path that produces the quote bubble.
    let nextInstance = { ...instance, config: nextConfig }
    if (nextQuote === false && instance.streaming === true) {
      nextInstance = { ...nextInstance, streaming: undefined }
    }
    onChange(nextInstance)
  }

  const handleReplyScopeChange = (scope: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setDraft(null)
    onChange({ ...instance, replyScope: scope as ImChannelInstanceConfig['replyScope'] })
  }

  const isStreamingEnabled = instance.streaming === true
  const isQuoteReplyEnabled = (cfg.quoteReply as boolean) !== false
  const replyScope = instance.replyScope ?? 'all'

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
              Bot ID: {truncateId(botId) || t('Not set')}
              {!isEnabled ? '' : isConnected ? '' : ` · ${statusText}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Context menu. Popover renders the panel through a portal so it
              escapes this card's `overflow-hidden`, which previously clipped
              the dropdown. The wrapper stops clicks from toggling the header. */}
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
                  // Inline confirmation — avoids misclick on a destructive action
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
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={isEnabled}
                onChange={handleEnabledChange}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
                <div
                  className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                    isEnabled ? 'translate-x-5' : 'translate-x-0.5'
                  } mt-0.5`}
                />
              </div>
            </label>
          </div>

          {/* Config fields */}
          <div className="space-y-2.5">
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">
                Bot ID <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={(currentCfg.botId as string) ?? ''}
                onChange={(e) => handleConfigChange('botId', e.target.value)}
                placeholder="aib-xxx"
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
                Secret <span className="text-red-400">*</span>
              </label>
              <input
                type="password"
                value={(currentCfg.secret as string) ?? ''}
                onChange={(e) => handleConfigChange('secret', e.target.value)}
                className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">WebSocket URL</label>
              <input
                type="text"
                value={(currentCfg.wsUrl as string) ?? ''}
                onChange={(e) => handleConfigChange('wsUrl', e.target.value)}
                placeholder="wss://openws.work.weixin.qq.com"
                className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {/* Digital Human selector */}
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">
              {t('Digital Human')} <span className="text-red-400">*</span>
            </label>
            <div className="relative">
              <Bot className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <select
                value={instance.appId || ''}
                onChange={(e) => handleAppChange(e.target.value)}
                className="w-full bg-muted border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary appearance-none cursor-pointer"
              >
                <option value="">{t('Select digital human')}</option>
                {automationApps.map(app => (
                  <option key={app.id} value={app.id}>
                    {app.spec.name}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('All messages from this Bot will be handled by this digital human')}
            </p>
          </div>

          {/* Reply scope */}
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">{t('Reply Scope')}</label>
            <select
              value={replyScope}
              onChange={(e) => handleReplyScopeChange(e.target.value)}
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

          {/* Streaming toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-sm text-muted-foreground">{t('Streaming')}</p>
              <p className="text-xs text-muted-foreground/70">
                {isStreamingEnabled
                  ? t('Shows thinking process in real-time')
                  : t('Only sends the final reply')}
              </p>
              {!isQuoteReplyEnabled && (
                <p className="text-xs text-amber-500">
                  {t('Streaming requires Quote Reply (group chats)')}
                </p>
              )}
            </div>
            <label className={`relative inline-flex items-center ${!isQuoteReplyEnabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={isStreamingEnabled}
                onChange={handleStreamingChange}
                disabled={!isQuoteReplyEnabled}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
                <div
                  className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                    isStreamingEnabled ? 'translate-x-5' : 'translate-x-0.5'
                  } mt-0.5`}
                />
              </div>
            </label>
          </div>

          {/* Quote Reply toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-sm text-muted-foreground">{t('Quote Reply (Group)')}</p>
              <p className="text-xs text-muted-foreground/70">
                {isQuoteReplyEnabled
                  ? t('Group replies quote the original message')
                  : t('Group replies are sent as plain text without quote bubbles')}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={isQuoteReplyEnabled}
                onChange={handleQuoteReplyChange}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
                <div
                  className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                    isQuoteReplyEnabled ? 'translate-x-5' : 'translate-x-0.5'
                  } mt-0.5`}
                />
              </div>
            </label>
          </div>

          {/* ── Permission Control ── */}
          <PermissionSection instance={instance} onChange={onChange} onDebouncedChange={scheduleChange} permissionDefaults={permissionDefaults} />

          {/* Connection status */}
          {isEnabled && (
            <div className={`flex items-center gap-1.5 text-sm ${isConnected ? 'text-green-500' : 'text-amber-500'}`}>
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-amber-500'}`} />
              <span>{isConnected ? t('Connected') : t('Disconnected')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================
// Permission Section (permissionEnabled + owners + guestPolicy)
// ============================================

/**
 * Built-in tools that can be granted to guests.
 * All tools are off by default — owners choose which to enable.
 */
const GUEST_SAFE_BUILTIN_TOOLS = [
  { name: 'Read', group: 'file' },
  { name: 'Glob', group: 'file' },
  { name: 'Grep', group: 'file' },
  { name: 'WebFetch', group: 'network' },
  { name: 'WebSearch', group: 'network' },
  { name: 'Agent', group: 'other' },
  { name: 'TodoWrite', group: 'other' },
  { name: 'Bash', group: 'advanced' },
  { name: 'Write', group: 'advanced' },
  { name: 'Edit', group: 'advanced' },
  { name: 'NotebookEdit', group: 'advanced' },
] as const

/** Group labels for tool tags */
const TOOL_GROUP_LABELS: Record<string, string> = {
  file: 'File Read',
  network: 'Network',
  other: 'Other',
  advanced: 'Advanced',
}

/**
 * Halo MCP toggle definitions for the guest policy UI.
 * Replaces the old free-text mcp__ input.
 */
const HALO_MCP_TOGGLES: { key: keyof GuestPolicy; labelKey: string }[] = [
  { key: 'allowAiBrowser', labelKey: 'AI Browser' },
  { key: 'allowEmail',     labelKey: 'Email' },
  { key: 'allowNotify',    labelKey: 'Notifications' },
  { key: 'allowApps',      labelKey: 'Digital Humans' },
  { key: 'allowFileSend',  labelKey: 'File Send' },
]

interface PermissionSectionProps {
  instance: ImChannelInstanceConfig
  /** Immediate save (for toggles) */
  onChange: (instance: ImChannelInstanceConfig) => void
  /** Debounced save (for text fields — 500ms delay, same as config fields) */
  onDebouncedChange: (instance: ImChannelInstanceConfig) => void
  /** Product-level permission defaults (for owner ID hint, etc.) */
  permissionDefaults?: PermissionDefaults | null
}

function PermissionSection({ instance, onChange, onDebouncedChange, permissionDefaults }: PermissionSectionProps) {
  const { t } = useTranslation()
  const permissionEnabled = instance.permissionEnabled ?? false
  const owners = instance.owners ?? []
  const hasOwners = owners.length > 0
  const guestPolicy = instance.guestPolicy
  const guestAccessEnabled = hasOwners && guestPolicy !== undefined

  // Load installed MCP apps for the user MCP whitelist
  const { apps } = useAppsStore()
  const mcpApps = apps.filter(a => a.spec.type === 'mcp')

  // Local draft state for text fields (avoids cursor jumping during debounce)
  const [ownersDraft, setOwnersDraft] = useState<string | null>(null)

  // Derive display values
  const currentAllowedTools = guestPolicy?.allowedTools ?? []
  const builtinNames = new Set(GUEST_SAFE_BUILTIN_TOOLS.map(t => t.name))
  const selectedBuiltinTools = new Set(currentAllowedTools.filter(t => builtinNames.has(t)))

  const ownersDisplay = ownersDraft ?? owners.join(', ')

  // ── Handlers ──

  const handlePermissionToggle = () => {
    onChange({ ...instance, permissionEnabled: !permissionEnabled })
  }

  const handleOwnersChange = (value: string) => {
    setOwnersDraft(value)
    const parsed = value
      .split(/[,\n]/)
      .map(s => s.trim())
      .filter(Boolean)
    onDebouncedChange({
      ...instance,
      owners: parsed.length > 0 ? parsed : undefined,
    })
  }

  const handleOwnersBlur = () => {
    setOwnersDraft(null)
  }

  const handleGuestAccessToggle = () => {
    if (guestAccessEnabled) {
      onChange({ ...instance, guestPolicy: undefined })
    } else {
      onChange({ ...instance, guestPolicy: { allowedTools: [] } })
    }
  }

  const handleBuiltinToolToggle = (toolName: string) => {
    const newSet = new Set(selectedBuiltinTools)
    if (newSet.has(toolName)) {
      newSet.delete(toolName)
    } else {
      newSet.add(toolName)
    }
    onChange({ ...instance, guestPolicy: { ...guestPolicy, allowedTools: Array.from(newSet) } })
  }

  const handleMcpToggle = (key: keyof GuestPolicy) => {
    const current = guestPolicy?.[key] as boolean | undefined
    onChange({ ...instance, guestPolicy: { ...guestPolicy, [key]: !current } })
  }

  const handleUserMcpToggle = (specId: string) => {
    const current = guestPolicy?.allowedUserMcp ?? []
    const updated = current.includes(specId)
      ? current.filter(s => s !== specId)
      : [...current, specId]
    onChange({
      ...instance,
      guestPolicy: { ...guestPolicy, allowedUserMcp: updated.length > 0 ? updated : undefined },
    })
  }

  // ── Render ──

  return (
    <div className="space-y-2">
      {/* Master toggle */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-sm text-muted-foreground">{t('Permission Control')}</p>
          <p className="text-xs text-muted-foreground/70">
            {permissionEnabled
              ? t('Restrict access by owner/guest roles')
              : t('Everyone has full access')}
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={permissionEnabled}
            onChange={handlePermissionToggle}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
            <div
              className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                permissionEnabled ? 'translate-x-5' : 'translate-x-0.5'
              } mt-0.5`}
            />
          </div>
        </label>
      </div>

      {/* Permission details (only when enabled) */}
      {permissionEnabled && (
        <div className="space-y-3 pl-1 animate-in slide-in-from-top-1 duration-150">
          {/* Owners */}
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">
              {t('Owner User IDs')}
            </label>
            <textarea
              value={ownersDisplay}
              onChange={(e) => handleOwnersChange(e.target.value)}
              onBlur={handleOwnersBlur}
              placeholder={permissionDefaults?.ownerIdHint || t('Fill in your own user ID. Ask the bot "what is my user ID" to get it.')}
              rows={2}
              className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
            <p className="text-xs text-muted-foreground">
              {t('Owners always have full access and are not restricted by the guest settings below.')}
            </p>
          </div>

          {/* No owners yet — auto-claim is active, so this is an expected
              interim state rather than a misconfiguration. */}
          {!hasOwners && (
            <div className="flex items-center gap-2 rounded-lg bg-primary/10 border border-primary/30 px-3 py-2">
              <Info className="w-4 h-4 text-primary shrink-0" />
              <p className="text-xs text-foreground/80">
                {t('No owner bound yet. The first user to send this bot a direct message will be bound as the owner automatically. Until then, all users are deny-all guests.')}
              </p>
            </div>
          )}

          {/* Guest section divider — makes the owner/guest boundary visually explicit */}
          {hasOwners && (
            <div className="flex items-center gap-2 pt-1">
              <div className="flex-1 border-t border-border/60" />
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground/50 px-1">
                {t('Guest Permissions')}
              </span>
              <div className="flex-1 border-t border-border/60" />
            </div>
          )}

          {/* Guest access toggle (only when owners are set) */}
          {hasOwners && (
            <>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm text-muted-foreground">{t('Guest Access')}</p>
                  <p className="text-xs text-muted-foreground/70">
                    {guestAccessEnabled
                      ? t('Guests have limited access to selected tools below')
                      : t('Guests have no tool access — chat only')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={guestAccessEnabled}
                    onChange={handleGuestAccessToggle}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
                    <div
                      className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                        guestAccessEnabled ? 'translate-x-5' : 'translate-x-0.5'
                      } mt-0.5`}
                    />
                  </div>
                </label>
              </div>

              {/* Tool selection (only when guest access is enabled) */}
              {guestAccessEnabled && (
                <div className="space-y-2">
                  <label className="text-sm text-muted-foreground">
                    {t('Guest Allowed Tools')}
                  </label>

                  {/* Built-in tool tags grouped — unchanged from original */}
                  {Object.entries(TOOL_GROUP_LABELS).map(([group, label]) => {
                    const tools = GUEST_SAFE_BUILTIN_TOOLS.filter(t => t.group === group)
                    if (tools.length === 0) return null
                    return (
                      <div key={group} className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted-foreground/70 w-14 sm:w-16 shrink-0">
                          {t(label)}
                        </span>
                        {tools.map(tool => {
                          const isSelected = selectedBuiltinTools.has(tool.name)
                          return (
                            <button
                              key={tool.name}
                              type="button"
                              onClick={() => handleBuiltinToolToggle(tool.name)}
                              className={`px-2 py-0.5 text-xs rounded-md border transition-colors ${
                                isSelected
                                  ? 'bg-primary/15 text-primary border-primary/30'
                                  : 'bg-muted text-muted-foreground border-border hover:border-primary/20'
                              }`}
                            >
                              {tool.name}
                            </button>
                          )
                        })}
                      </div>
                    )
                  })}

                  {/* MCP capabilities — replaces old free-text mcp__ input */}
                  <div className="mt-2 pt-2 border-t border-border/40 space-y-3">
                    {/* Halo built-in MCP toggles */}
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground/70">
                        {t('Halo Capabilities')}
                      </label>
                      {HALO_MCP_TOGGLES.map(({ key, labelKey }) => {
                        const isOn = Boolean(guestPolicy?.[key])
                        return (
                          <div key={key} className="flex items-center justify-between">
                            <p className="text-sm text-muted-foreground">{t(labelKey)}</p>
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={isOn}
                                onChange={() => handleMcpToggle(key)}
                                className="sr-only peer"
                              />
                              <div className="w-9 h-5 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
                                <div
                                  className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform ${
                                    isOn ? 'translate-x-4' : 'translate-x-0.5'
                                  } mt-0.5`}
                                />
                              </div>
                            </label>
                          </div>
                        )
                      })}
                    </div>

                    {/* User-installed MCP servers (only shown when any are installed) */}
                    {mcpApps.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground/70">
                        {t('Installed MCP Servers')}
                      </label>
                      {mcpApps.map(app => {
                      const specId = app.specId
                      const isAllowed = guestPolicy?.allowedUserMcp?.includes(specId) ?? false
                      return (
                        <div key={specId} className="flex items-center justify-between">
                          <p className="text-sm text-muted-foreground">{app.spec.name}</p>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={isAllowed}
                              onChange={() => handleUserMcpToggle(specId)}
                              className="sr-only peer"
                            />
                            <div className="w-9 h-5 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
                              <div
                                className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform ${
                                  isAllowed ? 'translate-x-4' : 'translate-x-0.5'
                                } mt-0.5`}
                              />
                            </div>
                          </label>
                        </div>
                      )
                    })}
                  </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================
// Notification Channel Card
// ============================================

interface NotifyChannelCardProps {
  def: NotifyChannelDef
  channelConfig: Record<string, unknown>
  isExpanded: boolean
  onToggleExpand: () => void
  onSave: (def: NotifyChannelDef, config: Record<string, unknown>) => Promise<void>
  onTest: (channelType: string) => void
  isTesting: boolean
  testResult?: TestResult
}

function NotifyChannelCard({
  def,
  channelConfig,
  isExpanded,
  onToggleExpand,
  onSave,
  onTest,
  isTesting,
  testResult,
}: NotifyChannelCardProps) {
  const { t } = useTranslation()
  const Icon = def.icon
  const isEnabled = Boolean(channelConfig?.enabled)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentConfig = draft ?? channelConfig

  const scheduleSave = useCallback((updated: Record<string, unknown>) => {
    setDraft(updated)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      onSave(def, updated)
      setDraft(null)
      saveTimerRef.current = null
    }, 500)
  }, [def, onSave])

  const handleToggleEnabled = async () => {
    const updated = { ...currentConfig, enabled: !isEnabled }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setDraft(null)
    await onSave(def, updated)
  }

  const handleFieldChange = (fieldKey: string, value: unknown, nested?: string) => {
    const path = nested || fieldKey
    const updated = setNestedValue({ ...currentConfig }, path, value)
    scheduleSave(updated)
  }

  const getFieldValue = (field: FieldDef): unknown => {
    const path = field.nested || field.key
    return getNestedValue(currentConfig || {}, path)
  }

  const statusLabel = isEnabled ? t('Configured') : t('Not configured')
  const statusColor = isEnabled ? 'bg-green-500' : 'bg-muted-foreground/30'

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggleExpand}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Icon className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          <div className="text-left min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-medium text-sm">{t(def.labelKey)}</p>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-muted text-muted-foreground">
                {t('One-way')}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">{t(def.descriptionKey)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <span className="text-xs text-muted-foreground hidden sm:inline">{statusLabel}</span>
          <div className={`w-2 h-2 rounded-full ${statusColor}`} />
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 pt-2 border-t border-border space-y-4 animate-in slide-in-from-top-1 duration-150">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{t('Enabled')}</p>
              <p className="text-xs text-muted-foreground">{t('Enable this channel')}</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" checked={isEnabled} onChange={handleToggleEnabled} className="sr-only peer" />
              <div className="w-11 h-6 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
                <div className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${isEnabled ? 'translate-x-5' : 'translate-x-0.5'} mt-0.5`} />
              </div>
            </label>
          </div>

          <div className="space-y-3">
            {def.fields.filter(f => !f.group).map((field) => (
              <ChannelField
                key={field.key}
                field={field}
                value={getFieldValue(field)}
                onChange={(value) => handleFieldChange(field.key, value, field.nested)}
              />
            ))}
          </div>

          {/* Advanced fields (collapsible) */}
          {def.fields.some(f => f.group === 'advanced') && (
            <div className="border-t border-border/60 pt-3">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${showAdvanced ? 'rotate-180' : ''}`} />
                {t('Advanced')}
              </button>
              {showAdvanced && (
                <div className="mt-3 space-y-3 animate-in slide-in-from-top-1 duration-150">
                  {def.fields.filter(f => f.group === 'advanced').map((field) => (
                    <ChannelField
                      key={field.key}
                      field={field}
                      value={getFieldValue(field)}
                      onChange={(value) => handleFieldChange(field.key, value, field.nested)}
                    />
                  ))}
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {t('CalDAV URL enables calendar tools. Supports {host} and {email} placeholders.')}
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2 flex-wrap">
            <button
              type="button"
              onClick={() => onTest(def.notifyType)}
              disabled={isTesting || !isEnabled}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary/10 text-primary hover:bg-primary/20 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isTesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}
              {isTesting ? t('Testing...') : t('Test')}
            </button>
            {testResult && (
              <div className={`flex items-center gap-1.5 text-sm ${testResult.success ? 'text-green-500' : 'text-red-500'}`}>
                {testResult.success ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                <span>{testResult.success ? t('Test passed') : testResult.error || t('Test failed')}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================
// Main Component
// ============================================

export function MessageChannelsSection({ config, setConfig }: MessageChannelsSectionProps) {
  const { t } = useTranslation()

  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set())
  const [expandedInstances, setExpandedInstances] = useState<Set<string>>(new Set())
  const [testingChannel, setTestingChannel] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [imStatuses, setImStatuses] = useState<ImChannelInstanceStatus[]>([])
  const [permissionDefaults, setPermissionDefaults] = useState<PermissionDefaults | null>(null)
  const [scanDialogOpen, setScanDialogOpen] = useState(false)

  // Load automation apps for the digital human selector
  const { apps, loadApps } = useAppsStore()
  const automationApps = apps.filter(a => a.spec.type === 'automation')

  useEffect(() => { loadApps() }, [loadApps])

  // Load product-level permission defaults (once)
  useEffect(() => {
    api.imChannelsPermissionDefaults()
      .then((res: { success?: boolean; data?: PermissionDefaults | null }) => {
        if (res.success && res.data) setPermissionDefaults(res.data)
      })
      .catch(() => { /* defaults stay null — no restrictions */ })
  }, [])

  // Poll IM channel statuses
  useEffect(() => {
    let cancelled = false
    async function fetchStatuses() {
      try {
        const res = await api.imChannelsStatus() as { success: boolean; data?: ImChannelInstanceStatus[] }
        if (!cancelled && res.success && res.data) {
          setImStatuses(res.data)
        }
      } catch { /* ignore */ }
    }
    fetchStatuses()
    const interval = setInterval(fetchStatuses, 10_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  // Subscribe to main-initiated instance config updates (currently only used
  // by the IM owner auto-claim flow). When the first direct message binds its
  // sender as owner while this settings panel is open, the backend writes
  // owners=[userid] and broadcasts this event — we patch the local config so
  // the owner ID refreshes without requiring a manual reload. configRef
  // avoids re-subscribing on every config change.
  const configRef = useRef(config)
  useEffect(() => { configRef.current = config }, [config])
  useEffect(() => {
    const unsub = api.onImChannelInstanceUpdated?.((data: unknown) => {
      const update = data as { instanceId?: string; instance?: ImChannelInstanceConfig } | null
      if (!update?.instanceId || !update?.instance) return
      const current = configRef.current
      if (!current) return
      const list: ImChannelInstanceConfig[] = current.imChannels?.instances ?? []
      const idx = list.findIndex((i: ImChannelInstanceConfig) => i.id === update.instanceId)
      if (idx === -1) return
      const patched = list.slice()
      patched[idx] = update.instance
      setConfig({
        ...current,
        imChannels: { ...current.imChannels, instances: patched },
      } as HaloConfig)
    })
    return () => { unsub?.() }
  }, [setConfig])

  // ── IM Channel instances from config ────────────────────────────
  const instances = config?.imChannels?.instances ?? []

  const saveInstances = useCallback(async (newInstances: ImChannelInstanceConfig[]) => {
    if (!config) return
    const imChannels = { ...config.imChannels, instances: newInstances }
    try {
      await api.setConfig({ imChannels })
      setConfig({ ...config, imChannels } as HaloConfig)
      // Reload instances in the backend so new config takes effect
      api.imChannelsReload().catch(() => {})
    } catch (error) {
      console.error('[MessageChannelsSection] Failed to save IM instances:', error)
    }
  }, [config, setConfig])

  /**
   * Check if a given instance has a duplicate Bot ID among other enabled instances.
   * Returns a warning message if duplicate found, undefined otherwise.
   */
  const getDuplicateWarning = useCallback((instance: ImChannelInstanceConfig, allInstances: ImChannelInstanceConfig[]): string | undefined => {
    const botId = (instance.config.botId as string)?.trim()
    if (!botId || !instance.enabled) return undefined
    const duplicate = allInstances.find(
      other => other.id !== instance.id
        && other.type === instance.type
        && other.enabled
        && (other.config.botId as string)?.trim() === botId
    )
    if (duplicate) {
      return t('This Bot ID is already in use by another instance. Each Bot can only be bound to one digital human.')
    }
    return undefined
  }, [t])

  const handleInstanceChange = useCallback((updated: ImChannelInstanceConfig) => {
    const newInstances = instances.map(i => i.id === updated.id ? updated : i)
    saveInstances(newInstances)
  }, [instances, saveInstances])

  const handleAddInstance = useCallback(() => {
    // Apply product-level permission defaults for new instances
    const pd = permissionDefaults
    const newInstance: ImChannelInstanceConfig = {
      id: generateId(),
      type: 'wecom-bot',
      enabled: false,
      appId: '',
      config: { botId: '', secret: '', wsUrl: '' },
      replyScope: 'all', // Default to all messages
      permissionEnabled: pd?.defaultEnabled ?? false,
      ...(pd?.defaultEnabled ? {
        guestPolicy: pd.defaultGuestAccess
          ? { allowedTools: pd.defaultGuestPolicy?.allowedTools ?? [] }
          : undefined,
      } : {}),
    }
    const newInstances = [...instances, newInstance]
    saveInstances(newInstances)
    setExpandedInstances(prev => new Set(prev).add(newInstance.id))
  }, [instances, saveInstances, permissionDefaults])

  const handleDeleteInstance = useCallback((instanceId: string) => {
    const newInstances = instances.filter(i => i.id !== instanceId)
    saveInstances(newInstances)
  }, [instances, saveInstances])

  /**
   * Wire the freshly-scanned credentials into a new IM channel instance.
   *
   * The scan dialog has already installed a dedicated default automation app
   * via the create-assistant IPC; here we just append the corresponding
   * ImChannelInstanceConfig and persist. saveInstances() then triggers
   * imChannelsReload() which starts the WS connection.
   */
  const handleScanComplete = useCallback(async (result: {
    botId: string; secret: string; appId: string; appName: string
  }) => {
    // Scan-auth path: force permission control ON. The WeCom Intelligent Bot
    // scan protocol does not return the scanner's userid, so the generic
    // owner auto-claim binds the first direct-message sender as owner — no
    // manual userid lookup required. This intentionally overrides
    // product-level permissionDefaults, since scan-auth bots are by protocol
    // only visible to their creator (single-user personal use).
    const newInstance: ImChannelInstanceConfig = {
      id: generateId(),
      type: 'wecom-bot',
      enabled: true,
      appId: result.appId,
      config: { botId: result.botId, secret: result.secret, wsUrl: '' },
      replyScope: 'all',
      permissionEnabled: true,
    }
    await saveInstances([...instances, newInstance])
    // Refresh the apps list so the newly-installed assistant appears in the
    // digital-human selector inside the new instance card.
    loadApps().catch(() => {})
    // Ensure the WeCom card is expanded so the user immediately sees the
    // new instance after the dialog auto-closes.
    setExpandedChannels(prev => {
      const next = new Set(prev)
      next.add('im-wecom-bot')
      return next
    })
  }, [instances, saveInstances, loadApps])

  const handleReconnectInstance = useCallback(async (instanceId: string) => {
    try {
      await api.imChannelsReconnect(instanceId)
    } catch { /* ignore */ }
  }, [])

  // ── Notification channel handling ──────────────────────────────
  const toggleExpanded = useCallback((channelId: string) => {
    setExpandedChannels(prev => {
      const next = new Set(prev)
      if (next.has(channelId)) next.delete(channelId)
      else next.add(channelId)
      return next
    })
  }, [])

  const toggleInstanceExpanded = useCallback((instanceId: string) => {
    setExpandedInstances(prev => {
      const next = new Set(prev)
      if (next.has(instanceId)) next.delete(instanceId)
      else next.add(instanceId)
      return next
    })
  }, [])

  const handleSaveNotifyChannel = useCallback(async (def: NotifyChannelDef, channelConfig: Record<string, unknown>) => {
    if (!config) return
    const updatedConfig = {
      ...config,
      notificationChannels: {
        ...config.notificationChannels,
        [def.notifyType]: channelConfig,
      },
    } as HaloConfig
    try {
      await api.setConfig({ notificationChannels: updatedConfig.notificationChannels })
      setConfig(updatedConfig)
      api.clearNotificationChannelCache().catch(() => {})
    } catch (error) {
      console.error('[MessageChannelsSection] Failed to save channel config:', error)
    }
  }, [config, setConfig])

  const handleTestChannel = useCallback(async (channelType: string) => {
    setTestingChannel(channelType)
    setTestResults(prev => { const next = { ...prev }; delete next[channelType]; return next })
    try {
      const result = await api.testNotificationChannel(channelType) as { data: TestResult }
      setTestResults(prev => ({ ...prev, [channelType]: result.data }))
    } catch {
      setTestResults(prev => ({ ...prev, [channelType]: { success: false, error: t('Test failed') } }))
    } finally {
      setTestingChannel(null)
    }
  }, [t])

  const getNotifyConfig = (def: NotifyChannelDef): Record<string, unknown> => {
    const channels = config?.notificationChannels as NotificationChannelsConfig | undefined
    if (!channels) return {}
    const raw = channels[def.notifyType]
    return raw ? (raw as unknown as Record<string, unknown>) : {}
  }

  // Summary helpers for IM channel card headers
  const wecomInstances = (instances as ImChannelInstanceConfig[]).filter(i => i.type === 'wecom-bot')
  const weixinIlinkInstances = (instances as ImChannelInstanceConfig[]).filter(i => i.type === 'weixin-ilink-bot')

  const wecomConnectedCount = imStatuses.filter(s => s.type === 'wecom-bot' && s.connected).length
  const weixinConnectedCount = imStatuses.filter(s => s.type === 'weixin-ilink-bot' && s.connected).length

  const wecomStatusSummary = wecomInstances.length === 0
    ? t('Not configured')
    : wecomConnectedCount > 0
      ? `${wecomConnectedCount} ${t('connected')}`
      : t('Disconnected')

  const wecomStatusColor = wecomInstances.length === 0
    ? 'bg-muted-foreground/30'
    : wecomConnectedCount > 0
      ? 'bg-green-500'
      : 'bg-amber-500'

  const weixinStatusSummary = weixinIlinkInstances.length === 0
    ? t('Not configured')
    : weixinConnectedCount > 0
      ? `${weixinConnectedCount} ${t('connected')}`
      : t('Disconnected')

  const weixinStatusColor = weixinIlinkInstances.length === 0
    ? 'bg-muted-foreground/30'
    : weixinConnectedCount > 0
      ? 'bg-green-500'
      : 'bg-amber-500'

  const isImExpanded = expandedChannels.has('im-wecom-bot')
  const isWeixinExpanded = expandedChannels.has('im-weixin-ilink-bot')

  const handleAddWeixinInstance = useCallback(() => {
    const newInstance: ImChannelInstanceConfig = {
      id: generateId(),
      type: 'weixin-ilink-bot',
      enabled: false,
      appId: '',
      config: { botToken: '', baseUrl: '', accountId: '' },
    }
    const newInstances = [...instances, newInstance]
    saveInstances(newInstances)
    setExpandedInstances(prev => new Set(prev).add(newInstance.id))
  }, [instances, saveInstances])

  return (
    <section id="message-channels" className="bg-card rounded-xl border border-border p-4 sm:p-6">
      <div className="mb-4">
        <h2 className="text-lg font-medium">{t('Message Channels')}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('Configure channels for sending and receiving messages with digital humans')}
        </p>
      </div>

      <div className="space-y-3">
        {/* ── WeChat Personal Bot via iLink (multi-instance) ─────────── */}
        <div className="border border-border rounded-lg overflow-hidden">
          {/* Provider card header */}
          <button
            type="button"
            onClick={() => toggleExpanded('im-weixin-ilink-bot')}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0">
              <Smartphone className="w-5 h-5 text-muted-foreground flex-shrink-0" />
              <div className="text-left min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium text-sm">{t('WeChat Bot')}</p>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-primary/10 text-primary">
                    {t('Bidirectional')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">
                  {t('Bidirectional messaging via WeChat personal account (iLink)')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
              <span className="text-xs text-muted-foreground hidden sm:inline">{weixinStatusSummary}</span>
              <div className={`w-2 h-2 rounded-full ${weixinStatusColor}`} />
              <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${isWeixinExpanded ? 'rotate-180' : ''}`} />
            </div>
          </button>

          {/* Instance list */}
          {isWeixinExpanded && (
            <div className="px-4 pb-4 pt-2 border-t border-border space-y-2.5 animate-in slide-in-from-top-1 duration-150">
              {weixinIlinkInstances.length === 0 && (
                <p className="text-sm text-muted-foreground py-2 text-center">
                  {t('No Bot instances configured. Click the button below to add one.')}
                </p>
              )}

              {weixinIlinkInstances.map(inst => (
                <WeixinIlinkInstanceCard
                  key={inst.id}
                  instance={inst}
                  status={imStatuses.find(s => s.id === inst.id)}
                  automationApps={automationApps}
                  isExpanded={expandedInstances.has(inst.id)}
                  onToggle={() => toggleInstanceExpanded(inst.id)}
                  onChange={handleInstanceChange}
                  onDelete={() => handleDeleteInstance(inst.id)}
                />
              ))}

              {/* Add instance button */}
              <button
                type="button"
                onClick={handleAddWeixinInstance}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm border border-dashed border-border rounded-lg text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-muted/30 transition-colors"
              >
                <Plus className="w-4 h-4" />
                {t('Add Bot')}
              </button>
            </div>
          )}
        </div>

        {/* ── WeCom Intelligent Bot (multi-instance) ─────────────────── */}
        <div className="border border-border rounded-lg overflow-hidden">
          {/* Provider card header */}
          <button
            type="button"
            onClick={() => toggleExpanded('im-wecom-bot')}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0">
              <MessageSquare className="w-5 h-5 text-muted-foreground flex-shrink-0" />
              <div className="text-left min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium text-sm">{t('WeCom Intelligent Bot')}</p>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-primary/10 text-primary">
                    {t('Bidirectional')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">
                  {t('Bidirectional messaging via WeCom AI Bot WebSocket')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
              <span className="text-xs text-muted-foreground hidden sm:inline">{wecomStatusSummary}</span>
              <div className={`w-2 h-2 rounded-full ${wecomStatusColor}`} />
              <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${isImExpanded ? 'rotate-180' : ''}`} />
            </div>
          </button>

          {/* Instance list */}
          {isImExpanded && (
            <div className="px-4 pb-4 pt-2 border-t border-border space-y-2.5 animate-in slide-in-from-top-1 duration-150">
              {wecomInstances.length === 0 && (
                <p className="text-sm text-muted-foreground py-2 text-center">
                  {t('No Bot instances configured. Click the button below to add one.')}
                </p>
              )}

              {wecomInstances.map(inst => (
                <InstanceCard
                  key={inst.id}
                  instance={inst}
                  status={imStatuses.find(s => s.id === inst.id)}
                  automationApps={automationApps}
                  isExpanded={expandedInstances.has(inst.id)}
                  onToggle={() => toggleInstanceExpanded(inst.id)}
                  onChange={handleInstanceChange}
                  onDelete={() => handleDeleteInstance(inst.id)}
                  onReconnect={() => handleReconnectInstance(inst.id)}
                  duplicateWarning={getDuplicateWarning(inst, instances)}
                  permissionDefaults={permissionDefaults}
                />
              ))}

              {/* Add instance — scan QR (primary) + manual setup (secondary) */}
              <div className="flex flex-col sm:flex-row items-stretch gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setScanDialogOpen(true)}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium"
                >
                  <QrCode className="w-4 h-4" />
                  {t('Scan to add')}
                </button>
                <button
                  type="button"
                  onClick={handleAddInstance}
                  className="flex items-center justify-center gap-2 px-3 py-2 text-sm border border-border rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  {t('Manual setup')}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground text-center pt-0.5">
                {t('Recommended: scan to add — auto-creates a default digital human and binds it in one step.')}
              </p>
            </div>
          )}
        </div>

        {/* ── Notification channels (one-way) ───────────────────────── */}
        {NOTIFY_CHANNEL_DEFS.map((def) => (
          <NotifyChannelCard
            key={def.id}
            def={def}
            channelConfig={getNotifyConfig(def)}
            isExpanded={expandedChannels.has(def.id)}
            onToggleExpand={() => toggleExpanded(def.id)}
            onSave={handleSaveNotifyChannel}
            onTest={handleTestChannel}
            isTesting={testingChannel === def.notifyType}
            testResult={testResults[def.notifyType]}
          />
        ))}
      </div>

      {/* WeCom scan-to-add dialog (portal-style overlay) */}
      <WecomScanAuthDialog
        open={scanDialogOpen}
        onClose={() => setScanDialogOpen(false)}
        onComplete={handleScanComplete}
      />
    </section>
  )
}
