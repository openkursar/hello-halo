/**
 * ModelConfigPanel
 *
 * Displays and edits per-model capability overrides stored in AISource.modelOverrides.
 *
 * Effective value priority: user override > JSON preset > built-in defaults.
 *
 * Visual tab  — form fields showing effective (merged) values.
 * JSON tab    — raw JSON of effective values; parsed on blur.
 *
 * The component loads the preset for the current modelId on mount and whenever
 * modelId changes. All edits write into overrides[modelId]. "Reset to preset"
 * deletes overrides[modelId].
 */

import { useState, useEffect, useRef } from 'react'
import { ChevronDown, ChevronRight, RotateCcw, Info, AlertTriangle, Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type {
  ModelCapability,
  ModelCapabilityOverride,
  ResolvedModelCapability
} from '../../../shared/types/model-capabilities'
import {
  MAX_OUTPUT_TOKENS_HARD_MIN,
  RECOMMENDED_MIN_MAX_OUTPUT_TOKENS,
} from '../../../shared/constants/model-runtime-limits'
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_LEVELS,
  isReasoningEffortLevel,
  type ReasoningEffortLevel,
} from '../../../shared/constants/reasoning-effort'

/** Fields the JSON tab accepts; anything else is reported back. */
const EDITABLE_CAPABILITY_KEYS: ReadonlyArray<keyof ModelCapabilityOverride> = [
  'contextWindow',
  'maxOutputTokens',
  'vision',
  'thinking',
  'reasoningEffort'
]

// ── Default values used when no preset exists ──────────────────────────────
const DEFAULT_CAPABILITY: ModelCapability = {
  displayName: '',
  provider: '',
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  vision: false,
  thinking: false
}

interface ModelConfigPanelProps {
  /** Currently selected model ID */
  modelId: string
  /** All model overrides for this AISource (read-only input) */
  overrides: Record<string, ModelCapabilityOverride>
  /** Called whenever overrides should change */
  onChange: (overrides: Record<string, ModelCapabilityOverride>) => void
}

type ActiveTab = 'visual' | 'json'

