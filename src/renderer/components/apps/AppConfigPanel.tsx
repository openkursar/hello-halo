/**
 * AppConfigPanel
 *
 * Right-panel detail view for editing an automation App's configuration.
 *
 * Two tabs:
 *   - Settings: editable spec fields (name, description, system_prompt),
 *     dynamic config form (config_schema), and frequency selector.
 *   - YAML: full CodeMirror editor for the complete spec — editing power
 *     matches the MCP update_automation_app tool.
 *
 * Design: consistent with McpStatusCard/SkillInfoCard — section headers,
 * bg-secondary inputs, same spacing/typography scale.
 */

import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import { Save, RotateCcw, Unplug, Loader2, FileCode, Settings, Code, AlertTriangle, Globe, Bell, Download, ExternalLink, FolderOpen, Wrench, Send, Trash2, Mail, HelpCircle, RefreshCw, X } from 'lucide-react'
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml'
import { useAppsStore } from '../../stores/apps.store'
import { useAppStore } from '../../stores/app.store'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import type { InputDef, SubscriptionDef, AppSpec } from '../../../shared/apps/spec-types'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { resolvePermission } from '../../../shared/apps/app-types'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { api } from '../../api'
import { useSpaceStore } from '../../stores/space.store'
import { AppModelSelector } from './AppModelSelector'
import { AppNotifyChannelsSection } from './AppNotifyChannelsSection'
import { appTypeLabel } from './appTypeUtils'
import { SystemPromptEditor } from './SystemPromptEditor'
import { Switch } from '../ui/Switch'
import { SchedulePicker } from './SchedulePicker'
import {
  extractScheduleValue,
  applyScheduleValue,
  type ScheduleValue,
} from './schedule-utils'

// Lazy-load CodeMirrorEditor to keep initial bundle small
const CodeMirrorEditor = lazy(() =>
  import('../canvas/viewers/CodeMirrorEditor').then(m => ({ default: m.CodeMirrorEditor }))
)

// ============================================
// Types
// ============================================

type ConfigTab = 'settings' | 'yaml'

// ============================================
// Helpers
// ============================================

/** Serialize an AppSpec to clean YAML, stripping undefined/null fields */
function specToYaml(spec: AppSpec): string {
  // Create a clean copy without undefined values for nice YAML output
  const clean = JSON.parse(JSON.stringify(spec))
  return stringifyYaml(clean, { lineWidth: 0 })
}

// ============================================
// Config Field Renderer
// ============================================

interface ConfigFieldProps {
  def: InputDef
  value: unknown
  onChange: (key: string, value: unknown) => void
  t: (s: string, opts?: Record<string, unknown>) => string
}

