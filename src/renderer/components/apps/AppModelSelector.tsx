/**
 * AppModelSelector
 *
 * Per-app model selector that lets users override which AI model an app uses.
 * Reusable in both AppConfigPanel (settings) and AppInstallDialog (install flow).
 *
 * Design:
 *   - Default: "Follow global" — uses whatever the user has selected globally
 *   - Override: pick a specific source + model from configured AI sources
 *   - Inline dropdown (no modal), consistent with the Runtime section in AppConfigPanel
 *   - Shows recommended_model hint from spec if present
 */

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Brain, Check, X } from 'lucide-react'
import { useAppStore } from '../../stores/app.store'
import {
  getCurrentSource,
  getCurrentModelName,
  AVAILABLE_MODELS,
  type AISourcesConfig,
  type AISource,
  type ModelOption,
} from '../../types'
import { isAnthropicProvider } from '../../types'
import { useTranslation } from '../../i18n'

// ============================================
// Types
// ============================================

interface AppModelSelectorProps {
  /** Currently selected source ID (undefined = follow global) */
  modelSourceId?: string
  /** Currently selected model ID within that source */
  modelId?: string
  /** Optional recommendation text from spec author */
  recommendedModel?: string
  /** Called when user changes model selection */
  onChange: (sourceId: string | undefined, modelId: string | undefined) => void
}

// ============================================
// Helpers
// ============================================

/** Get available models for a source (same logic as ModelSelector) */
function getModelsForSource(source: AISource): ModelOption[] {
  if (source.availableModels && source.availableModels.length > 0) {
    return source.availableModels
  }
  if (isAnthropicProvider(source.provider)) {
    return AVAILABLE_MODELS
  }
  if (source.model) {
    return [{ id: source.model, name: source.model }]
  }
  return []
}

/** Get display name for a source */
function getSourceDisplayName(source: AISource, t: (s: string) => string): string {
  if (source.name) return source.name
  if (source.authType === 'oauth') return 'OAuth Provider'
  if (isAnthropicProvider(source.provider)) return 'Claude API'
  return t('Custom API')
}

/** Resolve the display label for the current selection */
function resolveSelectionLabel(
  aiSources: AISourcesConfig,
  modelSourceId: string | undefined,
  modelId: string | undefined,
  t: (s: string) => string
): string {
  if (!modelSourceId) {
    // Follow global
    const globalModelName = getCurrentModelName(aiSources)
    return `${t('Follow global')} (${globalModelName})`
  }

  const source = aiSources.sources.find(s => s.id === modelSourceId)
  if (!source) return t('Follow global')

  const models = getModelsForSource(source)
  const effectiveModelId = modelId || source.model
  const model = models.find(m => m.id === effectiveModelId)
  const modelName = model?.name || effectiveModelId

  return `${getSourceDisplayName(source, t)} / ${modelName}`
}

// ============================================
// Component
// ============================================

