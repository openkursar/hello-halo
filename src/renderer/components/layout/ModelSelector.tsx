/**
 * ModelSelector - Dropdown for selecting AI model in header (v2)
 * - Desktop: Dropdown menu from button
 * - Mobile: Bottom sheet for better touch interaction
 *
 * Design: Uses v2 AISourcesConfig format with sources array
 */

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Plus, Sparkles, X, Check } from 'lucide-react'
import { useAppStore } from '../../stores/app.store'
import { api } from '../../api'
import {
  getCurrentModelName,
  getCurrentSource,
  AVAILABLE_MODELS,
  type HaloConfig,
  type AISourcesConfig,
  type AISource,
  type ModelOption
} from '../../types'
import { useTranslation } from '../../i18n'
import { useIsMobile } from '../../hooks/useIsMobile'
import { isAnthropicProvider } from '../../types'

export function ModelSelector() {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const { config, setConfig, setView } = useAppStore()
  const [isOpen, setIsOpen] = useState(false)
  const [isAnimatingOut, setIsAnimatingOut] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // State for expanded sections (accordion)
  const [expandedSection, setExpandedSection] = useState<string | null>(null)

  // Get v2 aiSources config
  const aiSources: AISourcesConfig = config?.aiSources?.version === 2
    ? config.aiSources
    : { version: 2, currentId: null, sources: [] }

  // Get current source
  const currentSource = getCurrentSource(aiSources)

  // Initialize expanded section to current source when opening
  useEffect(() => {
    if (isOpen && currentSource) {
      setExpandedSection(currentSource.id)
    }
  }, [isOpen, currentSource?.id])

  const toggleSection = (sourceId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setExpandedSection(prev => prev === sourceId ? null : sourceId)
  }

  // Close dropdown when clicking outside (desktop only)
  useEffect(() => {
    if (!isOpen || isMobile) return

    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    // Use setTimeout to avoid the click event that opened the dropdown
    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timeoutId)
      document.removeEventListener('click', handleClickOutside)
    }
  }, [isOpen, isMobile])

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        handleClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  const handleClose = () => {
    if (isMobile) {
      setIsAnimatingOut(true)
      setTimeout(() => {
        setIsOpen(false)
        setIsAnimatingOut(false)
      }, 200)
    } else {
      setIsOpen(false)
    }
  }

  if (!config) return null

  // Get current model display name
  const currentModelName = getCurrentModelName(aiSources)

  // Handle model selection for a source
  const handleSelectModel = async (sourceId: string, modelId: string) => {
    const newSources = aiSources.sources.map(s =>
      s.id === sourceId
        ? { ...s, model: modelId, updatedAt: new Date().toISOString() }
        : s
    )

    const newAiSources: AISourcesConfig = {
      version: 2,
      currentId: sourceId,
      sources: newSources
    }

    await api.setConfig({ aiSources: newAiSources })
    setConfig({ ...config, aiSources: newAiSources })
    handleClose()
  }

  // Handle switching source only (keeps last selected model for that source)
  const handleSwitchSource = async (sourceId: string, e: React.MouseEvent) => {
    e.stopPropagation()

    if (aiSources.currentId === sourceId) return

    const newAiSources: AISourcesConfig = {
      ...aiSources,
      currentId: sourceId
    }

    await api.setConfig({ aiSources: newAiSources })
    setConfig({ ...config, aiSources: newAiSources })
    handleClose()
  }

  // Handle add source
  const handleAddSource = () => {
    handleClose()
    setView('settings')
  }

  // Get available models for a source
  const getModelsForSource = (source: AISource): ModelOption[] => {
    // If source has its own available models (user fetched or configured), use them
    if (source.availableModels && source.availableModels.length > 0) {
      return source.availableModels
    }

    // For Anthropic providers without custom models, use predefined defaults
    if (isAnthropicProvider(source.provider)) {
      return AVAILABLE_MODELS
    }

    // Fallback: return current model as single option
    if (source.model) {
      return [{ id: source.model, name: source.model }]
    }

    return []
  }

  // Get display name for source
  const getSourceDisplayName = (source: AISource): string => {
    if (source.name) return source.name
    if (source.authType === 'oauth') return 'OAuth Provider'
    if (isAnthropicProvider(source.provider)) return 'Claude API'
    return t('Custom API')
  }

  // Render model list
  const renderModelList = () => (
    <>
      {/* Iterate all configured sources */}
      {aiSources.sources.map(source => {
        const isExpanded = expandedSection === source.id
        const isActiveSource = aiSources.currentId === source.id
        const models = getModelsForSource(source)
        const displayName = getSourceDisplayName(source)

        return (
          <div key={source.id}>
            <div
              className={`px-3 py-2 text-xs font-medium flex items-center justify-between cursor-pointer hover:bg-secondary/50 transition-colors ${isActiveSource ? 'text-primary' : 'text-muted-foreground'}`}
              onClick={(e) => toggleSection(source.id, e)}
            >
              <div className="flex items-center gap-2">
                <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                <span>{displayName}</span>
                {source.authType === 'oauth' && source.user?.name && (
                  <span className="text-xs text-muted-foreground">({source.user.name})</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isActiveSource ? (
                  <span className="w-2.5 h-2.5 rounded-full bg-primary" title={t('Active')} />
                ) : (
                  <button
                    onClick={(e) => handleSwitchSource(source.id, e)}
                    className="w-2.5 h-2.5 rounded-full border border-muted-foreground hover:border-primary hover:bg-primary/20 transition-colors"
                    title={t('Switch to this source')}
                  />
                )}
              </div>
            </div>

            {isExpanded && (
              <div className="bg-secondary/10 pb-1">
                {models.map((model) => {
                  const modelId = typeof model === 'string' ? model : model.id
                  const modelName = typeof model === 'string' ? model : (model.name || model.id)
                  const isSelected = isActiveSource && source.model === modelId

                  return (
                    <button
                      key={modelId}
                      onClick={() => handleSelectModel(source.id, modelId)}
                      className={`w-full px-3 py-3 text-left text-sm hover:bg-secondary/80 transition-colors flex items-center gap-2 pl-8 ${
                        isSelected ? 'text-primary' : 'text-foreground'
                      }`}
                    >
                      {isSelected ? <Check className="w-3 h-3" /> : <span className="w-3" />}
                      {modelName}
                    </button>
                  )
                })}
              </div>
            )}
            <div className="border-t border-border/50" />
          </div>
        )
      })}

      {/* Add source button */}
      {aiSources.sources.length === 0 ? (
        <button
          onClick={handleAddSource}
          className="w-full px-3 py-3 text-left text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors flex items-center gap-2"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('Add AI Provider')}
        </button>
      ) : (
        <button
          onClick={handleAddSource}
          className="w-full px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors flex items-center gap-2"
        >
          <Plus className="w-3 h-3" />
          {t('Manage AI Provider')}
        </button>
      )}
    </>
  )

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger Button - icon only on mobile, text on desktop */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 rounded-lg transition-colors"
        title={currentModelName}
      >
        {/* Mobile: show Sparkles icon */}
        <Sparkles className="w-4 h-4 sm:hidden" />
        {/* Desktop: show model name */}
        <span className="hidden sm:inline max-w-[140px] truncate">{currentModelName}</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown/Bottom Sheet */}
      {isOpen && (
        <>
          {isMobile ? (
            /* Mobile: Bottom Sheet */
            <>
              {/* Backdrop */}
              <div
                onClick={handleClose}
                className={`fixed inset-0 bg-black/40 z-40 ${isAnimatingOut ? 'animate-fade-out' : 'animate-fade-in'}`}
                style={{ animationDuration: '0.2s' }}
              />

              <div
                className={`
                  fixed inset-x-0 bottom-0 z-50
                  bg-card rounded-t-2xl border-t border-border/50
                  shadow-2xl overflow-hidden
                  ${isAnimatingOut ? 'animate-slide-out-bottom' : 'animate-slide-in-bottom'}
                `}
                style={{ maxHeight: '60vh' }}
              >
                {/* Drag handle */}
                <div className="flex justify-center py-2">
                  <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
                </div>

                {/* Header */}
                <div className="px-4 py-2 border-b border-border/50 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-primary" />
                    <div>
                      <h3 className="text-base font-semibold text-foreground">{t('Select Model')}</h3>
                      <p className="text-xs text-muted-foreground">{currentModelName}</p>
                    </div>
                  </div>
                  <button
                    onClick={handleClose}
                    className="p-2 hover:bg-secondary rounded-lg transition-colors"
                  >
                    <X className="w-5 h-5 text-muted-foreground" />
                  </button>
                </div>

                {/* Model list */}
                <div className="overflow-auto" style={{ maxHeight: 'calc(60vh - 80px)' }}>
                  {renderModelList()}
                </div>
              </div>
            </>
          ) : (
            /* Desktop: Dropdown Menu */
            <div className="absolute right-0 top-full mt-1 w-64 bg-card border border-border rounded-xl shadow-lg z-50 py-1 max-h-[60vh] overflow-y-auto">
              {renderModelList()}
            </div>
          )}
        </>
      )}
    </div>
  )
}
