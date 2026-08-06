/**
 * Advanced Section Component
 * Developer-level settings: SDK engine, extended capabilities, max turns, CLI integration
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, Cpu, Puzzle, RefreshCw, Terminal } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { EngineAvailabilityReport, EngineId, HaloConfig } from '../../types'
import { CLIConfigSection } from './CLIConfigSection'
import { Switch } from '../ui/Switch'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { DEFAULT_DISABLED_TOOLS } from '../../../shared/constants/disabled-tools'

// ─── Agent SDK Engine ───────────────────────────────────────────────────────────

/**
 * Engine order shown in the selector. Labels and descriptions stay at the
 * render site as `t()` literals — i18next-parser only extracts literal keys,
 * so moving the copy into this table would drop the existing translations.
 */
const ENGINE_IDS: readonly EngineId[] = ['anthropic', 'halo', 'codex']

// ─── Built-in MCP Extensions ────────────────────────────────────────────────────

/**
 * Capability groups shown in the Built-in MCP Extensions panel.
 *
 * Two control mechanisms:
 * - `tools`: CC SDK tool names → added to `config.agent.disabledTools` when disabled
 * - `configKey`: Dedicated boolean in `config.agent` → controls MCP server injection or env vars
 *
 * Groups may use one or both. When `configKey` is present, it determines the toggle state;
 * otherwise the toggle state is derived from `disabledTools`.
 */
interface CapabilityGroup {
  id: string
  labelKey: string
  descKey: string
  /** CC SDK tools to add/remove from disabledTools (empty for MCP-only capabilities) */
  tools: readonly string[]
  /** Optional: dedicated AgentConfig boolean flag (for MCP servers, env vars, etc.) */
  configKey?: 'enableTeams' | 'enableDigitalHumans'
  /** Default value when configKey is not set in config (default: false) */
  configDefault?: boolean
}

const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  {
    id: 'teams',
    labelKey: 'Agent Teams',
    descKey: 'Multi-agent collaboration. Agents can spawn teammates to work in parallel.',
    tools: ['TeamCreate', 'TeamDelete', 'SendMessage'],
    configKey: 'enableTeams',
  },
  {
    id: 'planMode',
    labelKey: 'Plan Mode',
    descKey: 'Step-by-step planning workflow with approval gates.',
    tools: ['EnterPlanMode', 'ExitPlanMode'],
  },
  {
    id: 'worktree',
    labelKey: 'Git Worktree',
    descKey: 'Isolated git worktree for parallel branch work.',
    tools: ['EnterWorktree', 'ExitWorktree'],
  },
  {
    id: 'cron',
    labelKey: 'Scheduled Tasks',
    descKey: 'Built-in cron job scheduling. Halo has its own automation system.',
    tools: ['CronCreate', 'CronDelete', 'CronList'],
  },
  {
    id: 'notebook',
    labelKey: 'Notebook Editing',
    descKey: 'Jupyter notebook (.ipynb) cell editing.',
    tools: ['NotebookEdit'],
  },
  {
    id: 'digitalHumans',
    labelKey: 'Digital Humans',
    descKey: 'Create, manage and schedule automation agents.',
    tools: [],
    configKey: 'enableDigitalHumans',
    configDefault: true,
  },
]

// ─── Component ──────────────────────────────────────────────────────────────────

interface AdvancedSectionProps {
  config: HaloConfig | null
  setConfig: (config: HaloConfig) => void
}

