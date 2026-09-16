/**
 * ModelConfigPanel
 *
 * Displays and edits per-model capability overrides stored in AISource.modelOverrides.
 *
 * Effective values are resolved authoritatively by
 * `modelCapabilitiesService.resolve()` on the backend (`base` below), so this
 * component never guesses a fallback of its own and what it shows is what the
 * running Claude Code subprocess gets. See shared/types/model-capabilities.ts
 * for the priority chain.
 *
 * Visual tab  — form fields showing effective (merged) values.
 * JSON tab    — raw JSON of the stored override only, so opening the tab and
 *               clicking away cannot freeze resolved values into an override.
 *
 * Edits write into overrides[modelId], reduced to fields that actually differ
 * from `base`. "Reset to preset" deletes overrides[modelId].
 */

import { useState, useEffect, useRef } from 'react'
import { ChevronDown, ChevronRight, RotateCcw, Info, AlertTriangle, Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type {
  CatalogModelCapability,
  ModelCapability,
  ModelCapabilityOverride,
  ResolvedModelCapability
} from '../../../shared/types/model-capabilities'
import {
  normalizeModelCapabilityOverride,
  validateModelCapabilityOverride
} from '../../../shared/model-capability-overrides'
import {
  MAX_OUTPUT_TOKENS_HARD_MIN,
  RECOMMENDED_MIN_MAX_OUTPUT_TOKENS,
} from '../../../shared/constants/model-runtime-limits'
import {
  REASONING_EFFORT_LEVELS,
  isReasoningEffortLevel,
  type ReasoningEffortLevel,
} from '../../../shared/constants/reasoning-effort'

interface ModelConfigPanelProps {
  /** Currently selected model ID */
  modelId: string
  /** All model overrides for this AISource (read-only input) */
  overrides: Record<string, ModelCapabilityOverride>
  /** Called whenever overrides should change */
  onChange: (overrides: Record<string, ModelCapabilityOverride>) => void
  catalogCapability?: CatalogModelCapability
  /** `ModelOption.supportsVision` for this model, when the source states one. */
  catalogSupportsVision?: boolean
}

type ActiveTab = 'visual' | 'json'

export function ModelConfigPanel({
  modelId,
  overrides,
  onChange,
  catalogCapability,
  catalogSupportsVision
}: ModelConfigPanelProps) {
  const { t } = useTranslation()

  // ── Collapse state (auto-expand when neither preset nor catalog data exists) ──
  const [isOpen, setIsOpen] = useState(false)
  const [autoExpandedForModel, setAutoExpandedForModel] = useState<string>('')

  // ── Preset data (badge only) + resolved base (authoritative effective values) ──
  const [preset, setPreset] = useState<ModelCapability | null>(null)
  const [base, setBase] = useState<ModelCapability | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)

  // ── Tab state ──────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>('visual')

  // ── JSON editor state ──────────────────────────────────────────────────
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [jsonWarning, setJsonWarning] = useState<string | null>(null)
  const jsonLoadedForModel = useRef<string>('')

  // ── Compute effective values ───────────────────────────────────────────
  // Priority: override > base (backend-resolved: catalog > preset > default)
  const overrideValidation = validateModelCapabilityOverride(overrides[modelId])
  const userOverride = overrideValidation.valid ? overrideValidation.value : {}
  const effective: ResolvedModelCapability | null = base ? { ...base, ...userOverride } : null
  const hasOverride = Object.keys(userOverride).length > 0
  const catalogContextWindow = catalogCapability?.contextWindow
  const catalogMaxOutputTokens = catalogCapability?.maxOutputTokens
  const hasCatalogData = catalogContextWindow !== undefined || catalogMaxOutputTokens !== undefined
  const canEnableExtendedContext = (effective?.contextWindow ?? 0) > 200_000

  // ── Reasoning effort presentation ──────────────────────────────────────
  const effortSelectValue = effective?.reasoningEffort ?? ''
  /** A provider-specific level typed in the JSON tab, kept selectable here. */
  const isCustomEffort = !!effective?.reasoningEffort
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

  useEffect(() => {
    if (!modelId) return

    let cancelled = false
    setLoading(true)
    setPreset(null)
    setBase(null)
    setLoadError(null)
    setJsonError(null)
    setJsonWarning(null)

    Promise.all([
      api.modelCapabilitiesGetPreset(modelId),
      api.modelCapabilitiesResolve(modelId, undefined, catalogCapability, catalogSupportsVision)
    ])
      .then(([presetResponse, baseResponse]) => {
        if (cancelled) return
        if (!presetResponse.success || !baseResponse.success || !baseResponse.data) {
          throw new Error(presetResponse.error || baseResponse.error || 'Capability data unavailable')
        }
        setPreset((presetResponse.data as ModelCapability | null) ?? null)
        setBase(baseResponse.data as ModelCapability)
      })
      .catch(error => {
        if (cancelled) return
        console.error('[ModelConfigPanel] Failed to load model capabilities:', error)
        setLoadError(t('Failed to load model capabilities'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
    // Keyed on the catalog's primitive fields rather than the object: a caller
    // passing an inline `catalogCapability={{ ... }}` would otherwise give this
    // effect a new identity on every parent render, turning it into
    // fetch → setState → new object → fetch.
  }, [modelId, catalogContextWindow, catalogMaxOutputTokens, catalogSupportsVision, loadAttempt, t])

  // ── Auto-expand when there is no preset AND no catalog data (so the user
  // sees the fallback values that most need double-checking) ──────────────
  useEffect(() => {
    if (loading || !modelId) return
    if (preset === null && !hasCatalogData && autoExpandedForModel !== modelId) {
      setIsOpen(true)
      setAutoExpandedForModel(modelId)
    }
  }, [loading, preset, hasCatalogData, modelId, autoExpandedForModel])

  useEffect(() => {
    if (activeTab !== 'json' || !effective) return
    if (jsonLoadedForModel.current === modelId) return

    setJsonText(JSON.stringify(userOverride, null, 2))
    setJsonError(null)
    setJsonWarning(null)
    jsonLoadedForModel.current = modelId
  }, [activeTab, modelId, effective, userOverride])

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
    if (!base) return
    const nextOverride = normalizeModelCapabilityOverride(
      { ...userOverride, [field]: value },
      base
    )
    const nextOverrides = { ...overrides }
    if (Object.keys(nextOverride).length > 0) nextOverrides[modelId] = nextOverride
    else delete nextOverrides[modelId]
    onChange(nextOverrides)
    jsonLoadedForModel.current = ''
  }

  const handleNumberField = (field: 'contextWindow' | 'maxOutputTokens', raw: string) => {
    const n = Number(raw)
    if (!Number.isSafeInteger(n) || n <= 0) return
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
    const { reasoningEffort: _cleared, ...rest } = userOverride
    const nextOverrides = { ...overrides }
    if (Object.keys(rest).length > 0) nextOverrides[modelId] = rest
    else delete nextOverrides[modelId]
    onChange(nextOverrides)
    jsonLoadedForModel.current = ''
  }

  const handleJsonBlur = () => {
    if (!base) return

    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      setJsonError(t('Invalid JSON — changes not saved'))
      return
    }

    const validation = validateModelCapabilityOverride(parsed)
    if (!validation.valid) {
      setJsonError(t('Invalid model capability values — changes not saved'))
      return
    }

    const nextOverride = normalizeModelCapabilityOverride(validation.value, base)
    const nextOverrides = { ...overrides }
    if (Object.keys(nextOverride).length > 0) nextOverrides[modelId] = nextOverride
    else delete nextOverrides[modelId]

    setJsonError(null)
    setJsonWarning(
      validation.ignoredKeys.length > 0
        ? t('Unsupported field(s) ignored: {{fields}}', { fields: validation.ignoredKeys.join(', ') })
        : null
    )
    setJsonText(JSON.stringify(nextOverride, null, 2))
    onChange(nextOverrides)
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

  // ── Preset / catalog info badge ─────────────────────────────────────────
  const renderPresetInfo = () => {
    if (loading) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" />
          {t('Loading preset...')}
        </div>
      )
    }

    if (loadError) return null

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

    if (hasCatalogData) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="w-3 h-3 shrink-0" />
          <span>{t('Detected from the provider\u2019s model catalog')}</span>
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
          {loading ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              {t('Loading model capabilities...')}
            </div>
          ) : loadError || !effective ? (
            <div className="flex flex-col items-start gap-2 py-2 text-xs text-destructive">
              <span>{loadError || t('Failed to load model capabilities')}</span>
              <button
                type="button"
                onClick={() => setLoadAttempt(attempt => attempt + 1)}
                className="text-primary hover:underline"
              >
                {t('Retry')}
              </button>
            </div>
          ) : (
            <>
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
                  {t('JSON')}
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

                  {canEnableExtendedContext && !/\[1m\]$/i.test(modelId) && (
                    <div>
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={userOverride.extendedContext === true}
                          onChange={e => updateField('extendedContext', e.target.checked)}
                          className="w-4 h-4 rounded border-border accent-primary cursor-pointer"
                        />
                        <span className="text-sm text-foreground">{t('Enable context above 200K')}</span>
                      </label>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('May require provider access and may change pricing. Only enable it when your plan supports this context window.')}
                      </p>
                      {userOverride.extendedContext !== true && (
                        <div className="flex items-start gap-1.5 mt-1 text-xs text-amber-600 dark:text-amber-500">
                          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
                          <span>
                            {t('Until this is enabled, the context window above is capped at 200,000 tokens.')}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

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
            </>
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