function ConfigField({ def, value, onChange, t }: ConfigFieldProps) {
  const id = `config-${def.key}`

  // Resolve current value (user-provided > default > empty)
  const currentValue = value ?? def.default ?? ''

  switch (def.type) {
    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <label htmlFor={id} className="text-sm text-foreground">{def.label}</label>
            {def.description && (
              <p className="text-xs text-muted-foreground mt-0.5">{def.description}</p>
            )}
          </div>
          <Switch
            checked={!!currentValue}
            onCheckedChange={checked => onChange(def.key, checked)}
            size="sm"
          />
        </div>
      )

    case 'select':
      return (
        <div className="space-y-1.5">
          <label htmlFor={id} className="text-sm text-foreground">{def.label}</label>
          {def.description && (
            <p className="text-xs text-muted-foreground">{def.description}</p>
          )}
          <select
            id={id}
            value={String(currentValue)}
            onChange={e => onChange(def.key, e.target.value)}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
          >
            <option value="">{t('Select...')}</option>
            {(def.options ?? []).map(opt => (
              <option key={String(opt.value)} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )

    case 'number':
      return (
        <div className="space-y-1.5">
          <label htmlFor={id} className="text-sm text-foreground">{def.label}</label>
          {def.description && (
            <p className="text-xs text-muted-foreground">{def.description}</p>
          )}
          <input
            id={id}
            type="number"
            value={currentValue === '' ? '' : Number(currentValue)}
            placeholder={def.placeholder}
            onChange={e => onChange(def.key, e.target.value === '' ? undefined : Number(e.target.value))}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
      )

    case 'text':
      return (
        <div className="space-y-1.5">
          <label htmlFor={id} className="text-sm text-foreground">{def.label}</label>
          {def.description && (
            <p className="text-xs text-muted-foreground">{def.description}</p>
          )}
          <textarea
            id={id}
            value={String(currentValue)}
            placeholder={def.placeholder}
            rows={3}
            onChange={e => onChange(def.key, e.target.value)}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg resize-none focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
      )

    // url, string, email — all text inputs with different types
    default:
      return (
        <div className="space-y-1.5">
          <label htmlFor={id} className="text-sm text-foreground">{def.label}</label>
          {def.description && (
            <p className="text-xs text-muted-foreground">{def.description}</p>
          )}
          <input
            id={id}
            type={def.type === 'email' ? 'email' : def.type === 'url' ? 'url' : 'text'}
            value={String(currentValue)}
            placeholder={def.placeholder}
            onChange={e => onChange(def.key, e.target.value)}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
      )
  }
}

// ============================================
// InfoTip — small hover tooltip for label explanations
// ============================================

function InfoTip({ text }: { text: string }) {
  const [show, setShow] = useState(false)
  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <HelpCircle className="w-3 h-3 text-muted-foreground/50 hover:text-muted-foreground cursor-default transition-colors" />
      {show && (
        <span className="absolute left-4 top-1/2 -translate-y-1/2 z-50 w-52 px-2.5 py-1.5 rounded-md bg-popover border border-border text-[11px] text-muted-foreground shadow-md leading-relaxed whitespace-normal">
          {text}
        </span>
      )}
    </span>
  )
}

// ============================================
// Upgrade Section
//
// Upgrade strategy dropdown + on-demand upgrade check. Publish/export live
// in ShareCurrentAppDialog behind the detail-page Share icon.
// ============================================

interface UpgradeSectionProps {
  app: InstalledApp
  appId: string
  t: (s: string, opts?: Record<string, unknown>) => string
}

function UpgradeSection({ app, appId, t }: UpgradeSectionProps) {
  type Strategy = 'auto' | 'notify' | 'manual'
  const currentStrategy = (app.upgradeStrategy ?? 'auto') as Strategy
  const [strategy, setStrategy] = useState<Strategy>(currentStrategy)
  const [savingStrategy, setSavingStrategy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    setStrategy(currentStrategy)
  }, [currentStrategy])

  async function handleStrategyChange(next: Strategy) {
    setStrategy(next)
    setSavingStrategy(true)
    try {
      const res = await api.appSetUpgradeStrategy(appId, next)
      if (!res.success) {
        setFeedback({ kind: 'error', text: t('Failed to update upgrade strategy: {{error}}', { error: res.error ?? '' }) })
      } else {
        // Refresh the app in the store so the new strategy is visible
        await useAppsStore.getState().loadApps()
      }
    } catch (err) {
      setFeedback({ kind: 'error', text: t('Failed to update upgrade strategy: {{error}}', { error: (err as Error).message }) })
    } finally {
      setSavingStrategy(false)
    }
  }

  async function handleCheckUpgrades() {
    setChecking(true)
    setFeedback(null)
    try {
      const res = await api.storeCheckUpdatesNow()
      if (res.success) {
        setFeedback({ kind: 'success', text: t('Upgrade check complete.') })
      } else {
        setFeedback({ kind: 'error', text: res.error ?? t('Check failed.') })
      }
    } catch (err) {
      setFeedback({ kind: 'error', text: (err as Error).message })
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <RefreshCw className="w-3.5 h-3.5" />
        {t('Upgrades')}
      </h3>
      <div className="bg-secondary rounded-lg p-3 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <label htmlFor="upgrade-strategy" className="text-sm text-foreground sm:w-40 flex-shrink-0">
            {t('Upgrade strategy')}
          </label>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <select
              id="upgrade-strategy"
              value={strategy}
              disabled={savingStrategy}
              onChange={(e) => handleStrategyChange(e.target.value as Strategy)}
              className="w-full sm:w-auto px-2 py-1.5 text-sm bg-background text-foreground border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="auto">{t('Auto (silent patch/minor)')}</option>
              <option value="notify">{t('Notify only')}</option>
              <option value="manual">{t('Manual')}</option>
            </select>
            {savingStrategy && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {strategy === 'auto'
            ? t('Patch and minor versions install automatically. Major upgrades will ask first.')
            : strategy === 'notify'
              ? t('You will be notified for every available upgrade — nothing installs silently.')
              : t('No automatic upgrade checks. Use Check for upgrades to update on demand.')}
        </p>

        <div className="flex flex-col sm:flex-row gap-2 pt-1 border-t border-border">
          <button
            type="button"
            onClick={handleCheckUpgrades}
            disabled={checking}
            className="flex items-center justify-center gap-1.5 w-full sm:w-auto px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors disabled:opacity-40"
            title={t('Run an immediate upgrade check')}
          >
            {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {t('Check for upgrades')}
          </button>
        </div>

        {feedback && (
          <p className={`text-xs ${feedback.kind === 'success' ? 'text-green-500' : 'text-red-400'}`}>
            {feedback.text}
          </p>
        )}
      </div>
    </div>
  )
}

// ============================================
// Settings Tab Content
// ============================================

interface SettingsTabProps {
  app: InstalledApp
  appId: string
  spaceName?: string
  t: (s: string, opts?: Record<string, unknown>) => string
  /**
   * Invoked when a save changes a field that requires the running agent
   * to be restarted to take effect (system_prompt, user config values).
   * Parent owns the hint visibility so the banner persists across tab switches.
   */
  onRequireRestart: () => void
}

function SettingsTab({ app, appId, spaceName, t, onRequireRestart }: SettingsTabProps) {
  const { updateAppConfig, updateAppSpec, updateAppOverrides, grantPermission, revokePermission } = useAppsStore()
  const { setView } = useAppStore()

  // Check if email notification channel is configured
  const [emailConfigured, setEmailConfigured] = useState(false)
  // Check if any IM channel instances are enabled (for im-push toggle gating)
  const [hasImInstances, setHasImInstances] = useState(false)
  useEffect(() => {
    api.getConfig().then((res: any) => {
      if (res.success && res.data) {
        setEmailConfigured(Boolean(res.data.notificationChannels?.email?.enabled))
      }
    }).catch(() => {})
    api.imChannelsStatus().then((res: any) => {
      if (res.success && res.data) {
        setHasImInstances(res.data.some((s: any) => s.enabled))
      }
    }).catch(() => {})
  }, [])

  // Type-narrowed helpers for automation-specific fields
  const isAutomation = app.spec.type === 'automation'
  const specSystemPromptValue = isAutomation ? app.spec.system_prompt : ''
  const specSubscriptions = isAutomation ? (app.spec.subscriptions ?? []) : []
  const specRecommendedModel = isAutomation ? app.spec.recommended_model : undefined
  // ── Spec fields (name, description, system_prompt) ──
  const [specName, setSpecName] = useState(app.spec.name)
  const [specDescription, setSpecDescription] = useState(app.spec.description)
  const [specSystemPrompt, setSpecSystemPrompt] = useState(specSystemPromptValue)
  const [specSaving, setSpecSaving] = useState(false)
  const [specSaveSuccess, setSpecSaveSuccess] = useState(false)
  const [specError, setSpecError] = useState<string | null>(null)

  // ── Data path (for developer section) ──
  const [dataPath, setDataPath] = useState<string | null>(null)

  useEffect(() => {
    api.appGetDataPath(appId).then(res => {
      if (res.success && res.data) {
        setDataPath((res.data as { path: string }).path)
      }
    })
  }, [appId])

  // ── User config form ──
  const [formValues, setFormValues] = useState<Record<string, unknown>>({})
  const [configSaving, setConfigSaving] = useState(false)
  const [configSaveSuccess, setConfigSaveSuccess] = useState(false)

  // Sync from app data
  useEffect(() => {
    setSpecName(app.spec.name)
    setSpecDescription(app.spec.description)
    setSpecSystemPrompt(specSystemPromptValue)
    setSpecSaveSuccess(false)
    setSpecError(null)
    setFormValues({ ...app.userConfig })
    setConfigSaveSuccess(false)
  }, [app.id, app.spec.name, app.spec.description, specSystemPromptValue, app.userConfig])

  const handleFieldChange = useCallback((key: string, value: unknown) => {
    setFormValues(prev => ({ ...prev, [key]: value }))
    setConfigSaveSuccess(false)
  }, [])

  const resolvedSpec = resolveSpecI18n(app.spec, getCurrentLanguage())
  const configSchema = resolvedSpec.config_schema ?? []
  const browserLoginEntries = resolvedSpec.browser_login ?? []
  const subscriptions = specSubscriptions
  const hasConfig = configSchema.length > 0

  // Spec fields change detection
  const specHasChanges =
    specName !== app.spec.name ||
    specDescription !== app.spec.description ||
    specSystemPrompt !== specSystemPromptValue

  // Config form change detection
  const configHasChanges = hasConfig && JSON.stringify(formValues) !== JSON.stringify(app.userConfig)

  async function handleSpecSave() {
    setSpecError(null)
    if (!specName.trim()) {
      setSpecError(t('App name is required'))
      return
    }
    if (!specDescription.trim()) {
      setSpecError(t('Description is required'))
      return
    }

    setSpecSaving(true)
    const patch: Record<string, unknown> = {}
    if (specName !== app.spec.name) patch.name = specName.trim()
    if (specDescription !== app.spec.description) patch.description = specDescription.trim()
    const promptChanged = specSystemPrompt !== specSystemPromptValue
    if (promptChanged) {
      patch.system_prompt = specSystemPrompt.trim() || null
    }

    const ok = await updateAppSpec(appId, patch)
    setSpecSaving(false)
    if (ok) {
      setSpecSaveSuccess(true)
      setTimeout(() => setSpecSaveSuccess(false), 2000)
      // system_prompt is loaded at session creation; flag restart so users
      // see the inline hint instead of silently getting stale behavior.
      if (promptChanged) onRequireRestart()
    } else {
      setSpecError(t('Failed to save spec changes'))
    }
  }

  function handleSpecReset() {
    setSpecName(app.spec.name)
    setSpecDescription(app.spec.description)
    setSpecSystemPrompt(specSystemPromptValue)
    setSpecSaveSuccess(false)
    setSpecError(null)
  }

  async function handleConfigSave() {
    setConfigSaving(true)
    const ok = await updateAppConfig(appId, formValues)
    setConfigSaving(false)
    if (ok) {
      setConfigSaveSuccess(true)
      setTimeout(() => setConfigSaveSuccess(false), 2000)
      // config values are baked into the system prompt at session creation,
      // so changes only take effect for a fresh session.
      onRequireRestart()
    }
  }

  function handleConfigReset() {
    setFormValues({ ...app.userConfig })
    setConfigSaveSuccess(false)
  }

  // Determine whether the app currently has a schedule subscription
  const scheduleSubscription = subscriptions.find(s => s.source.type === 'schedule')
  const hasSchedule = !!scheduleSubscription

  // Current schedule value for SchedulePicker
  const currentScheduleValue: ScheduleValue | null = scheduleSubscription
    ? extractScheduleValue(scheduleSubscription)
    : null

  async function handleScheduleToggle(enabled: boolean) {
    if (enabled) {
      // Add default schedule subscription
      const newSubs = [
        ...subscriptions,
        { source: { type: 'schedule' as const, config: { every: '1h' } } },
      ]
      await updateAppSpec(appId, { subscriptions: newSubs })
    } else {
      // Remove all schedule subscriptions, preserve non-schedule ones
      const nonScheduleSubs = subscriptions.filter(s => s.source.type !== 'schedule')
      await updateAppSpec(appId, {
        subscriptions: nonScheduleSubs.length > 0 ? nonScheduleSubs : [],
      })
    }
  }

  async function handleScheduleValueChange(value: ScheduleValue) {
    if (!scheduleSubscription) return
    const updated = applyScheduleValue(scheduleSubscription, value)
    const newSubs = subscriptions.map(s =>
      s === scheduleSubscription ? updated : s
    )
    await updateAppSpec(appId, { subscriptions: newSubs })
  }

  async function handleOpenDataFolder() {
    const res = await api.appOpenDataFolder(appId)
    if (!res.success) {
      console.error('[AppConfigPanel] appOpenDataFolder failed:', res.error)
    }
  }

  return (
    <div className="space-y-6">
      {/* ════════════════════════════════════════════
          User Settings (top section)
          ════════════════════════════════════════════ */}

      {/* ── Schedule Settings ── */}
      {isAutomation && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('Schedule')}
            </h3>
            <Switch
              checked={hasSchedule}
              onCheckedChange={handleScheduleToggle}
              size="sm"
            />
          </div>
          {hasSchedule && currentScheduleValue ? (
            <SchedulePicker
              value={currentScheduleValue}
              onChange={handleScheduleValueChange}
            />
          ) : !hasSchedule && (
            <p className="text-xs text-muted-foreground">
              {t('No scheduled trigger. This app can be triggered manually or via IM bot.')}
            </p>
          )}
        </div>
      )}

      {/* ── Runtime Settings (Model + AI Browser + Notifications) ── */}
      <div className="space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('Runtime')}
        </h3>

        {/* Model selector */}
        <AppModelSelector
          modelSourceId={app.userOverrides.modelSourceId}
          modelId={app.userOverrides.modelId}
          recommendedModel={specRecommendedModel}
          onChange={async (sourceId, modelId) => {
            await updateAppOverrides(appId, {
              modelSourceId: sourceId,
              modelId: modelId,
            })
          }}
        />

        {/* AI Browser toggle */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-sm text-foreground">{t('AI Browser')}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('Enable browser tools for web automation')}
            </p>
          </div>
          <Switch
            checked={resolvePermission(app, 'ai-browser')}
            onCheckedChange={async (checked) => {
              if (checked) {
                await grantPermission(appId, 'ai-browser')
              } else {
                await revokePermission(appId, 'ai-browser')
              }
            }}
            size="sm"
          />
        </div>
        {/* Warn when user disabled a permission the spec declares */}
        {!resolvePermission(app, 'ai-browser') && app.spec.permissions?.includes('ai-browser') && (
          <p className="text-xs text-amber-500 flex items-center gap-1 -mt-2">
            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
            {t('This app may require AI Browser to work properly')}
          </p>
        )}

        {/* Email MCP toggle */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Mail className={`w-3.5 h-3.5 ${emailConfigured ? 'text-muted-foreground' : 'text-muted-foreground/50'}`} />
              <span className={`text-sm ${emailConfigured ? 'text-foreground' : 'text-muted-foreground'}`}>{t('Email')}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('Allow this app to read, send, and manage emails and calendar')}
            </p>
          </div>
          <Switch
            checked={emailConfigured && resolvePermission(app, 'email', false)}
            onCheckedChange={async (checked) => {
              if (!emailConfigured) return
              if (checked) {
                await grantPermission(appId, 'email')
              } else {
                await revokePermission(appId, 'email')
              }
            }}
            disabled={!emailConfigured}
            size="sm"
          />
        </div>
        {/* Not configured: show hint with link to settings */}
        {!emailConfigured && (
          <button
            onClick={() => {
              setView('settings')
              setTimeout(() => {
                const el = document.getElementById('message-channels')
                el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }, 100)
            }}
            className="text-xs text-amber-500 flex items-center gap-1 -mt-2 hover:text-amber-400 transition-colors"
          >
            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
            {t('Email not configured. Go to Settings > Notification Channels to set up.')}
          </button>
        )}
        {/* Warn when user disabled a permission the spec declares */}
        {emailConfigured && !resolvePermission(app, 'email', false) && app.spec.permissions?.includes('email') && (
          <p className="text-xs text-amber-500 flex items-center gap-1 -mt-2">
            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
            {t('This app may require Email to work properly')}
          </p>
        )}

        {/* IM Push toggle */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Send className={`w-3.5 h-3.5 ${hasImInstances ? 'text-muted-foreground' : 'text-muted-foreground/50'}`} />
              <span className={`text-sm ${hasImInstances ? 'text-foreground' : 'text-muted-foreground'}`}>{t('IM Push')}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('Allow this app to send messages to IM contacts')}
            </p>
          </div>
          <Switch
            checked={hasImInstances && resolvePermission(app, 'im-push')}
            onCheckedChange={async (checked) => {
              if (!hasImInstances) return
              if (checked) {
                await grantPermission(appId, 'im-push')
              } else {
                await revokePermission(appId, 'im-push')
              }
            }}
            disabled={!hasImInstances}
            size="sm"
          />
        </div>
        {/* Not configured: show hint with link to settings */}
        {!hasImInstances && (
          <button
            onClick={() => {
              setView('settings')
              setTimeout(() => {
                const el = document.getElementById('message-channels')
                el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }, 100)
            }}
            className="text-xs text-amber-500 flex items-center gap-1 -mt-2 hover:text-amber-400 transition-colors"
          >
            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
            {t('No IM channels configured. Go to Settings to set up.')}
          </button>
        )}
        {/* Warn when user disabled a permission the spec declares */}
        {hasImInstances && !resolvePermission(app, 'im-push') && app.spec.permissions?.includes('im-push') && (
          <p className="text-xs text-amber-500 flex items-center gap-1 -mt-2">
            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
            {t('This app may require IM Push to work properly')}
          </p>
        )}

        {/* Browser login sites */}
        {browserLoginEntries.length > 0 && (
          <div className="space-y-2">
            <span className="text-sm text-foreground">{t('Required Logins')}</span>
            <div className="space-y-1">
              {browserLoginEntries.map(entry => (
                <button
                  key={entry.url}
                  onClick={() => {
                    api.openLoginWindow(entry.url, entry.label)
                  }}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left rounded-lg bg-secondary/50 border border-border hover:bg-secondary transition-colors group"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Globe className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                    <span className="text-sm text-foreground truncate">{entry.label}</span>
                  </div>
                  <ExternalLink className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('Click to open the website and log in via the Halo browser.')}
            </p>
          </div>
        )}

        {/* Notification level */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Bell className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-sm text-foreground">{t('System Notifications')}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {([
              { value: 'important', label: t('Important') },
              { value: 'all', label: t('All') },
              { value: 'none', label: t('None') },
            ] as const).map(opt => (
              <button
                key={opt.value}
                onClick={async () => {
                  await updateAppOverrides(appId, {
                    notificationLevel: opt.value === 'important' ? undefined : opt.value,
                  })
                }}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  (app.userOverrides.notificationLevel ?? 'important') === opt.value
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {(app.userOverrides.notificationLevel ?? 'important') === 'all'
              ? t('Notify on every execution result')
              : (app.userOverrides.notificationLevel ?? 'important') === 'none'
                ? t('No desktop notifications')
                : t('Notify on milestones, escalations, and outputs')}
          </p>
        </div>
      </div>

      {/* ── Notification Methods (channel selector) ── */}
      {isAutomation && (
        <div className="space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <Send className="w-3.5 h-3.5" />
            {t('Message Channels')}
          </h3>
          <p className="text-xs text-muted-foreground -mt-2">
            {t('Notification channels and contacts available to this digital human')}
          </p>
          <AppNotifyChannelsSection
            appId={appId}
            appName={app.spec.name}
            imPushEnabled={resolvePermission(app, 'im-push')}
          />
        </div>
      )}

      {/* ── User Configuration Fields ── */}
      {hasConfig && (
        <div className="space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('Configuration')}
          </h3>
          <div className="space-y-4">
            {configSchema.map(def => (
              <ConfigField
                key={def.key}
                def={def}
                value={formValues[def.key]}
                onChange={handleFieldChange}
                t={t}
              />
            ))}
          </div>

          {/* Config Save / Reset */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleConfigSave}
              disabled={!configHasChanges || configSaving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40"
            >
              {configSaving
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Save className="w-3.5 h-3.5" />}
              {t('Save')}
            </button>
            {configHasChanges && (
              <button
                onClick={handleConfigReset}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t('Reset')}
              </button>
            )}
            {configSaveSuccess && (
              <span className="text-xs text-green-500">{t('Saved')}</span>
            )}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════
          Developer Section (bottom, separated)
          ════════════════════════════════════════════ */}
      <div className="border-t border-border pt-6 space-y-6">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Wrench className="w-3.5 h-3.5" />
          {t('Developer')}
        </h3>

        {/* ── App Spec Fields (name, description, system_prompt) ── */}
        <div className="space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-sm text-foreground">{t('Name')}</label>
            <input
              type="text"
              value={specName}
              onChange={e => { setSpecName(e.target.value); setSpecSaveSuccess(false); setSpecError(null) }}
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-sm text-foreground">{t('Description')}</label>
            <input
              type="text"
              value={specDescription}
              onChange={e => { setSpecDescription(e.target.value); setSpecSaveSuccess(false); setSpecError(null) }}
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
            />
          </div>

          {/* System Prompt */}
          <div className="space-y-1.5">
            <label className="text-sm text-foreground">{t('System Prompt')}</label>
            <SystemPromptEditor
              value={specSystemPrompt}
              onChange={v => { setSpecSystemPrompt(v); setSpecSaveSuccess(false); setSpecError(null) }}
              onDone={() => { if (specHasChanges) void handleSpecSave() }}
              fontMono
            />
          </div>

          {/* Spec Save / Reset */}
          {specError && (
            <p className="text-xs text-red-400">{specError}</p>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleSpecSave}
              disabled={!specHasChanges || specSaving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40"
            >
              {specSaving
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Save className="w-3.5 h-3.5" />}
              {t('Save')}
            </button>
            {specHasChanges && (
              <button
                onClick={handleSpecReset}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t('Reset')}
              </button>
            )}
            {specSaveSuccess && (
              <span className="text-xs text-green-500">{t('Saved')}</span>
            )}
          </div>
        </div>

        <UpgradeSection app={app} appId={appId} t={t} />

        {/* ── Spec Info (read-only summary + data directory) ── */}
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <FileCode className="w-3.5 h-3.5" />
            {t('App Spec')}
          </h3>
          <div className="bg-secondary rounded-lg p-3 text-xs font-mono space-y-1">
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 flex-shrink-0">{t('Type')}</span>
              <span className="text-foreground">{t(appTypeLabel(app.spec.type))}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 flex-shrink-0">{t('Version')}</span>
              <span className="text-foreground">{app.spec.version}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 flex-shrink-0">{t('Spec')}</span>
              <span className="text-foreground">v{app.spec.spec_version}</span>
            </div>
            {subscriptions.length > 0 && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-20 flex-shrink-0">{t('Triggers')}</span>
                <span className="text-foreground">
                  {subscriptions.map(s => s.source.type).join(', ')}
                </span>
              </div>
            )}
            {app.spaceId && spaceName && (
              <div className="flex gap-2 items-center">
                <span className="text-muted-foreground w-20 flex-shrink-0 flex items-center gap-1">
                  {t('Workspace')}
                  <InfoTip text={t('The workspace folder where the digital human saves code files, task outputs, and work artifacts.')} />
                </span>
                <button
                  onClick={() => useSpaceStore.getState().openSpaceFolder(app.spaceId!)}
                  className="text-foreground hover:text-primary transition-colors flex items-center gap-1 group"
                >
                  <FolderOpen className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
                  <span className="underline decoration-dotted underline-offset-2">{spaceName}</span>
                </button>
              </div>
            )}
            <div className="flex gap-2 items-start">
              <span className="text-muted-foreground w-20 flex-shrink-0 pt-px flex items-center gap-1">
                {t('Memory Files')}
                <InfoTip text={t('Internal runtime state (memory.md and run history). Separate from workspace files and not affected by space operations.')} />
              </span>
              <div className="min-w-0 flex-1">
                {dataPath && (
                  <p className="text-foreground/60 truncate text-[11px] leading-relaxed select-all" title={dataPath}>
                    {dataPath}
                  </p>
                )}
                <button
                  onClick={handleOpenDataFolder}
                  className="text-foreground hover:text-primary transition-colors flex items-center gap-1 group mt-0.5"
                  title={t('Reveal in Finder')}
                >
                  <FolderOpen className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
                  <span className="underline decoration-dotted underline-offset-2">
                    {t('Reveal in Finder')}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================
// YAML Tab Content
// ============================================

interface YamlTabProps {
  app: InstalledApp
  appId: string
  t: (s: string, opts?: Record<string, unknown>) => string
  /** See SettingsTabProps.onRequireRestart */
  onRequireRestart: () => void
}

function YamlTab({ app, appId, t, onRequireRestart }: YamlTabProps) {
  const { updateAppSpec, exportApp } = useAppsStore()

  const [yamlContent, setYamlContent] = useState(() => specToYaml(app.spec))
  const [originalYaml, setOriginalYaml] = useState(() => specToYaml(app.spec))
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  // Sync when app spec changes externally (e.g. after Settings tab save)
  useEffect(() => {
    const fresh = specToYaml(app.spec)
    setYamlContent(fresh)
    setOriginalYaml(fresh)
    setSaveSuccess(false)
    setError(null)
  }, [app.id, app.spec])

  const hasChanges = yamlContent !== originalYaml

  async function handleSave() {
    setError(null)

    // Parse YAML
    let parsed: Record<string, unknown>
    try {
      parsed = parseYaml(yamlContent) as Record<string, unknown>
    } catch (e) {
      setError(t('Invalid YAML syntax'))
      return
    }

    if (!parsed || typeof parsed !== 'object') {
      setError(t('YAML must be an object'))
      return
    }

    // Prevent type changes
    if (parsed.type && parsed.type !== app.spec.type) {
      setError(t('Cannot change app type'))
      return
    }

    setSaving(true)

    // Detect whether the saved YAML changed any field that requires an
    // agent restart to take effect. We diff before sending so the hint is
    // not raised for cosmetic edits (e.g. comment/whitespace-only changes).
    const promptChanged = parsed.system_prompt !== app.spec.system_prompt
    const configChanged = JSON.stringify(parsed.config_schema ?? null)
      !== JSON.stringify(app.spec.config_schema ?? null)

    // Send the full parsed spec as the patch.
    // The backend applies JSON Merge Patch and re-validates with Zod.
    const ok = await updateAppSpec(appId, parsed)
    setSaving(false)

    if (ok) {
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
      if (promptChanged || configChanged) onRequireRestart()
    } else {
      setError(t('Failed to save. The server rejected the spec — check for validation errors.'))
    }
  }

  function handleReset() {
    setYamlContent(originalYaml)
    setError(null)
    setSaveSuccess(false)
  }

  async function handleExport() {
    setExporting(true)
    await exportApp(appId)
    setExporting(false)
  }

  return (
    <div className="space-y-3 flex flex-col" style={{ minHeight: 0 }}>
      <p className="text-xs text-muted-foreground">
        {t('Edit the full app spec as YAML. Changes are validated by the server before saving.')}
      </p>

      <Suspense fallback={
        <div className="h-96 flex items-center justify-center bg-secondary rounded-lg border border-border">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      }>
        <div className="border border-border rounded-lg overflow-hidden h-[45vh] sm:h-[60vh] min-h-[280px] sm:min-h-[320px]">
          <CodeMirrorEditor
            content={yamlContent}
            language="yaml"
            readOnly={false}
            onChange={setYamlContent}
          />
        </div>
      </Suspense>

      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40"
        >
          {saving
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Save className="w-3.5 h-3.5" />}
          {t('Save')}
        </button>
        {hasChanges && (
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {t('Reset')}
          </button>
        )}
        {saveSuccess && (
          <span className="text-xs text-green-500">{t('Saved')}</span>
        )}

        <div className="flex-1" />

        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors disabled:opacity-40"
          title={t('Export as YAML file')}
        >
          {exporting
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Download className="w-3.5 h-3.5" />}
          {t('Export')}
        </button>
      </div>
    </div>
  )
}

// ============================================
// Main Component
// ============================================

interface AppConfigPanelProps {
  appId: string
  /** Space name to display in the identity section */
  spaceName?: string
}

export function AppConfigPanel({ appId, spaceName }: AppConfigPanelProps) {
  const { t } = useTranslation()
  const { apps, uninstallApp, restartAppAgent } = useAppsStore()
  const app = apps.find(a => a.id === appId)

  const [activeTab, setActiveTab] = useState<ConfigTab>('settings')
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false)
  const [showClearMemoryConfirm, setShowClearMemoryConfirm] = useState(false)
  const [clearingMemory, setClearingMemory] = useState(false)

  // Restart-required hint: raised by a save that changes a field loaded only
  // at session creation (system_prompt, config_schema, userConfig). Cleared
  // by a successful restart or explicit dismissal.
  const [restartHinted, setRestartHinted] = useState(false)
  const [restarting, setRestarting] = useState(false)
  // Brief inline success indicator next to the Restart button. Auto-clears
  // after a few seconds so the user gets explicit confirmation that the
  // click did something — without it, a fast restart looks like a no-op.
  const [restartedAt, setRestartedAt] = useState<number | null>(null)

  // Reset hint + ephemeral indicators when switching apps so nothing bleeds
  // across panels.
  useEffect(() => {
    setRestartHinted(false)
    setRestarting(false)
    setRestartedAt(null)
  }, [appId])

  const handleRestartAgent = useCallback(async () => {
    setRestarting(true)
    try {
      const ok = await restartAppAgent(appId)
      if (ok) {
        setRestartHinted(false)
        setRestartedAt(Date.now())
      }
    } finally {
      setRestarting(false)
    }
  }, [appId, restartAppAgent])

  // Auto-clear the inline success indicator after ~2.5s.
  useEffect(() => {
    if (restartedAt === null) return
    const timer = setTimeout(() => setRestartedAt(null), 2500)
    return () => clearTimeout(timer)
  }, [restartedAt])

  if (!app) return null

  const { name, description } = resolveSpecI18n(app.spec, getCurrentLanguage())

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {/* App identity (always visible) */}
      <div>
        <h2 className="text-base font-semibold text-foreground">{name}</h2>
        <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-muted-foreground">
            v{app.spec.version} · {app.spec.author}
            {spaceName && <span> · {spaceName}</span>}
          </span>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex items-center gap-0.5 bg-secondary rounded-lg p-0.5 w-fit">
        <button
          onClick={() => setActiveTab('settings')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${
            activeTab === 'settings'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Settings className="w-3.5 h-3.5" />
          {t('Settings')}
        </button>
        <button
          onClick={() => setActiveTab('yaml')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${
            activeTab === 'yaml'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Code className="w-3.5 h-3.5" />
          {t('YAML')}
        </button>
      </div>

      {/* Restart-required hint banner: appears after a save that changes a
          field loaded only at session creation. Persists across tab switches
          and dismissals so users don't lose track of stuck state. */}
      {restartHinted && (
        <div
          role="status"
          className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3 p-3 rounded-lg border border-amber-400/30 bg-amber-400/5"
        >
          <div className="flex items-start gap-2 flex-1 min-w-0">
            <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm text-foreground">
                {t('Changes require an {{name}} restart to take effect.', { name: 'Agent' })}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('Conversation history is preserved.')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 sm:flex-shrink-0 self-end sm:self-auto">
            <button
              onClick={handleRestartAgent}
              disabled={restarting}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {restarting
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <RefreshCw className="w-3 h-3" />}
              {t('Restart Now')}
            </button>
            <button
              onClick={() => setRestartHinted(false)}
              disabled={restarting}
              className="p-1 text-muted-foreground hover:text-foreground rounded-md transition-colors disabled:opacity-50"
              aria-label={t('Dismiss')}
              title={t('Dismiss')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Tab content */}
      {activeTab === 'settings' && (
        <SettingsTab
          app={app}
          appId={appId}
          spaceName={spaceName}
          t={t}
          onRequireRestart={() => setRestartHinted(true)}
        />
      )}
      {activeTab === 'yaml' && (
        <YamlTab
          app={app}
          appId={appId}
          t={t}
          onRequireRestart={() => setRestartHinted(true)}
        />
      )}

      {/* Runtime Control: always-visible escape hatch for restarting the
          agent. Sits outside Danger Zone because restart is non-destructive
          (no data loss); grouping it with Uninstall would mis-signal risk. */}
      <div className="space-y-2 pt-2 border-t border-border">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('Runtime Control')}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleRestartAgent}
            disabled={restarting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-foreground hover:text-primary border border-border hover:border-primary/60 rounded-lg transition-colors disabled:opacity-50"
          >
            {restarting
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5" />}
            {t('Restart {{name}}', { name: 'Agent' })}
          </button>
          {restartedAt !== null && (
            <span className="text-xs text-green-500">{t('Restarted')}</span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          {t('Reloads the prompt and configuration for this digital human across all chat channels. Conversation history is preserved.')}
        </p>
      </div>

      {/* Danger Zone (always visible) */}
      <div className="space-y-2 pt-2 border-t border-border">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('Danger zone')}
        </h3>

        {showClearMemoryConfirm ? (
          <div className="p-3 border border-orange-400/30 rounded-lg space-y-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-muted-foreground">
                {t('This will permanently delete all memory files (memory.md and run history). The app will start fresh on its next run.')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  setClearingMemory(true)
                  try {
                    const res = await api.appClearMemory(appId)
                    if (!res.success) {
                      console.error('[AppConfigPanel] clearAppMemory failed:', res.error)
                    }
                  } catch (err) {
                    console.error('[AppConfigPanel] clearAppMemory error:', err)
                  } finally {
                    setClearingMemory(false)
                    setShowClearMemoryConfirm(false)
                  }
                }}
                disabled={clearingMemory}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-orange-400 hover:text-orange-300 border border-orange-400/30 hover:border-orange-400/60 rounded-lg transition-colors disabled:opacity-50"
              >
                {clearingMemory ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                {t('Confirm Clear')}
              </button>
              <button
                onClick={() => setShowClearMemoryConfirm(false)}
                disabled={clearingMemory}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground rounded-lg transition-colors disabled:opacity-50"
              >
                {t('Cancel')}
              </button>
            </div>
          </div>
        ) : showUninstallConfirm ? (
          <div className="p-3 border border-red-400/30 rounded-lg space-y-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-muted-foreground">
                {t('Are you sure you want to uninstall this app? You can reinstall it later.')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  await uninstallApp(appId)
                  setShowUninstallConfirm(false)
                }}
                className="px-3 py-1.5 text-sm text-red-400 hover:text-red-300 border border-red-400/30 hover:border-red-400/60 rounded-lg transition-colors"
              >
                {t('Confirm Uninstall')}
              </button>
              <button
                onClick={() => setShowUninstallConfirm(false)}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground rounded-lg transition-colors"
              >
                {t('Cancel')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setShowClearMemoryConfirm(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-orange-400 hover:text-orange-300 border border-orange-400/30 hover:border-orange-400/60 rounded-lg transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                {t('Clear Memory')}
              </button>
              <button
                onClick={() => setShowUninstallConfirm(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-400 hover:text-red-300 border border-red-400/30 hover:border-red-400/60 rounded-lg transition-colors"
              >
                <Unplug className="w-4 h-4" />
                {t('Uninstall')}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground/60 mt-1">
              {t('Memory is the internal runtime state (memory.md and run history). Clearing it does not affect files in the space.')}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
