/**
 * ModelSelector - Dropdown for selecting AI model in header (v2)
 * - Desktop: Dropdown menu from button
 * - Mobile: Bottom sheet for better touch interaction
 *   (ModelSelectSheet is exported for reuse, e.g. MobileOverflowMenu)
 *
 * Design: Uses v2 AISourcesConfig format with sources array
 */

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, ChevronRight, Plus, Sparkles, X, Check, RefreshCw } from 'lucide-react'
import { useAppStore } from '../../stores/app.store'
import { useAppsStore } from '../../stores/apps.store'
import { useChatStore, selectActiveConversationId, useIsGenerating } from '../../stores/chat.store'
import { useActiveModelTarget, type ActiveModelTarget } from '../../hooks/useActiveModelTarget'
import { openPersonModelSettings } from '../../utils/people-navigation'
import { api } from '../../api'
import {
  getModelDisplayName,
  resolveModelSelection,
  getSourceAccountName,
  AVAILABLE_MODELS,
  GROUP_MODEL_ID,
  type AIGroup,
  type AISourcesConfig,
  type AISource,
  type Conversation,
  type ModelOption
} from '../../types'
import { ThinkingLevelControl } from './ThinkingLevelControl'
import { ConversationEngineSection } from './ConversationEngineSelector'
import { GroupModelCard } from '../ai-groups/GroupModelCard'
import { GroupRouteStatus } from '../ai-groups/GroupRouteStatus'
import { AutoTag, GroupIcon } from '../ai-groups/group-parts'
import { groupTitle } from '../ai-groups/group-text'
import {
  groupModels,
  ModelAvailabilityNotice,
  ModelBadgePill,
  ModelGroupHeading,
  ModelNotice,
  ModelOfferFacts,
  ModelRowLabel
} from './model-list-parts'
import { useTranslation } from '../../i18n'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useDismiss } from '../../hooks/useDismiss'
import { useFreshModelCatalogs } from '../../hooks/useFreshModelCatalogs'
import { useConversationGroupRoute } from '../../hooks/useConversationGroupRoute'
import { useConversationEngineId } from '../../hooks/useConversationEngine'
import { openGroupEditor } from '../../utils/group-navigation'
import { getEngineSourceCompatibility } from '../../../shared/engine-source'
import { trackHome } from '../../services/home-telemetry'
import { isAnthropicProvider } from '../../types'
import { validateModelCapabilityOverride } from '../../../shared/model-capability-overrides'

/** Read v2 aiSources config with empty fallback */
function useAiSources(): AISourcesConfig {
  const config = useAppStore(s => s.config)
  return config?.aiSources?.version === 2
    ? config.aiSources
    : { version: 2, currentId: null, sources: [] }
}

/**
 * The regular conversation whose model pin the selector reflects and mutates.
 * Null when none is active, it isn't cached yet, or a digital human is on
 * screen — a digital human's model is edited in its own settings, so this list
 * has nothing to write to then.
 */
function useCurrentConversation(): Conversation | null {
  const target = useActiveModelTarget()
  return target.kind === 'conversation' ? target.conversation : null
}

/**
 * The one choice a group offers. A group a conversation's engine cannot use, or
 * one with no models left, says so here instead of failing after a send. Mounted
 * only for an open group, so nobody else pays for the engine lookup.
 */
function GroupChoiceRow({ group, selected, conversationId, spaceId, engineOverride, onChoose }: {
  group: AIGroup
  selected: boolean
  conversationId: string | null
  spaceId: string | null
  engineOverride?: Conversation['engineOverride']
  onChoose: () => void
}) {
  const { t } = useTranslation()
  const liveEngine = useConversationEngineId(conversationId, spaceId)
  const engine = engineOverride ?? liveEngine
  const blocked = engine ? !getEngineSourceCompatibility(engine, { isGroup: true }).compatible : false
  const empty = group.members.length === 0
  const disabled = blocked || empty
  return (
    <>
      <button
        disabled={disabled}
        onClick={onChoose}
        className={`w-full flex items-center gap-2 rounded-md py-2 pl-7 pr-2.5 text-left text-[13px] transition-colors ease-halo ${
          disabled ? 'cursor-not-allowed text-muted-foreground opacity-60' : 'text-foreground hover:bg-secondary'
        } ${selected ? 'bg-secondary/60 font-medium' : ''}`}
      >
        <GroupIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{t('Choose automatically')}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{t('{{count}} models', { count: group.members.length })}</span>
        {selected && <Check className="w-3.5 h-3.5 shrink-0 text-primary" />}
      </button>
      {blocked && (
        <ModelNotice tone="warning" className="py-1 pl-7 pr-2.5">
          {t('Codex cannot use a load-balancing group. Choose a single model account or another engine.')}
        </ModelNotice>
      )}
      {empty && !blocked && (
        <ModelNotice tone="warning" className="py-1 pl-7 pr-2.5">
          {t('This group has no models left. Edit it to add some before using it.')}
        </ModelNotice>
      )}
    </>
  )
}