export function ModelConfigPanel({ modelId, overrides, onChange }: ModelConfigPanelProps) {
  const { t } = useTranslation()

  // ── Collapse state (auto-expand when no preset found) ──────────────────
  const [isOpen, setIsOpen] = useState(false)
  const [autoExpandedForModel, setAutoExpandedForModel] = useState<string>('')

  // ── Preset data ────────────────────────────────────────────────────────
  const [preset, setPreset] = useState<ModelCapability | null>(null)
  const [loadingPreset, setLoadingPreset] = useState(false)

  // ── Tab state ──────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>('visual')

  // ── JSON editor state ──────────────────────────────────────────────────
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [jsonWarning, setJsonWarning] = useState<string | null>(null)
  const jsonLoadedForModel = useRef<string>('')

  // ── Compute effective values ───────────────────────────────────────────
  // Priority: override > preset > defaults
  const userOverride = overrides[modelId] ?? {}
  const base: ModelCapability = preset ?? DEFAULT_CAPABILITY
  const effective: ResolvedModelCapability = { ...base, ...userOverride }
  const hasOverride = Object.keys(userOverride).length > 0

  // ── Reasoning effort presentation ──────────────────────────────────────
  const effortSelectValue = effective.reasoningEffort ?? ''
  /** A provider-specific level typed in the JSON tab, kept selectable here. */
  const isCustomEffort = !!effective.reasoningEffort
    && !isReasoningEffortLevel(effective.reasoningEffort)
  const effortLabels: Record<ReasoningEffortLevel, string> = {
    off: t('Off'),
    minimal: t('Minimal'),
    low: t('Low'),
    medium: t('Medium'),
    high: t('High'),
    xhigh: t('Extra High'),
    max: t('Max')
  }

  // ── Load preset when modelId changes ──────────────────────────────────
  useEffect(() => {
    if (!modelId) return

    let cancelled = false
    setLoadingPreset(true)
    setPreset(null)
    setJsonError(null)
    setJsonWarning(null)

    api.modelCapabilitiesGetPreset(modelId)
      .then(res => {
        if (cancelled) return
        setPreset((res.data as ModelCapability | null) ?? null)
      })
      .catch(err => {
        if (cancelled) return
        console.warn('[ModelConfigPanel] Failed to load preset:', err)
        setPreset(null)
      })
      .finally(() => {
        if (!cancelled) setLoadingPreset(false)
      })

    return () => { cancelled = true }
  }, [modelId])

  // ── Auto-expand when no preset matched (so user sees fallback values) ───
  useEffect(() => {
    if (loadingPreset || !modelId) return
    if (preset === null && autoExpandedForModel !== modelId) {
      setIsOpen(true)
      setAutoExpandedForModel(modelId)
    }
  }, [loadingPreset, preset, modelId, autoExpandedForModel])

  // ── Sync JSON editor when switching to the JSON tab or when modelId changes ──
  useEffect(() => {
    if (activeTab !== 'json') return
    if (jsonLoadedForModel.current === modelId) return

    const entry = {
      contextWindow: effective.contextWindow,
      maxOutputTokens: effective.maxOutputTokens,
      vision: effective.vision,
      thinking: effective.thinking,
      // Spelled out even when unset, so the field is discoverable here.
      reasoningEffort: effective.reasoningEffort ?? DEFAULT_REASONING_EFFORT
    }
    setJsonText(JSON.stringify(entry, null, 2))
    setJsonError(null)
    setJsonWarning(null)
    jsonLoadedForModel.current = modelId
  }, [activeTab, modelId, effective])

  // ── Handle tab switching ───────────────────────────────────────────────
  const handleTabChange = (tab: ActiveTab) => {
    setActiveTab(tab)
    setJsonError(null)
    setJsonWarning(null)
  }

  // ── Visual field helpers ───────────────────────────────────────────────
  const updateField = <K extends keyof ModelCapabilityOverride>(
    field: K,
    value: ModelCapabilityOverride[K]
  ) => {
    const next: ModelCapabilityOverride = { ...userOverride, [field]: value }
    onChange({ ...overrides, [modelId]: next })
    // Reset JSON "loaded" marker so it re-syncs on next tab switch
    jsonLoadedForModel.current = ''
  }

  const handleNumberField = (field: 'contextWindow' | 'maxOutputTokens', raw: string) => {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n) || n < 0) return
    updateField(field, n)
  }

  const handleBoolField = (field: 'vision' | 'thinking', checked: boolean) => {
    updateField(field, checked)
  }

  const handleReasoningEffortField = (value: string) => {
    if (value) {
      updateField('reasoningEffort', value)
      return
    }
    // Empty = "use Halo's default": drop the key rather than store a level.
    const { reasoningEffort: _cleared, ...rest } = userOverride
    const next = { ...overrides }
    if (Object.keys(rest).length > 0) next[modelId] = rest
    else delete next[modelId]
    onChange(next)
    jsonLoadedForModel.current = ''
  }

  // ── JSON editor helpers ────────────────────────────────────────────────
  const handleJsonBlur = () => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>
    } catch {
      setJsonError(t('Invalid JSON — changes not saved'))
      return
    }

    const next: ModelCapabilityOverride = {}
    if (typeof parsed.contextWindow === 'number') next.contextWindow = parsed.contextWindow
    if (typeof parsed.maxOutputTokens === 'number') next.maxOutputTokens = parsed.maxOutputTokens
    if (typeof parsed.vision === 'boolean') next.vision = parsed.vision
    if (typeof parsed.thinking === 'boolean') next.thinking = parsed.thinking
    if (typeof parsed.reasoningEffort === 'string' && parsed.reasoningEffort) {
      next.reasoningEffort = parsed.reasoningEffort
    }

    // The recognized fields above are saved either way; an unknown key is
    // reported so a mistyped one does not look accepted.
    const ignored = Object.keys(parsed).filter(
      (key) => !(EDITABLE_CAPABILITY_KEYS as readonly string[]).includes(key)
    )
    setJsonError(null)
    setJsonWarning(
      ignored.length > 0
        ? t('Unsupported field(s) ignored: {{fields}}', { fields: ignored.join(', ') })
        : null
    )
    onChange({ ...overrides, [modelId]: next })
  }

  // ── Reset override ─────────────────────────────────────────────────────
  const handleReset = () => {
    const next = { ...overrides }
    delete next[modelId]
    onChange(next)
    setJsonError(null)
    setJsonWarning(null)
    jsonLoadedForModel.current = ''
  }

  // ── Preset info badge ──────────────────────────────────────────────────
  const renderPresetInfo = () => {
    if (loadingPreset) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" />
          {t('Loading preset...')}
        </div>
      )
    }

    if (preset) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="w-3 h-3 shrink-0" />
          <span>
            {t('Preset')}{': '}
            <span className="font-medium text-foreground">{preset.displayName || modelId}</span>
            {preset.provider && (
              <span> · {preset.provider}</span>
            )}
          </span>
        </div>
      )
    }

    return (
      <div className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
        <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
        <span>{t('No preset found — verify these values match your model')}</span>
      </div>
    )
  }

  // ── Main render ───────────────────────────────────────────────────────
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Collapse header */}
      <button
        onClick={() => setIsOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-secondary/40 hover:bg-secondary/60
                   transition-colors text-sm font-medium text-foreground"
      >
        <span>{t('Model Configuration')}</span>
        {isOpen
          ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
          : <ChevronRight className="w-4 h-4 text-muted-foreground" />
        }
      </button>

      {/* Collapsible body */}
      {isOpen && (
        <div className="p-3 space-y-3 border-t border-border bg-background">
          {/* Tab bar */}
          <div className="flex items-center justify-end gap-1">
            <button
              onClick={() => handleTabChange('visual')}
              className={`px-3 py-1 text-xs rounded-md font-medium transition-colors
                ${activeTab === 'visual'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                }`}
            >
              {t('Visual')}
            </button>
            <button
              onClick={() => handleTabChange('json')}
              className={`px-3 py-1 text-xs rounded-md font-medium transition-colors
                ${activeTab === 'json'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                }`}
            >
              JSON
            </button>
          </div>

          {/* ── Visual tab ── */}
          {activeTab === 'visual' && (
            <div className="space-y-3">
              {/* Context Window + Max Output: stacked on mobile, 2-col on sm */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {/* Context Window */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    {t('Context Window')}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={effective.contextWindow}
                      onChange={e => handleNumberField('contextWindow', e.target.value)}
                      className="flex-1 min-w-0 px-2.5 py-1.5 text-sm bg-input border border-border
                                 rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    <span className="text-xs text-muted-foreground shrink-0">{t('tokens')}</span>
                  </div>
                </div>

                {/* Max Output Tokens */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    {t('Max Output Tokens')}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={MAX_OUTPUT_TOKENS_HARD_MIN}
                      value={effective.maxOutputTokens}
                      onChange={e => handleNumberField('maxOutputTokens', e.target.value)}
                      className="flex-1 min-w-0 px-2.5 py-1.5 text-sm bg-input border border-border
                                 rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    <span className="text-xs text-muted-foreground shrink-0">{t('tokens')}</span>
                  </div>
                  {/* Quality warning — passed through to the SDK as-is, but the
                      compact-summary call may truncate. Mirrors the WARN in
                      sdk-config.resolveSdkRuntimeLimits. */}
                  {effective.maxOutputTokens > 0
                    && effective.maxOutputTokens < RECOMMENDED_MIN_MAX_OUTPUT_TOKENS && (
                      <div className="flex items-start gap-1.5 mt-1 text-xs text-amber-600 dark:text-amber-500">
                        <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
                        <span>
                          {t('Values below 20,000 may cause Claude Code\u2019s auto-compact summary to truncate (summary p99.99 ≈ 17,387 tokens).')}
                        </span>
                      </div>
                    )}
                </div>
              </div>

              {/* Feature toggles: side-by-side */}
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={effective.vision}
                    onChange={e => handleBoolField('vision', e.target.checked)}
                    className="w-4 h-4 rounded border-border accent-primary cursor-pointer"
                  />
                  <span className="text-sm text-foreground">{t('Vision')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={effective.thinking}
                    onChange={e => handleBoolField('thinking', e.target.checked)}
                    className="w-4 h-4 rounded border-border accent-primary cursor-pointer"
                  />
                  <span className="text-sm text-foreground">{t('Thinking')}</span>
                </label>
              </div>

              {/* Reasoning effort */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  {t('Reasoning Effort')}
                </label>
                <select
                  value={effortSelectValue}
                  onChange={e => handleReasoningEffortField(e.target.value)}
                  className="w-full sm:w-56 px-2.5 py-1.5 text-sm bg-input border border-border
                             rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <option value="">{t('Default')}</option>
                  {REASONING_EFFORT_LEVELS.map(level => (
                    <option key={level} value={level}>{effortLabels[level]}</option>
                  ))}
                  {isCustomEffort && (
                    <option value={effective.reasoningEffort}>{effective.reasoningEffort}</option>
                  )}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('How hard this model thinks while Deep Thinking is on.')}
                </p>
                {isCustomEffort && (
                  <div className="flex items-start gap-1.5 mt-1 text-xs text-amber-600 dark:text-amber-500">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
                    <span>
                      {t('Sent to the provider as-is — Halo cannot check whether this model accepts it.')}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── JSON tab ── */}
          {activeTab === 'json' && (
            <div className="space-y-1.5">
              <textarea
                value={jsonText}
                onChange={e => setJsonText(e.target.value)}
                onBlur={handleJsonBlur}
                rows={7}
                spellCheck={false}
                className="w-full px-3 py-2 text-xs font-mono bg-input border border-border
                           rounded-lg text-foreground resize-none
                           focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              {jsonError && (
                <p className="text-xs text-red-500">{jsonError}</p>
              )}
              {jsonWarning && (
                <div className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
                  <span>{jsonWarning}</span>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t('Edit JSON then click outside to apply. Unrecognized fields are ignored.')}
              </p>
            </div>
          )}

          {/* Footer: preset info + reset */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between pt-1 border-t border-border">
            {renderPresetInfo()}
            {hasOverride && (
              <button
                onClick={handleReset}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground
                           transition-colors shrink-0"
              >
                <RotateCcw className="w-3 h-3" />
                {t('Reset to preset')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