export function AdvancedSection({ config, setConfig }: AdvancedSectionProps) {
  const { t } = useTranslation()
  const { showConfirm, DialogComponent: RestartDialogComponent } = useConfirmDialog()

  const [maxTurns, setMaxTurnsState] = useState(config?.agent?.maxTurns ?? 50)
  const [sdkEngine, setSdkEngineState] = useState<'anthropic' | 'halo' | 'codex'>(
    config?.agent?.sdkEngine ?? 'anthropic'
  )
  // Track whether the SDK engine was changed from the initial value (needs restart)
  const [sdkEngineInitial] = useState<'anthropic' | 'halo' | 'codex'>(
    config?.agent?.sdkEngine ?? 'anthropic'
  )
  const [disabledTools, setDisabledToolsState] = useState<string[]>(
    config?.agent?.disabledTools ?? DEFAULT_DISABLED_TOOLS
  )
  // Track dedicated config flags for capabilities that use configKey
  const [configFlags, setConfigFlags] = useState<Record<string, boolean>>(() => {
    const flags: Record<string, boolean> = {}
    for (const group of CAPABILITY_GROUPS) {
      if (group.configKey) {
        flags[group.configKey] = config?.agent?.[group.configKey] ?? group.configDefault ?? false
      }
    }
    return flags
  })
  const [developerMode, setDeveloperModeState] = useState(config?.agent?.developerMode ?? false)
  const [capsPanelOpen, setCapsPanelOpen] = useState(false)
  const [engineAvailability, setEngineAvailability] = useState<EngineAvailabilityReport | null>(null)

  const sdkEngineChanged = sdkEngine !== sdkEngineInitial

  // Engines absent from this build must not be selectable — picking one used to
  // leave the app unable to start. Until the probe answers, every option stays
  // enabled: the call is local and resolves in milliseconds, and a selection
  // made in that window still degrades safely at startup rather than failing.
  useEffect(() => {
    let cancelled = false
    api.getEngineAvailability()
      .then(result => {
        if (cancelled || !result?.success || !result.data) return
        setEngineAvailability(result.data as EngineAvailabilityReport)
      })
      .catch(error => console.warn('[AdvancedSection] Engine availability unavailable:', error))
    return () => { cancelled = true }
  }, [])

  const isEngineAvailable = (engineId: EngineId) => {
    if (!engineAvailability) return true
    return engineAvailability.engines.find(e => e.engineId === engineId)?.available ?? false
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  const isCapabilityEnabled = (group: CapabilityGroup) => {
    // Groups with configKey: check the dedicated boolean flag
    if (group.configKey) return configFlags[group.configKey] ?? group.configDefault ?? false
    // Groups with tools only: check disabledTools
    return group.tools.every(tool => !disabledTools.includes(tool))
  }

  const saveAgentConfig = async (patch: Partial<NonNullable<HaloConfig['agent']>>) => {
    const updatedConfig = {
      ...config,
      agent: { ...config?.agent, ...patch }
    } as HaloConfig
    await api.setConfig({ agent: updatedConfig.agent })
    setConfig(updatedConfig)
    return updatedConfig
  }

  // ─── Handlers ───────────────────────────────────────────────────────────────

  const handleSdkEngineChange = async (engine: 'anthropic' | 'halo' | 'codex') => {
    if (engine === sdkEngine) return
    setSdkEngineState(engine)
    try {
      await saveAgentConfig({ sdkEngine: engine })
    } catch (error) {
      console.error('[AdvancedSection] Failed to update sdkEngine:', error)
      setSdkEngineState(config?.agent?.sdkEngine ?? 'anthropic')
    }
  }

  const handleRelaunch = async () => {
    const confirmed = await showConfirm({
      title: t('Restart Halo?'),
      message: t('All active conversations and background tasks will be interrupted.'),
      confirmLabel: t('Restart'),
      cancelLabel: t('Cancel'),
      variant: 'warning',
    })
    if (!confirmed) return
    try {
      await api.relaunch()
    } catch (error) {
      console.error('[AdvancedSection] Failed to relaunch:', error)
    }
  }

  const handleMaxTurnsChange = async (value: number) => {
    const clamped = Math.max(10, Math.min(9999, value))
    setMaxTurnsState(clamped)
    try {
      await saveAgentConfig({ maxTurns: clamped })
    } catch (error) {
      console.error('[AdvancedSection] Failed to update maxTurns:', error)
      setMaxTurnsState(config?.agent?.maxTurns ?? 50)
    }
  }

  const handleCapabilityToggle = async (group: CapabilityGroup, enabled: boolean) => {
    const currentEnabled = isCapabilityEnabled(group)
    if (currentEnabled === enabled) return

    // Update disabledTools for groups that control SDK tools
    let newDisabled: string[]
    if (enabled) {
      newDisabled = disabledTools.filter(t => !group.tools.includes(t))
    } else {
      const set = new Set(disabledTools)
      for (const tool of group.tools) set.add(tool)
      newDisabled = Array.from(set)
    }
    setDisabledToolsState(newDisabled)

    // Optimistically update dedicated config flag
    const key = group.configKey
    if (key) {
      setConfigFlags(prev => ({ ...prev, [key]: enabled }))
    }

    try {
      const extraPatch: Partial<NonNullable<HaloConfig['agent']>> = {}
      if (key) {
        extraPatch[key] = enabled
      }
      await saveAgentConfig({ disabledTools: newDisabled, ...extraPatch })
    } catch (error) {
      console.error('[AdvancedSection] Failed to update capability:', error)
      setDisabledToolsState(config?.agent?.disabledTools ?? DEFAULT_DISABLED_TOOLS)
      if (key) {
        setConfigFlags(prev => ({
          ...prev,
          [key]: config?.agent?.[key] ?? group.configDefault ?? false,
        }))
      }
    }
  }

  const handleDeveloperModeChange = async (enabled: boolean) => {
    setDeveloperModeState(enabled)
    try {
      await saveAgentConfig({ developerMode: enabled })
    } catch (error) {
      console.error('[AdvancedSection] Failed to update developerMode:', error)
      setDeveloperModeState(config?.agent?.developerMode ?? false)
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <section id="advanced" className="bg-card rounded-xl border border-border p-4 sm:p-6">
      <h2 className="text-lg font-medium mb-4">{t('Advanced')}</h2>

      {/* Warning banner */}
      <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 mb-5 text-sm text-amber-600 dark:text-amber-400">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>{t('Changes here affect all AI agent behavior. New settings take effect on the next conversation.')}</span>
      </div>

      <div className="space-y-4">
        {/* Agent SDK Engine */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Cpu className="w-4 h-4 text-muted-foreground shrink-0" />
            <p className="font-medium">{t('AI Agent Engine')}</p>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">
              {t('Experimental')}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mb-3">
            {t('Choose the underlying engine that powers the AI agent')}
          </p>

          {engineAvailability?.degradedFrom && (
            <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 mb-3 text-sm text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                {t('The selected engine is not included in this build, so Halo is running on another engine. Your choice has been kept — reinstall a complete package, or pick an available engine below.')}
              </span>
            </div>
          )}

          <div className="space-y-2">
            {ENGINE_IDS.map(engineId => {
              const available = isEngineAvailable(engineId)
              return (
                <label
                  key={engineId}
                  className={`flex items-start gap-3 p-3 rounded-lg border border-border transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5 ${
                    available ? 'cursor-pointer hover:bg-muted/50' : 'cursor-not-allowed opacity-60'
                  }`}
                >
                  <input
                    type="radio"
                    name="sdkEngine"
                    value={engineId}
                    checked={sdkEngine === engineId}
                    disabled={!available}
                    onChange={() => handleSdkEngineChange(engineId)}
                    className="mt-0.5 accent-primary"
                  />
                  <div>
                    <p className="font-medium text-sm">
                      {engineId === 'anthropic' && t('Claude Code SDK')}
                      {engineId === 'halo' && t('Halo SDK')}
                      {engineId === 'codex' && t('Codex SDK')}
                      {!available && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {t('Not included in this build')}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {engineId === 'anthropic' && t('Powered by the official Anthropic Claude Code engine. Works with a wide range of frontier models. (Default)')}
                      {engineId === 'halo' && t('The official Halo agent engine. Lightweight on resources, faster startup, optimized for open-source models. Experimental.')}
                      {engineId === 'codex' && t('Powered by the official OpenAI Codex SDK. Better suited for GPT-family models. Experimental.')}
                    </p>
                  </div>
                </label>
              )
            })}
          </div>

          {/* Restart required notice */}
          {sdkEngineChanged && (
            <div className="mt-3 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400">
                  <RefreshCw className="w-4 h-4 shrink-0" />
                  <span>{t('Restart required for the engine change to take effect.')}</span>
                </div>
                <button
                  type="button"
                  onClick={handleRelaunch}
                  className="ml-3 shrink-0 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                >
                  {t('Restart Now')}
                </button>
              </div>
              <p className="text-xs text-blue-600/80 dark:text-blue-400/80">
                {t('The selected engine only applies to new conversations and new tasks. Existing conversations cannot switch engines.')}
              </p>
            </div>
          )}
        </div>

        {/* Extended Capabilities */}
        <div className="pt-4 border-t border-border">
          <div className="border border-border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setCapsPanelOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
            >
              <div className="flex items-center gap-2.5">
                <Puzzle className="w-4 h-4 text-muted-foreground" />
                <span className="font-medium text-sm">{t('Built-in MCP Extensions')}</span>
              </div>
              {capsPanelOpen
                ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                : <ChevronDown className="w-4 h-4 text-muted-foreground" />
              }
            </button>

            {capsPanelOpen && (
              <div className="border-t border-border">
                {/* Hint */}
                <p className="px-4 pt-3 pb-2 text-xs text-muted-foreground">
                  {t('Extra tools consume additional tokens per message. Enable only what you need. Please start a new session or restart Halo for changes to take effect.')}
                </p>

                {/* Capability toggles */}
                <div className="px-4 pb-4 space-y-0">
                  {CAPABILITY_GROUPS.map((group, idx) => {
                    const enabled = isCapabilityEnabled(group)
                    return (
                      <div
                        key={group.id}
                        className={`flex items-center justify-between py-3 ${
                          idx > 0 ? 'border-t border-border' : ''
                        }`}
                      >
                        <div className="flex-1 min-w-0 mr-3">
                          <p className="font-medium text-sm">{t(group.labelKey)}</p>
                          <p className="text-xs text-muted-foreground">{t(group.descKey)}</p>
                        </div>
                        <Switch
                          checked={enabled}
                          onCheckedChange={(checked) => handleCapabilityToggle(group, checked)}
                          size="sm"
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Max Turns per Message */}
        <div className="flex items-center justify-between pt-4 border-t border-border">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <p className="font-medium">{t('Max Turns per Message')}</p>
              <span
                className="inline-flex items-center justify-center w-4 h-4 text-xs rounded-full bg-muted text-muted-foreground cursor-help"
                title={t('Maximum number of tool call rounds the AI agent can execute per message')}
              >
                ?
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('Maximum number of tool call rounds the AI agent can execute per message')}
            </p>
          </div>
          <input
            type="number"
            min={10}
            max={9999}
            value={maxTurns}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10)
              if (!isNaN(val)) {
                setMaxTurnsState(val)
              }
            }}
            onBlur={(e) => {
              const val = parseInt(e.target.value, 10)
              if (!isNaN(val)) {
                handleMaxTurnsChange(val)
              }
            }}
            className="w-24 px-3 py-1.5 text-sm bg-secondary border border-border rounded-lg text-right focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        {/* Developer Mode */}
        <div className="flex items-start justify-between pt-4 border-t border-border">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Terminal className="w-4 h-4 text-muted-foreground shrink-0" />
              <p className="font-medium">{t('Developer Mode')}</p>
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">
                {t('Dev')}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('Enable verbose logging for troubleshooting: HTTP request payloads, session lifecycle, stream events, and scheduler diagnostics.')}
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              {t('Generates large log files and may affect performance. Disable after troubleshooting.')}
            </p>
          </div>
          <Switch
            checked={developerMode}
            onCheckedChange={handleDeveloperModeChange}
            size="sm"
            className="ml-4 mt-0.5"
          />
        </div>

        {/* Claude CLI Integration */}
        <CLIConfigSection />
      </div>

      {/* Confirm dialog portal */}
      {RestartDialogComponent}
    </section>
  )
}