/**
 * Model list content (sources accordion + footer actions).
 * Shared by the desktop dropdown and the mobile bottom sheet.
 * Calls onDone when a selection/action should close the container.
 */
function ModelList({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const { config, setConfig, navigate } = useAppStore()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshStatus, setRefreshStatus] = useState<'success' | 'cached' | 'failed' | null>(null)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const spaceId = useChatStore(state => state.currentSpaceId)
  useFreshModelCatalogs(true)

  const aiSources = useAiSources()

  // The checkmark follows what the conversation runs on: its own pin, or the
  // global selection when it has none or the pinned account was removed.
  const target = useActiveModelTarget()
  const conversationId = target.kind === 'conversation' ? target.conversationId : null
  const currentConversation = target.kind === 'conversation' ? target.conversation : null
  const selected = resolveModelSelection(aiSources, currentConversation)
  const groups = aiSources.groups ?? []
  const chosenGroup = aiSources.currentGroupId ? groups.find(group => group.id === aiSources.currentGroupId) : undefined

  // State for expanded sections (accordion)
  const [expandedSection, setExpandedSection] = useState<string | null>(selected.source?.id ?? selected.group?.id ?? null)

  const toggleSection = (sourceId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setExpandedSection(prev => prev === sourceId ? null : sourceId)
  }

  if (!config) return null

  // Handle model selection.
  // 1. Pin the choice to the current conversation (Cursor-style — only this
  //    conversation is affected; its session rebuilds lazily on next send).
  // 2. Update the global "last-used" selection so newly created conversations
  //    inherit this choice and non-pinned surfaces keep a sensible default.
  const handleSelectModel = async (sourceId: string, modelId: string) => {
    trackHome('home.composer.model', { action: 'select', kind: 'conversation' })
    // 1. Persist the per-conversation pin
    const chat = useChatStore.getState()
    const spaceId = chat.currentSpaceId
    if (spaceId && conversationId) {
      await chat.setConversationModel(spaceId, conversationId, sourceId, modelId)
    }

    // 2. Update the global last-used selection (source first if needed, then
    //    model). Picking an account also leaves a chosen group, which the
    //    switch clears even when the account is already the current one.
    if (aiSources.currentId !== sourceId || chosenGroup) {
      const switchResult = await api.aiSourcesSwitchSource(sourceId)
      if (!switchResult.success) {
        console.error('[ModelSelector] Failed to switch source:', switchResult.error)
        onDone()
        return
      }
    }
    const result = await api.aiSourcesSetModel(modelId)
    if (result.success && result.data) {
      setConfig({ ...config, aiSources: result.data as AISourcesConfig })
    }
    onDone()
  }

  // A group is one choice: the conversation is pinned to it and new chats
  // start on it; which account answers is the router's decision per request.
  const handleSelectGroup = async (group: AIGroup) => {
    trackHome('home.composer.model', { action: 'select', kind: 'conversation' })
    setSelectionError(null)
    const chat = useChatStore.getState()
    const spaceId = chat.currentSpaceId
    if (spaceId && conversationId) {
      const saved = await chat.setConversationModel(spaceId, conversationId, group.id, GROUP_MODEL_ID)
      if (!saved) {
        console.warn('[ModelSelector] Group selection not applied because the conversation pin was not saved', { conversationId, groupId: group.id })
        setSelectionError(t('The group selection could not be saved. Please try again.'))
        return
      }
    }
    const switchResult = await api.aiSourcesSwitchSource(group.id)
    if (switchResult.success && switchResult.data) {
      setConfig({ ...config, aiSources: switchResult.data as AISourcesConfig })
    } else {
      console.error('[ModelSelector] Failed to choose group:', switchResult.error)
    }
    onDone()
  }

  // Handle add source
  const handleAddSource = () => {
    onDone()
    navigate('settings')
  }

  // Refresh model lists for all sources from remote APIs
  const handleRefreshModels = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isRefreshing) return

    setIsRefreshing(true)
    setRefreshStatus(null)
    try {
      const result = await api.refreshAISourcesConfig()
      if (result.success && result.data) {
        const latestConfig = useAppStore.getState().config
        if (latestConfig) setConfig({ ...latestConfig, aiSources: (result.data as any).aiSources as AISourcesConfig })
        setRefreshStatus(result.modelRefresh?.failedSourceIds.length
          ? 'failed'
          : result.modelRefresh?.degradedSourceIds.length ? 'cached' : 'success')
      } else {
        setRefreshStatus('failed')
        console.warn('[ModelSelector] Refresh failed:', result.error)
      }
    } catch (error) {
      setRefreshStatus('failed')
      console.error('[ModelSelector] Failed to refresh models:', error)
    } finally {
      setIsRefreshing(false)
    }
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

  return (
    <>
      {/* Iterate all configured sources */}
      {aiSources.sources.map(source => {
        const isExpanded = expandedSection === source.id
        const isActiveSource = !chosenGroup && aiSources.currentId === source.id
        const models = getModelsForSource(source)
        const displayName = getSourceDisplayName(source)

        const userName = getSourceAccountName(source)

        return (
          <div key={source.id} className="px-1.5 pb-1.5">
            {/* Group header: toggles its models. Picking a model is what
                switches sources, so the header carries no separate control. */}
            <button
              type="button"
              onClick={(e) => toggleSection(source.id, e)}
              aria-expanded={isExpanded}
              title={userName ? `${displayName} · ${userName}` : displayName}
              className={`w-full flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs hover:bg-secondary hover:text-foreground transition-colors ease-halo ${
                isExpanded ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ease-halo ${isExpanded ? 'rotate-90' : ''}`} />
              <span className="min-w-0 flex-1 truncate text-left">
                <span className="font-medium">{displayName}</span>
                {userName && <span className="text-subtle-foreground"> · {userName}</span>}
              </span>
              {isActiveSource && <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-primary" title={t('Active')} />}
            </button>

            {isExpanded && (
              <>
                {selected.source?.id === source.id && (
                  <ModelAvailabilityNotice source={source} modelId={selected.modelId} className="py-1 pl-7 pr-2.5" />
                )}
                {groupModels(models).map(section => (
                  <div key={section.group ?? 'vendor'}>
                    {section.group && <ModelGroupHeading group={section.group} className="pl-7 pr-2.5" />}
                    {section.models.map(model => {
                      const isSelected = selected.source?.id === source.id && selected.modelId === model.id
                      return (
                        <button
                          key={model.id}
                          onClick={() => handleSelectModel(source.id, model.id)}
                          className={`w-full flex items-center gap-2 rounded-md py-2 pl-7 pr-2.5 text-left text-[13px] transition-colors ease-halo hover:bg-secondary ${
                            isSelected ? 'bg-secondary/60 font-medium text-foreground' : 'text-foreground'
                          }`}
                        >
                          <ModelRowLabel model={model} />
                          {isSelected && <Check className="w-3.5 h-3.5 shrink-0 text-primary" />}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </>
            )}
          </div>
        )
      })}

      {/* Load-balancing groups sit at the same level as accounts, and offer one choice each. */}
      {groups.map(group => {
        const isExpanded = expandedSection === group.id
        const isSelected = selected.group?.id === group.id
        return (
          <div key={group.id} className="px-1.5 pb-1.5">
            <button
              type="button"
              onClick={(e) => toggleSection(group.id, e)}
              aria-expanded={isExpanded}
              title={groupTitle(group.name, t)}
              className={`w-full flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs hover:bg-secondary hover:text-foreground transition-colors ease-halo ${
                isExpanded ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ease-halo ${isExpanded ? 'rotate-90' : ''}`} />
              <span className="min-w-0 flex-1 truncate text-left font-medium">{group.name}</span>
              <AutoTag />
              {chosenGroup?.id === group.id && <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-primary" title={t('Active')} />}
            </button>

            {isExpanded && (
              <GroupChoiceRow
                group={group}
                selected={isSelected}
                conversationId={conversationId}
                spaceId={spaceId}
                engineOverride={currentConversation?.engineOverride}
                onChoose={() => handleSelectGroup(group)}
              />
            )}
          </div>
        )
      })}

      {selectionError && <p role="alert" className="px-3 py-2 text-xs text-destructive">{selectionError}</p>}

      {refreshStatus && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {refreshStatus === 'cached'
            ? t('Could not fetch the latest model catalog for some providers. Using cached and built-in models.')
            : refreshStatus === 'failed'
              ? t('Some model lists could not be refreshed. Please try again.')
              : t('Models refreshed successfully.')}
        </p>
      )}

      {currentConversation && spaceId && <ConversationEngineSection key={currentConversation.id} conversation={currentConversation} spaceId={spaceId} />}

      {/* Footer: Add/Manage source + Refresh */}
      {aiSources.sources.length === 0 ? (
        <button
          onClick={handleAddSource}
          className="w-full px-3 py-3 text-left text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors flex items-center gap-2"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('Configure AI Source')}
        </button>
      ) : (
        <div className="mt-1 flex items-center justify-between border-t border-border-faint px-4 pt-2.5 pb-1.5">
          <button
            onClick={handleAddSource}
            className="text-left text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-2"
          >
            <Plus className="w-3 h-3" />
            {t('Manage AI Provider')}
          </button>
          <button
            onClick={handleRefreshModels}
            disabled={isRefreshing}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors rounded disabled:opacity-50"
            title={t('Refresh Models')}
          >
            <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      )}
    </>
  )
}

/**
 * Mobile bottom sheet for model selection.
 * Manages its own exit animation, then calls onClose.
 */
export function ModelSelectSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [isAnimatingOut, setIsAnimatingOut] = useState(false)

  const { name: modelName, model: currentModel, group: currentGroup } = useConversationModel()
  const currentModelName = currentGroup ? groupTitle(modelName, t) : modelName

  const handleClose = () => {
    setIsAnimatingOut(true)
    setTimeout(onClose, 200)
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
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
          bg-card rounded-t-2xl border-t border-border-faint
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
        <div className="px-4 py-2 border-b border-border-faint flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="w-5 h-5 shrink-0 text-primary" />
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-foreground">{t('Select Model')}</h3>
              <p className="text-xs text-muted-foreground break-words">{currentModelName}</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="shrink-0 p-2 hover:bg-secondary rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-border-faint">
          <ConversationThinkingLevel />
        </div>

        {/* Model list */}
        <div className="overflow-auto" style={{ maxHeight: 'calc(60vh - 150px)' }}>
          {/* Inside the scrolling area: a taller fixed header would push the list's end off the sheet. */}
          <ModelOfferFacts model={currentModel} className="px-4 pt-3 pb-1" />
          {currentGroup && <SheetGroupRoute groupId={currentGroup.id} />}
          <ModelList onDone={handleClose} />
        </div>
      </div>
    </>
  )
}

/** Where the open conversation's group is sending it, at the top of the phone sheet; only mounted for a group. */
function SheetGroupRoute({ groupId }: { groupId: string }) {
  const conversation = useCurrentConversation()
  const route = useConversationGroupRoute(conversation, groupId)
  const live = useIsGenerating()
  return <GroupRouteStatus route={route} live={live} className="px-4 pt-3 pb-1" />
}

/** Where the group a digital human runs on is sending its chat; only mounted for a group, so nothing else pays for it. */
function DigitalHumanGroupRoute({ groupId }: { groupId: string }) {
  const activeConversationId = useChatStore(selectActiveConversationId)
  const sessionId = useChatStore(state => activeConversationId
    ? state.conversationCache.get(activeConversationId)?.engineBinding?.sessionId
    : undefined)
  const route = useConversationGroupRoute(activeConversationId ? { id: activeConversationId, sessionId } : null, groupId)
  const live = useIsGenerating()
  return <GroupRouteStatus route={route} live={live} center className="mt-2" />
}

/**
 * A digital human's model is set in its own settings, so its card is read-only
 * apart from how hard it thinks on this send, with a way to those settings.
 */
function DigitalHumanModelButton({ target }: { target: Extract<ActiveModelTarget, { kind: 'digital-human' }> }) {
  const { t } = useTranslation()
  const aiSources = useAiSources()
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // Its own account and model, or the global selection when it has none or
  // its account was removed — what its turns actually run on.
  const { source, modelId, own, group } = resolveModelSelection(aiSources, target)
  const plainName = getModelDisplayName(aiSources, target.modelSourceId, target.modelId)
  const modelName = group ? groupTitle(plainName, t) : plainName
  const app = useAppsStore(state => state.apps.find(a => a.id === target.appId))

  useDismiss(ref, isOpen, () => setIsOpen(false))

  return (
    <div className="relative flex items-center" ref={ref}>
      <button
        onClick={() => {
          if (!isOpen) trackHome('home.composer.model', { action: 'open', kind: 'digital_human' })
          setIsOpen(open => !open)
        }}
        className="h-8 flex items-center gap-1 pl-1.5 pr-2 rounded-sm text-xs text-foreground hover:bg-secondary transition-colors ease-halo"
        title={modelName}
        aria-label={modelName}
      >
        <Sparkles className="w-4 h-4 sm:hidden" />
        <span className="hidden sm:inline truncate max-w-[140px]">{modelName}</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <div className="absolute right-0 bottom-full mb-1 w-64 bg-card border border-border rounded-xl shadow-pop z-50 p-3">
          <div className="text-center text-xs text-muted-foreground">{t('{{name}} uses', { name: target.appName })}</div>
          <div className="mt-0.5 text-center text-[15px] font-semibold text-foreground break-words">{modelName}</div>
          {source && <ModelAvailabilityNotice source={source} modelId={modelId} withReplacement={!own} className="mt-2" />}
          {group && <DigitalHumanGroupRoute groupId={group.id} />}
          <div className="mt-3">
            {/* One level for the whole digital human, on every entry. */}
            <ThinkingLevelControl
              key={target.appId}
              value={app?.userOverrides?.chatReasoningEffort}
              configured={modelId ? source?.modelOverrides?.[modelId]?.reasoningEffort : undefined}
              onChange={level => {
                trackHome('home.composer.thinking', { level, kind: 'digital_human' })
                void useAppsStore.getState().updateAppOverrides(target.appId, { chatReasoningEffort: level })
              }}
            />
            <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
              {t('Also used for its IM replies and scheduled runs.')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              trackHome('home.composer.model', { action: 'settings', kind: 'digital_human' })
              setIsOpen(false)
              openPersonModelSettings(target.appId)
            }}
            className="mt-3 flex h-8 w-full items-center justify-center gap-1 rounded-sm border border-border text-xs text-foreground hover:bg-secondary transition-colors ease-halo"
          >
            {t('Change in its settings')}
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

export function ModelSelector() {
  const target = useActiveModelTarget()
  if (target.kind === 'digital-human') return <DigitalHumanModelButton target={target} />
  return <ConversationModelSelector />
}

/** Context sizes as users read them: 200K, 1M. */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  return `${Math.round(tokens / 1000)}K`
}

/**
 * The source and model the open conversation runs on: its pin, else the
 * global selection — also when the pinned account was removed.
 */
function useConversationModel() {
  const aiSources = useAiSources()
  const conversation = useCurrentConversation()
  const { source, modelId, group } = resolveModelSelection(aiSources, conversation)
  const model = source?.availableModels.find(m => m.id === modelId)
  const name = getModelDisplayName(aiSources, conversation?.modelSourceId, conversation?.modelId)
  const configuredEffort = modelId && source ? source.modelOverrides?.[modelId]?.reasoningEffort : undefined
  return { aiSources, source, modelId, model, name, group: group ?? null, configuredEffort }
}

/** The user's per-model settings win over the catalog, as they do at runtime; a malformed one is ignored there too. */
function resolveCardFacts(source: AISource | null | undefined, modelId: string | undefined, model: ModelOption | undefined) {
  const validation = validateModelCapabilityOverride(modelId ? source?.modelOverrides?.[modelId] : undefined)
  const override = validation.valid ? validation.value : undefined
  return {
    contextWindow: override?.contextWindow ?? model?.capabilities?.contextWindow,
    vision: override?.vision ?? model?.supportsVision
  }
}

/**
 * First step of the dropdown: what this conversation runs on, with switching
 * one click further. Facts the catalog doesn't report are left out.
 */
function CurrentModelCard({ onSwitch }: { onSwitch: () => void }) {
  const { t } = useTranslation()
  const navigate = useAppStore(state => state.navigate)
  const conversation = useCurrentConversation()
  const spaceId = useChatStore(state => state.currentSpaceId)
  const { aiSources, source, modelId, model, name, group } = useConversationModel()
  const { contextWindow, vision } = resolveCardFacts(source, modelId, model)
  // The card shows cost and offers that change over time, like the list.
  useFreshModelCatalogs(true)

  if (group) {
    return <GroupConversationCard group={group} sources={aiSources.sources} conversation={conversation} spaceId={spaceId} onSwitch={onSwitch} />
  }

  // Nothing to run on: no account at all, or none selected.
  if (!source) {
    const hasSources = aiSources.sources.length > 0
    return (
      <div className="p-3">
        <p className="text-sm text-foreground break-words">
          {hasSources ? t('No model selected') : t('No AI sources configured')}
        </p>
        <button
          type="button"
          onClick={hasSources ? onSwitch : () => navigate('settings')}
          className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg bg-secondary/60 px-3 py-2 text-sm text-foreground hover:bg-secondary transition-colors ease-halo"
        >
          {hasSources ? t('Select Model') : t('Configure AI Source')}
          <ChevronRight className="w-4 h-4 shrink-0" />
        </button>
      </div>
    )
  }

  return (
    <div className="p-3">
      {/* The name is the way into the list — shaded like a picker field so it
          reads as clickable before hover. */}
      <button
        type="button"
        onClick={onSwitch}
        title={t('Switch model')}
        className="group flex w-full items-center gap-2 rounded-lg bg-secondary/60 px-3 py-2 text-left hover:bg-secondary transition-colors ease-halo"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold text-foreground">{name}</span>
            {model && <ModelBadgePill model={model} />}
          </span>
          <span className="mt-0.5 truncate text-xs text-muted-foreground">{source.name}</span>
        </span>
        <ChevronRight className="w-4 h-4 shrink-0 text-subtle-foreground group-hover:text-foreground transition-colors ease-halo" />
      </button>
      <ModelAvailabilityNotice source={source} modelId={modelId} className="mt-2 px-1.5" />
      <dl className="mt-2 space-y-1.5 px-1.5 text-xs">
        {contextWindow ? (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t('Context window')}</dt>
            <dd className="tabular-nums text-foreground">{formatContextWindow(contextWindow)}</dd>
          </div>
        ) : null}
        {vision !== undefined && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t('Image input')}</dt>
            <dd className="text-foreground">{vision ? t('Supported') : t('Not supported')}</dd>
          </div>
        )}
      </dl>
      <ModelOfferFacts model={model} className="mt-1.5 px-1.5" />
      <div className="mt-3 px-1.5">
        <ConversationThinkingLevel />
      </div>
      {conversation && spaceId && <div className="mt-3"><ConversationEngineSection key={conversation.id} conversation={conversation} spaceId={spaceId} /></div>}
    </div>
  )
}

/** The card for a conversation on a group; it alone follows the router's reports. */
function GroupConversationCard({ group, sources, conversation, spaceId, onSwitch }: {
  group: AIGroup
  sources: AISource[]
  conversation: Conversation | null
  spaceId: string | null
  onSwitch: () => void
}) {
  const route = useConversationGroupRoute(conversation, group.id)
  const live = useIsGenerating()
  return (
    <GroupModelCard
      group={group}
      sources={sources}
      route={route}
      live={live}
      onSwitch={onSwitch}
      onEdit={() => openGroupEditor(group.id)}
    >
      <div className="mt-3 px-1.5">
        <ConversationThinkingLevel />
      </div>
      {conversation && spaceId && <div className="mt-3"><ConversationEngineSection key={conversation.id} conversation={conversation} spaceId={spaceId} /></div>}
    </GroupModelCard>
  )
}

/** The slider bound to the open conversation, saved on it. */
function ConversationThinkingLevel() {
  const { configuredEffort } = useConversationModel()
  const target = useActiveModelTarget()
  const conversationId = target.kind === 'conversation' ? target.conversationId : null
  const conversation = target.kind === 'conversation' ? target.conversation : null
  const spaceId = useChatStore(state => state.currentSpaceId)
  return (
    <ThinkingLevelControl
      key={conversationId ?? 'none'}
      value={conversation?.reasoningEffort}
      configured={configuredEffort}
      onChange={spaceId && conversationId
        ? level => {
          trackHome('home.composer.thinking', { level, kind: 'conversation' })
          void useChatStore.getState().setConversationReasoningEffort(spaceId, conversationId, level)
        }
        : level => { trackHome('home.composer.thinking', { level, kind: 'conversation' }) }}
    />
  )
}

function ConversationModelSelector() {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const config = useAppStore(s => s.config)
  const [isOpen, setIsOpen] = useState(false)
  // Desktop opens on the current-model card; the list is one step further.
  const [showList, setShowList] = useState(false)
  const [maxHeight, setMaxHeight] = useState<number>()
  const dropdownRef = useRef<HTMLDivElement>(null)

  const { name: modelName, group: currentGroup } = useConversationModel()
  const currentModelName = currentGroup ? groupTitle(modelName, t) : modelName

  // The mobile sheet handles its own dismissal.
  useDismiss(dropdownRef, isOpen && !isMobile, () => setIsOpen(false))

  if (!config) return null

  const toggle = () => {
    if (!isOpen) trackHome('home.composer.model', { action: 'open', kind: 'conversation' })
    if (!isOpen && dropdownRef.current) {
      // It opens upward, so it may use only the room above the trigger.
      const above = dropdownRef.current.getBoundingClientRect().top - 12
      setMaxHeight(Math.max(160, Math.min(above, window.innerHeight * 0.6)))
    }
    setShowList(false)
    setIsOpen(!isOpen)
  }

  return (
    <div className="relative flex items-center" ref={dropdownRef}>
      {/* Icon only on mobile, text on desktop. Borderless so the header stays
          quiet; the fill appears on hover. */}
      <button
        onClick={toggle}
        className="h-8 flex items-center gap-1 pl-1.5 pr-2 rounded-sm text-xs text-foreground hover:bg-secondary transition-colors ease-halo"
        title={currentModelName}
        aria-label={currentModelName}
      >
        {/* Mobile: show Sparkles icon (a group has its own glyph) */}
        {currentGroup ? <GroupIcon className="w-4 h-4 sm:hidden" /> : <Sparkles className="w-4 h-4 sm:hidden" />}
        {/* Desktop: model name; a group keeps its own name and a steady "Auto" mark, whichever model is serving */}
        <div className="hidden sm:flex items-center gap-1.5 min-w-0">
          <span className={`truncate ${currentGroup ? 'max-w-[110px]' : 'max-w-[140px]'}`}>{currentGroup ? modelName : currentModelName}</span>
          {currentGroup && <AutoTag />}
        </div>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown/Bottom Sheet */}
      {isOpen && (
        isMobile ? (
          <ModelSelectSheet onClose={() => setIsOpen(false)} />
        ) : (
          <div
            className={`absolute right-0 bottom-full mb-1 w-72 bg-card border border-border rounded-xl shadow-pop z-50 overflow-y-auto ${showList ? 'py-1.5' : ''}`}
            style={{ maxHeight }}
          >
            {showList
              ? <ModelList onDone={() => setIsOpen(false)} />
              : <CurrentModelCard onSwitch={() => {
                  trackHome('home.composer.model', { action: 'list', kind: 'conversation' })
                  setShowList(true)
                }} />}
          </div>
        )
      )}
    </div>
  )
}
