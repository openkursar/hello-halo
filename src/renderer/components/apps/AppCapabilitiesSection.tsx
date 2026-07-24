/**
 * AppCapabilitiesSection
 *
 * Built-in capabilities for an automation digital human, rendered as toggles.
 *
 * These map to Halo-native, always-present tool servers gated by per-app
 * permissions (resolvePermission): AI Browser, AI Terminal, Email, IM Push.
 * They are distinct from MCP dependencies (external, may be missing) — the
 * visual language here is a plain on/off switch, because the capability is
 * guaranteed to exist; the toggle only grants or denies it.
 *
 * Email and IM Push additionally depend on an external channel being
 * configured. The toggle still reflects intent (granted/denied), but an
 * amber hint links to Settings when the underlying channel is missing —
 * intent and availability are kept as separate concerns.
 *
 * A collapsed "always available" row surfaces the two capabilities that are
 * never toggleable (web search, memory) so the user sees the full picture
 * without adding noise to the default view.
 */

import { useState, useEffect } from 'react'
import {
  Globe, TerminalSquare, Mail, Send, AlertTriangle,
  ChevronRight, Search, Brain,
} from 'lucide-react'
import { api } from '../../api'
import { useAppsStore } from '../../stores/apps.store'
import { useAppStore } from '../../stores/app.store'
import { useTranslation } from '../../i18n'
import { resolvePermission } from '../../../shared/apps/app-types'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { Switch } from '../ui/Switch'

interface AppCapabilitiesSectionProps {
  app: InstalledApp
  appId: string
  /** Raised when a toggle changes a capability that only takes effect on a fresh session. */
  onRequireRestart: () => void
}

/** Jump to Settings > Message Channels and scroll it into view. */
function useGoToChannels() {
  const { setView } = useAppStore()
  return () => {
    setView('settings')
    setTimeout(() => {
      const el = document.getElementById('message-channels')
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 100)
  }
}

interface ToggleRowProps {
  icon: typeof Globe
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  dimmed?: boolean
  onToggle: (next: boolean) => void
}

function ToggleRow({ icon: Icon, label, description, checked, disabled, dimmed, onToggle }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Icon className={`w-3.5 h-3.5 ${dimmed ? 'text-muted-foreground/50' : 'text-muted-foreground'}`} />
          <span className={`text-sm ${dimmed ? 'text-muted-foreground' : 'text-foreground'}`}>{label}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onToggle} size="sm" />
    </div>
  )
}

export function AppCapabilitiesSection({ app, appId, onRequireRestart }: AppCapabilitiesSectionProps) {
  const { t } = useTranslation()
  const { grantPermission, revokePermission } = useAppsStore()
  const goToChannels = useGoToChannels()

  const [emailConfigured, setEmailConfigured] = useState(false)
  const [hasImInstances, setHasImInstances] = useState(false)
  const [alwaysExpanded, setAlwaysExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.getConfig().then((res: any) => {
      if (!cancelled && res.success && res.data) {
        setEmailConfigured(Boolean(res.data.notificationChannels?.email?.enabled))
      }
    }).catch(() => {})
    api.imChannelsStatus().then((res: any) => {
      if (!cancelled && res.success && Array.isArray(res.data)) {
        setHasImInstances(res.data.some((s: any) => s.enabled))
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // A capability change alters the tool set the running agent was created with,
  // so it only takes effect on a fresh session — surface the restart hint.
  async function setPermission(permission: string, next: boolean) {
    if (next) {
      await grantPermission(appId, permission)
    } else {
      await revokePermission(appId, permission)
    }
    onRequireRestart()
  }

  const aiBrowserOn = resolvePermission(app, 'ai-browser')
  const aiTerminalOn = resolvePermission(app, 'ai-terminal')
  const emailOn = resolvePermission(app, 'email')
  const imPushOn = resolvePermission(app, 'im-push')

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('Capabilities')}
      </h3>

      {/* AI Browser */}
      <ToggleRow
        icon={Globe}
        label={t('AI Browser')}
        description={t('Enable browser tools for web automation')}
        checked={aiBrowserOn}
        onToggle={next => setPermission('ai-browser', next)}
      />

      {/* AI Terminal */}
      <ToggleRow
        icon={TerminalSquare}
        label={t('AI Terminal')}
        description={t('Allow this app to run shell commands and interactive terminals')}
        checked={aiTerminalOn}
        onToggle={next => setPermission('ai-terminal', next)}
      />

      {/* Email */}
      <ToggleRow
        icon={Mail}
        label={t('Email')}
        description={t('Allow this app to read, send, and manage emails and calendar')}
        checked={emailOn}
        dimmed={!emailConfigured}
        onToggle={next => setPermission('email', next)}
      />
      {emailOn && !emailConfigured && (
        <button
          onClick={goToChannels}
          className="text-xs text-amber-500 flex items-center gap-1 -mt-2 hover:text-amber-400 transition-colors text-left"
        >
          <AlertTriangle className="w-3 h-3 flex-shrink-0" />
          {t('Enabled, but the email channel is not configured yet. Set it up in Settings > Message Channels.')}
        </button>
      )}

      {/* IM Push */}
      <ToggleRow
        icon={Send}
        label={t('IM Push')}
        description={t('Allow this app to send messages to IM contacts')}
        checked={imPushOn}
        dimmed={!hasImInstances}
        onToggle={next => setPermission('im-push', next)}
      />
      {imPushOn && !hasImInstances && (
        <button
          onClick={goToChannels}
          className="text-xs text-amber-500 flex items-center gap-1 -mt-2 hover:text-amber-400 transition-colors text-left"
        >
          <AlertTriangle className="w-3 h-3 flex-shrink-0" />
          {t('Enabled, but no IM channel is configured yet. Set it up in Settings.')}
        </button>
      )}

      {/* Always-available capabilities — collapsed by default to reduce noise */}
      <div>
        <button
          onClick={() => setAlwaysExpanded(v => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${alwaysExpanded ? 'rotate-90' : ''}`} />
          {t('Always available: web search, memory')}
        </button>
        {alwaysExpanded && (
          <div className="mt-2 pl-5 space-y-2">
            <div className="flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              <span className="text-sm text-foreground flex-1">{t('Web Search')}</span>
              <span className="text-xs text-muted-foreground/70">{t('Built-in · always on')}</span>
            </div>
            <p className="text-xs text-muted-foreground/70 pl-[22px] -mt-1">
              {t('Search the internet for real-time information')}
            </p>
            <div className="flex items-center gap-2">
              <Brain className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              <span className="text-sm text-foreground flex-1">{t('Memory')}</span>
              <span className="text-xs text-muted-foreground/70">{t('Built-in · always on')}</span>
            </div>
            <p className="text-xs text-muted-foreground/70 pl-[22px] -mt-1">
              {t('Persistent memory across runs (memory.md)')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