export function AppModelSelector({
  modelSourceId,
  modelId,
  recommendedModel,
  onChange,
}: AppModelSelectorProps) {
  const { t } = useTranslation()
  const { config } = useAppStore()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [expandedSection, setExpandedSection] = useState<string | null>(null)

  // Get aiSources config
  const aiSources: AISourcesConfig = config?.aiSources?.version === 2
    ? config.aiSources
    : { version: 2, currentId: null, sources: [] }

  // Close when clicking outside
  useEffect(() => {
    if (!isOpen) return

    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timeoutId)
      document.removeEventListener('click', handleClickOutside)
    }
  }, [isOpen])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  // Auto-expand the currently selected source section when opening
  useEffect(() => {
    if (isOpen) {
      setExpandedSection(modelSourceId || null)
    }
  }, [isOpen])

  const selectionLabel = resolveSelectionLabel(aiSources, modelSourceId, modelId, t)
  const hasOverride = !!modelSourceId

  const handleSelectGlobal = () => {
    onChange(undefined, undefined)
    setIsOpen(false)
  }

  const handleSelectModel = (sourceId: string, selectedModelId: string) => {
    onChange(sourceId, selectedModelId)
    setIsOpen(false)
  }

  const handleClearOverride = (e: React.MouseEvent) => {
    e.stopPropagation()
    onChange(undefined, undefined)
  }

  if (!config || aiSources.sources.length === 0) {
    return null
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Brain className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-sm text-foreground">{t('Model')}</span>
      </div>

      {/* Recommended model hint */}
      {recommendedModel && (
        <p className="text-xs text-muted-foreground italic">
          {t('Author recommends')}: {recommendedModel}
        </p>
      )}

      {/* Selector trigger */}
      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={`w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg border transition-colors ${
            hasOverride
              ? 'bg-primary/5 border-primary/30 text-foreground'
              : 'bg-secondary border-border text-muted-foreground'
          } hover:border-primary/50`}
        >
          <span className="truncate">{selectionLabel}</span>
          <div className="flex items-center gap-1 flex-shrink-0 ml-2">
            {hasOverride && (
              <button
                onClick={handleClearOverride}
                className="p-0.5 hover:bg-secondary rounded transition-colors"
                title={t('Reset to global')}
              >
                <X className="w-3 h-3" />
              </button>
            )}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </div>
        </button>

        {/* Dropdown */}
        {isOpen && (
          <div className="absolute left-0 right-0 top-full mt-1 bg-card border border-border rounded-xl shadow-lg z-50 py-1 max-h-[300px] overflow-y-auto">
            {/* Follow global option */}
            <button
              onClick={handleSelectGlobal}
              className={`w-full px-3 py-2.5 text-left text-sm hover:bg-secondary/80 transition-colors flex items-center gap-2 ${
                !hasOverride ? 'text-primary' : 'text-foreground'
              }`}
            >
              {!hasOverride ? <Check className="w-3 h-3 flex-shrink-0" /> : <span className="w-3" />}
              <div className="min-w-0">
                <div className="truncate">{t('Follow global')}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {getCurrentModelName(aiSources)}
                </div>
              </div>
            </button>

            <div className="border-t border-border/50 my-0.5" />

            {/* Per-source model lists */}
            {aiSources.sources.map(source => {
              const isExpanded = expandedSection === source.id
              const isSelectedSource = modelSourceId === source.id
              const models = getModelsForSource(source)
              const displayName = getSourceDisplayName(source, t)

              return (
                <div key={source.id}>
                  <div
                    className={`px-3 py-2 text-xs font-medium flex items-center justify-between cursor-pointer hover:bg-secondary/50 transition-colors ${
                      isSelectedSource ? 'text-primary' : 'text-muted-foreground'
                    }`}
                    onClick={() => setExpandedSection(prev => prev === source.id ? null : source.id)}
                  >
                    <div className="flex items-center gap-2">
                      <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      <span>{displayName}</span>
                    </div>
                    {isSelectedSource && (
                      <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                    )}
                  </div>

                  {isExpanded && (
                    <div className="bg-secondary/10 pb-1">
                      {models.map(model => {
                        const mid = typeof model === 'string' ? model : model.id
                        const mname = typeof model === 'string' ? model : (model.name || model.id)
                        const isSelected = isSelectedSource && (modelId || source.model) === mid

                        return (
                          <button
                            key={mid}
                            onClick={() => handleSelectModel(source.id, mid)}
                            className={`w-full px-3 py-2.5 text-left text-sm hover:bg-secondary/80 transition-colors flex items-center gap-2 pl-8 ${
                              isSelected ? 'text-primary' : 'text-foreground'
                            }`}
                          >
                            {isSelected ? <Check className="w-3 h-3 flex-shrink-0" /> : <span className="w-3" />}
                            <span className="truncate">{mname}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}

                  <div className="border-t border-border/50" />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Description text */}
      <p className="text-xs text-muted-foreground">
        {hasOverride
          ? t('This app uses a dedicated model, independent of the global selection')
          : t('Uses the globally selected model. Change in the header model selector.')}
      </p>
    </div>
  )
}
