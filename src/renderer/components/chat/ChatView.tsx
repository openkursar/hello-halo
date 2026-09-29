/**
 * Chat View - the one chat page, for space conversations and digital-human
 * conversations alike.
 *
 * What differs between the two is decided by the chat store's conversation
 * sources, not here; this component only reads the conversation on screen
 * (`selectActiveConversationId`) and a few presentation flags derived from its
 * kind (composer placeholder, hidden capability controls, header of the empty
 * state). Uses session-based state for multi-conversation support and supports
 * onboarding mode with mock AI response.
 *
 * Layout modes:
 * - Full width (isCompact=false): Centered content with max-width
 * - Compact mode (isCompact=true): Sidebar-style when Canvas is open
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { ReactNode } from 'react'
import { SquareCheckBig, Code, Bot, FileText, BookOpen, AlertCircle } from 'lucide-react'
import logoOnDark from '../../assets/brand/halo-logo-icon-on-dark.svg'
import logoOnLight from '../../assets/brand/halo-logo-icon-on-light.svg'
import { useSpaceStore } from '../../stores/space.store'
import { useChatStore, selectActiveConversationId, conversationKind, digitalHumanAppId } from '../../stores/chat.store'
import { useAppsStore } from '../../stores/apps.store'
import { useOnboardingStore } from '../../stores/onboarding.store'
import { useTaskPanelStore } from '../../stores/taskPanel.store'
import { MessageList } from './MessageList'
import type { MessageListHandle } from './MessageList'
import { InputArea } from './InputArea'
import { useConversationMentionCandidates } from './cross-conversation'
import { TeamCollabPanel } from './team-collab'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { Sparkles } from '../icons/ToolIcons'
import {
  ONBOARDING_ARTIFACT_NAME,
  getOnboardingAiResponse,
  getOnboardingHtmlArtifact,
  getOnboardingPrompt,
} from '../onboarding/onboardingData'
import { api } from '../../api'
import type { ImageAttachment, Artifact } from '../../types'
import type { SlashCommandItem } from '../../types/slash-command'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { ClearChatControl } from './ClearChatControl'
import { useWsRecovery } from '../../hooks/useWsRecovery'
import { useSpaceDigitalHumans } from '../../hooks/useSpaceDigitalHumans'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { getAppChatConversationId } from '../../api/_shared'
import type { DigitalHumanSelectorConfig } from './DigitalHumanSelector'
import { useGoalComposer } from '../goal'
import { showsMessageList } from './conversation-body'
import type { GoalInput } from '../../../shared/types/goal'
import { isConversationCollabEnabled } from '../../../shared/apps/app-types'

interface ChatViewProps {
  isCompact?: boolean
}

export function ChatView({ isCompact = false }: ChatViewProps) {
  const { t } = useTranslation()
  const { currentSpace } = useSpaceStore()
  // Subscriptions are per field on purpose. The chat store is the shared
  // real-time bus for every conversation in the app — digital humans and team
  // members included — so subscribing to the whole store would re-render this
  // whole page on every token of every background turn. Actions are stable
  // references; only the fields read below can trigger a render, and the live
  // turn arrives through `session` further down.
  const getSession = useChatStore(s => s.getSession)
  const sessionInitInfo = useChatStore(s => s.sessionInitInfo)
  const sendMessage = useChatStore(s => s.sendMessage)
  const stopGeneration = useChatStore(s => s.stopGeneration)
  const injectMessage = useChatStore(s => s.injectMessage)
  const continueAfterInterrupt = useChatStore(s => s.continueAfterInterrupt)
  const answerQuestion = useChatStore(s => s.answerQuestion)
  const loadMessageThoughts = useChatStore(s => s.loadMessageThoughts)
  const loadEarlierMessages = useChatStore(s => s.loadEarlierMessages)
  const refreshConversation = useChatStore(s => s.refreshConversation)
  const openConversation = useChatStore(s => s.openConversation)
  const currentSpaceId = useChatStore(s => s.currentSpaceId)
  const selectAppChatConversation = useChatStore(s => s.selectAppChatConversation)
  const clearAppChatSelection = useChatStore(s => s.clearAppChatSelection)

  // ── Digital-human selection ──
  const selectedAppChat = useChatStore(
    s => (currentSpaceId ? s.spaceStates.get(currentSpaceId)?.selectedAppChat ?? null : null)
  )
  const activeConversationId = useChatStore(selectActiveConversationId)
  const isDigitalHuman = !!activeConversationId && conversationKind(activeConversationId) === 'digital-human'
  const activeAppId = activeConversationId ? digitalHumanAppId(activeConversationId) : null
  const activeApp = useAppsStore(s => activeAppId ? s.apps.find(app => app.id === activeAppId) : undefined)
  const activeAppName = activeApp ? resolveSpecI18n(activeApp.spec, getCurrentLanguage()).name || activeApp.id : undefined
  // The roster, not the conversation list: a digital human you have never
  // talked to has no conversation rows but still has to be selectable.
  const spaceDigitalHumans = useSpaceDigitalHumans(currentSpaceId ?? null)
  const digitalHumanOptions = useMemo(
    () => spaceDigitalHumans.map(app => ({
      appId: app.id,
      name: resolveSpecI18n(app.spec, getCurrentLanguage()).name || app.id,
      status: app.status ?? 'active',
    })),
    [spaceDigitalHumans]
  )

  // Onboarding state
  const {
    isActive: isOnboarding,
    currentStep,
    nextStep,
    setMockAnimating,
    setMockThinking,
    isMockAnimating,
    isMockThinking
  } = useOnboardingStore()

  // Mock onboarding state
  const [mockUserMessage, setMockUserMessage] = useState<string | null>(null)
  const [mockAiResponse, setMockAiResponse] = useState<string | null>(null)
  const [mockStreamingContent, setMockStreamingContent] = useState<string>('')
  // Artifact list for @ mention suggestions in InputArea
  const [mentionArtifacts, setMentionArtifacts] = useState<Artifact[]>([])
  // Sibling candidate source for the same @ menu: conversations in this space
  const mentionConversations = useConversationMentionCandidates()
  // Tracks the space a fetch was issued for, so stale responses (after a space
  // switch) can be discarded instead of overwriting the current list.
  const mentionSpaceIdRef = useRef<string | undefined>(undefined)

  // Load artifacts for @ mention suggestions (depth=5 for deeper file references)
  const loadMentionArtifacts = useCallback(async () => {
    const spaceId = currentSpace?.id
    mentionSpaceIdRef.current = spaceId
    if (!spaceId) {
      setMentionArtifacts([])
      return
    }
    try {
      const response = await api.listArtifacts(spaceId, 5)
      if (mentionSpaceIdRef.current !== spaceId) return
      if (response.success && response.data) {
        setMentionArtifacts(response.data as Artifact[])
      }
    } catch (error) {
      if (mentionSpaceIdRef.current === spaceId) {
        console.error('[ChatView] Failed to load mention artifacts:', error)
      }
    }
  }, [currentSpace?.id])

  // Initial load and reload when the active space changes
  useEffect(() => {
    loadMentionArtifacts()
  }, [loadMentionArtifacts])

  // Keep the @ mention list in sync with filesystem changes. Files created by
  // external tools (e.g. Claude Code) after the space opened must appear without
  // requiring a space switch. The backend already debounces watcher events; a
  // short debounce here coalesces bursts into a single refresh.
  useEffect(() => {
    const spaceId = currentSpace?.id
    if (!spaceId) return

    // Ensure the watcher is active even when the Artifact Rail is not mounted
    // (chat runs full-width with no Canvas open). initArtifactWatcher is idempotent.
    api.initArtifactWatcher(spaceId).catch(error => {
      console.error('[ChatView] Failed to init artifact watcher:', error)
    })

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleReload = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(loadMentionArtifacts, 300)
    }

    const cleanup = api.onArtifactChanged(event => {
      if (event.spaceId !== spaceId) return
      // Content-only edits don't alter the file list; only structural changes
      // (create/delete/rename) affect @ mention candidates.
      if (event.type === 'change') return
      scheduleReload()
    })

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      cleanup()
    }
  }, [currentSpace?.id, loadMentionArtifacts])

  // Clear mock state when onboarding completes
  useEffect(() => {
    if (!isOnboarding) {
      setMockUserMessage(null)
      setMockAiResponse(null)
      setMockStreamingContent('')
    }
  }, [isOnboarding])

  const messageListRef = useRef<MessageListHandle>(null)

  // Scroll-to-bottom button visibility — driven by MessageList's at-bottom state
  const [showScrollButton, setShowScrollButton] = useState(false)
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setShowScrollButton(!atBottom)
  }, [])

  // Handle search result navigation - scroll to message and highlight search term.
  // MessageList mounts the message if it is in unloaded history, then the
  // highlight is applied to its DOM once rendered.
  useEffect(() => {
    const handleNavigateToMessage = (event: Event) => {
      const customEvent = event as CustomEvent<{ messageId: string; query: string }>
      const { messageId, query } = customEvent.detail

      console.log(`[ChatView] Attempting to navigate to message: ${messageId}`)

      // Remove previous highlights from all messages
      document.querySelectorAll('.search-highlight').forEach(el => {
        el.classList.remove('search-highlight')
      })
      document.querySelectorAll('.search-term-highlight').forEach(el => {
        const textNode = document.createTextNode(el.textContent || '')
        el.replaceWith(textNode)
      })

      if (!messageListRef.current?.scrollToMessage(messageId, 'smooth')) {
        console.warn(`[ChatView] Message not found in transcript for ID: ${messageId}`)
        return
      }

      // Wait for the message to mount and scroll into place, then apply DOM highlighting
      const applyHighlight = (retries = 0) => {
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`)
        if (!messageElement) {
          if (retries < 10) {
            setTimeout(() => applyHighlight(retries + 1), 100)
          } else {
            console.warn(`[ChatView] Message element not found after scrollToIndex for ID: ${messageId}`)
          }
          return
        }

        console.log(`[ChatView] Found message element, highlighting`)

        // Add highlight animation
        messageElement.classList.add('search-highlight')
        setTimeout(() => {
          messageElement.classList.remove('search-highlight')
        }, 2000)

        // Highlight search terms in the message (simple text highlight)
        const contentElement = messageElement.querySelector('[data-message-content]')
        if (contentElement && query) {
          try {
            const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
            const originalHTML = contentElement.innerHTML

            if (!originalHTML.includes('search-term-highlight')) {
              contentElement.innerHTML = originalHTML.replace(
                regex,
                '<mark class="search-term-highlight bg-yellow-400/30 font-semibold rounded px-0.5">$1</mark>'
              )
              console.log(`[ChatView] Highlighted search term: "${query}"`)
            }
          } catch (error) {
            console.error(`[ChatView] Error highlighting search term:`, error)
          }
        }
      }

      // Small delay to allow the scroll to start and the row to render
      setTimeout(() => applyHighlight(), 150)
    }

    // Clear all search highlights when requested
    const handleClearHighlights = () => {
      console.log(`[ChatView] Clearing all search highlights`)
      document.querySelectorAll('.search-highlight').forEach(el => {
        el.classList.remove('search-highlight')
      })
      document.querySelectorAll('.search-term-highlight').forEach(el => {
        const textNode = document.createTextNode(el.textContent || '')
        el.replaceWith(textNode)
      })
    }

    window.addEventListener('search:navigate-to-message', handleNavigateToMessage)
    window.addEventListener('search:clear-highlights', handleClearHighlights)
    return () => {
      window.removeEventListener('search:navigate-to-message', handleNavigateToMessage)
      window.removeEventListener('search:clear-highlights', handleClearHighlights)
    }
  }, [])

  // The conversation on screen and its live turn. `getSession('')` is the
  // store's own empty-session constant — a stable identity for "no session
  // yet", so the fallback does not look like a change to anything downstream.
  const currentConversation = useChatStore(s =>
    activeConversationId ? s.conversationCache.get(activeConversationId) ?? null : null
  )
  const isLoadingConversation = useChatStore(s => s.isLoadingConversation)
  const loadError = useChatStore(s => activeConversationId ? s.conversationLoadErrors.get(activeConversationId) ?? null : null)
  const session = useChatStore(s => s.sessions.get(activeConversationId ?? '')) ?? getSession('')
  const { isGenerating, streamingContent, isStreaming, thoughts, isThinking, compactInfo, error, errorType, textBlockVersion, pendingQuestion } = session

  // A digital-human conversation is not in the space index, so "loading" is
  // simply "not read yet and no read has failed".
  const isLoading = isDigitalHuman
    ? !currentConversation && !loadError
    : isLoadingConversation && !currentConversation

  // A digital-human conversation on screen but not in the cache (evicted while
  // the space was left, or never read) is read in again. Reads are deduplicated
  // by the source, and a failed one shows its error instead of retrying here.
  const isDigitalHumanUncached = isDigitalHuman && !currentConversation && !loadError
  useEffect(() => {
    if (isDigitalHumanUncached && activeConversationId) void openConversation(activeConversationId)
  }, [isDigitalHumanUncached, activeConversationId, openConversation])

  // Lazy loader for a message's separated thoughts, bound to the active
  // space + conversation ids. Passed to MessageList's thoughtsLoader prop.
  const thoughtsLoader = useCallback(
    (messageId: string) =>
      currentSpaceId && activeConversationId
        ? loadMessageThoughts(currentSpaceId, activeConversationId, messageId)
        : Promise.resolve([]),
    [loadMessageThoughts, currentSpaceId, activeConversationId]
  )

  // Older messages exist beyond what is loaded (digital-human transcripts are paged).
  const hasEarlier = !!currentConversation?.earlier?.hasMore
  const handleLoadEarlier = useCallback(() => {
    if (activeConversationId) void loadEarlierMessages(activeConversationId)
  }, [activeConversationId, loadEarlierMessages])

  // Events during a dropped connection are gone: re-read what is on screen.
  useWsRecovery(useCallback(() => {
    if (activeConversationId) void refreshConversation(activeConversationId)
  }, [activeConversationId, refreshConversation]))

  // ── Digital-human selector wiring ──
  // Locking reads the active conversation's own session so switching is
  // blocked mid-reply no matter which side (Halo or a digital human) is
  // currently generating.
  const digitalHumanSelectorLocked = useChatStore(s => {
    const active = s.sessions.get(activeConversationId ?? '')
    return !!active && (active.isGenerating || active.queuedMessages.length > 0)
  })
  const digitalHumanSelector: DigitalHumanSelectorConfig | undefined = currentSpaceId ? {
    current: selectedAppChat?.appId ?? null,
    options: digitalHumanOptions,
    locked: digitalHumanSelectorLocked,
    onChange: (appId, conversationId) => {
      if (!currentSpaceId) return
      if (appId === null) {
        void clearAppChatSelection(currentSpaceId)
      } else {
        selectAppChatConversation(currentSpaceId, appId, conversationId ?? getAppChatConversationId(appId))
      }
    },
  } : undefined

  const sendWithGoal = useCallback(
    (content: string, images: ImageAttachment[] | undefined, thinkingEnabled: boolean, goal: GoalInput) =>
      sendMessage(content, images, thinkingEnabled, { goal }),
    [sendMessage]
  )
  // Goals belong to space conversations; a digital human keeps none.
  const goalComposer = useGoalComposer({
    spaceId: currentSpaceId,
    conversationId: isDigitalHuman ? null : activeConversationId,
    draftKey: activeConversationId ?? undefined,
    isGenerating,
    send: sendWithGoal,
  })

  // Build the slash-command list for the autocomplete menu.
  // Only reads from SDK slash_commands array.
  // Commands are categorized as 'skill' if they appear in the skills array, otherwise 'builtin'.
  const slashCommands = useMemo<SlashCommandItem[]>(() => {
    const initInfo = activeConversationId ? sessionInitInfo.get(activeConversationId) : null

    const items: SlashCommandItem[] = []
    const itemsByCommand = new Map<string, SlashCommandItem>()

    const addItem = (item: SlashCommandItem) => {
      if (!itemsByCommand.has(item.command)) {
        itemsByCommand.set(item.command, item)
        items.push(item)
      }
    }

    // SDK slash_commands - categorize based on skills array
    if (initInfo?.slashCommands) {
      const skillsSet = new Set(initInfo.skills || [])

      initInfo.slashCommands.forEach((cmd) => {
        const category = skillsSet.has(cmd) ? 'skill' : 'builtin'
        addItem({
          id: `${category}-${cmd}`,
          command: `/${cmd}`,
          label: cmd,
          category,
        })
      })
    }

    return items
  }, [sessionInitInfo, activeConversationId])

  const onboardingPrompt = getOnboardingPrompt(t)
  const onboardingResponse = getOnboardingAiResponse(t)
  const onboardingHtml = getOnboardingHtmlArtifact(t)

  // Handle mock onboarding send
  const handleOnboardingSend = useCallback(async () => {
    if (!currentSpace) return

    // Step 1: Show user message immediately
    setMockUserMessage(onboardingPrompt)

    // Step 2: Start "thinking" phase (2.5 seconds) - no spotlight during this time
    setMockThinking(true)
    setMockAnimating(true)
    await new Promise(resolve => setTimeout(resolve, 2000))
    setMockThinking(false)

    // Step 3: Stream mock AI response
    const response = onboardingResponse
    for (let i = 0; i <= response.length; i++) {
      setMockStreamingContent(response.slice(0, i))
      await new Promise(resolve => setTimeout(resolve, 15))
    }

    // Step 4: Complete response
    setMockAiResponse(response)
    setMockStreamingContent('')

    // Step 5: Write the actual HTML file to disk BEFORE stopping animation
    // This ensures the file exists when ArtifactRail tries to load it
    try {
      await api.writeOnboardingArtifact(
        currentSpace.id,
        ONBOARDING_ARTIFACT_NAME,
        onboardingHtml
      )

      // Also save the conversation to disk
      await api.saveOnboardingConversation(currentSpace.id, onboardingPrompt, onboardingResponse)

      // Small delay to ensure file system has synced
      await new Promise(resolve => setTimeout(resolve, 200))
    } catch (err) {
      console.error('Failed to write onboarding artifact:', err)
    }

    // Step 6: Animation done
    // Note: Don't call nextStep() here - it's already called by Spotlight's handleHoleClick
    // We just need to stop the animation so the Spotlight can show the artifact
    setMockAnimating(false)
  }, [currentSpace, onboardingHtml, onboardingPrompt, onboardingResponse, setMockAnimating, setMockThinking])

  // Handle send (with optional images for multi-modal messages, optional thinking mode)
  const handleSend = async (content: string, images?: ImageAttachment[], thinkingEnabled?: boolean) => {
    // In onboarding mode, intercept and play mock response
    if (isOnboarding && currentStep === 'send-message') {
      handleOnboardingSend()
      return
    }

    // Can send if has text OR has images
    if ((!content.trim() && (!images || images.length === 0)) || isGenerating) return

    // Sending returns the reader to the end, wherever they were reading.
    messageListRef.current?.scrollToBottom('auto')
    return sendMessage(content, images, thinkingEnabled)
  }

  // Handle stop - stops the current conversation's generation
  const handleStop = async () => {
    if (activeConversationId) {
      await stopGeneration(activeConversationId)
    }
  }


  // Combine real messages with mock onboarding messages
  const realMessages = currentConversation?.messages || []
  const displayMessages = mockUserMessage
    ? [
        ...realMessages,
        { id: 'onboarding-user', role: 'user' as const, content: mockUserMessage, timestamp: new Date().toISOString() },
        ...(mockAiResponse
          ? [{ id: 'onboarding-ai', role: 'assistant' as const, content: mockAiResponse, timestamp: new Date().toISOString() }]
          : [])
      ]
    : realMessages

  const displayStreamingContent = mockStreamingContent || streamingContent
  const displayIsGenerating = isMockAnimating || isGenerating
  const displayIsThinking = isMockThinking || isThinking
  const displayIsStreaming = isStreaming  // Only real streaming (not mock)
  const hasMessages = showsMessageList({
    messageCount: displayMessages.length,
    streamingContent: displayStreamingContent,
    isThinking: displayIsThinking,
    error,
  })

  // Track previous compact state for smooth transitions
  const prevCompactRef = useRef(isCompact)
  const isTransitioningLayout = prevCompactRef.current !== isCompact

  useEffect(() => {
    prevCompactRef.current = isCompact
  }, [isCompact])

  // Full-takeover empty state: composer and suggestions centered on screen,
  // no docked input below — matches the prototype, where the composer only
  // sinks to a bottom dock once the first message is sent. Loading, compact
  // (canvas-open) and digital-human conversations keep the docked-input layout.
  const isFullTakeoverEmpty = !isCompact && !hasMessages && !isLoading && !isDigitalHuman

  const composerPlaceholder = isDigitalHuman
    ? (activeAppName ? t('Chat with {{name}}...', { name: activeAppName }) : t('Chat with this App...'))
    : isCompact ? t('Continue conversation...') : (currentSpace?.isTemp ? t('Say something to Halo...') : undefined)

  // Built once and handed to whichever position needs it (docked at the
  // bottom, or centered inline in the full-takeover empty state) — only one
  // of those two ever mounts at a time, so there's no duplicate instance,
  // just two possible slots for the same props. The key follows the
  // conversation, never its loading state, so opening one does not rebuild the
  // composer (and lose focus).
  const inputArea = (
    <InputArea
      key={activeConversationId ?? 'none'}
      onSend={handleSend}
      onInject={(content) => {
        if (activeConversationId) injectMessage(activeConversationId, content)
      }}
      onStop={handleStop}
      isGenerating={isGenerating}
      placeholder={composerPlaceholder}
      isCompact={isCompact}
      slashCommands={slashCommands}
      mentionArtifacts={mentionArtifacts}
      // A digital human's tools and knowledge live in its own settings; it can
      // only act on a reference to another conversation once collaboration is on.
      mentionConversations={isDigitalHuman && !(activeApp && isConversationCollabEnabled(activeApp)) ? undefined : mentionConversations}
      hideToolsetControls={isDigitalHuman}
      hideKnowledgeControls={isDigitalHuman}
      standalone={isFullTakeoverEmpty}
      digitalHumanSelector={digitalHumanSelector}
      draftKey={activeConversationId ?? undefined}
      goal={goalComposer}
    />
  )

  if (isFullTakeoverEmpty) {
    return (
      <div className="flex-1 flex flex-col h-full bg-background">
        <EmptyState
          // Prototype's chips fill the composer, they don't send — the user
          // reviews/edits the canned prompt before deciding to send it.
          onSuggestion={(prompt) => {
            if (currentSpaceId) useChatStore.setState({ pendingComposerInput: { spaceId: currentSpaceId, text: prompt } })
          }}
          composer={inputArea}
        />
      </div>
    )
  }

  return (
    <div
      className={`
        flex-1 flex flex-col h-full
        transition-[padding] duration-300 ease-out
        ${isCompact ? 'bg-background/50' : 'bg-background'}
      `}
    >
      {/* Messages area wrapper - relative for button positioning */}
      <div className="flex-1 relative overflow-hidden">
        {/* MessageList owns the scroll container. This wrapper itself isn't
            remounted on conversation switch (only its children are, via
            MessageList's own `key`), so the entrance animation plays once when
            the chat page first mounts — not on every switch. A transform on an
            ancestor doesn't affect the scroller's scrollHeight/clientHeight. */}
        <div
          className={`
            h-full animate-fade-up
            ${isLoading || loadError || !hasMessages ? (isCompact ? 'px-3' : 'px-6') : ''}
          `}
        >
          {isLoading ? (
            <LoadingState />
          ) : loadError && !currentConversation ? (
            <LoadFailedState
              message={loadError}
              onRetry={activeConversationId ? () => void refreshConversation(activeConversationId) : undefined}
            />
          ) : !hasMessages ? (
            <EmptyState
              isCompact
              message={isDigitalHuman
                ? (activeAppName
                  ? t('Send a message to start chatting with {{name}}', { name: activeAppName })
                  : t('Send a message to start chatting with this App'))
                : undefined}
            />
          ) : (
            <MessageList
              key={activeConversationId ?? 'empty'}
              ref={messageListRef}
              conversationId={activeConversationId ?? undefined}
              thoughtsLoader={thoughtsLoader}
              messages={displayMessages}
              streamingContent={displayStreamingContent}
              isGenerating={displayIsGenerating}
              isStreaming={displayIsStreaming}
              thoughts={thoughts}
              isThinking={displayIsThinking}
              compactInfo={compactInfo}
              error={error}
              errorType={errorType}
              onContinue={activeConversationId ? () => continueAfterInterrupt(activeConversationId) : undefined}
              onStop={handleStop}
              isCompact={isCompact}
              textBlockVersion={textBlockVersion}
              pendingQuestion={pendingQuestion}
              onAnswerQuestion={activeConversationId ? (answers) => answerQuestion(activeConversationId, answers) : undefined}
              onAtBottomStateChange={handleAtBottomStateChange}
              onLoadEarlier={hasEarlier ? handleLoadEarlier : undefined}
              footerExtra={isDigitalHuman
                ? (realMessages.length > 0 && !isGenerating && activeConversationId
                  ? <ClearChatControl conversationId={activeConversationId} />
                  : null)
                : <TeamCollabPanel conversationId={activeConversationId ?? undefined} />}
            />
          )}
        </div>

        {/* Scroll to bottom button - positioned outside scroll container */}
        <ScrollToBottomButton
          visible={showScrollButton && hasMessages}
          onClick={() => messageListRef.current?.scrollToBottom('auto')}
        />
      </div>

      {/* Input area */}
      {inputArea}
    </div>
  )
}

// Loading state component
function LoadingState() {
  const { t } = useTranslation()
  return (
    <div className="h-full flex flex-col items-center justify-center">
      <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      <p className="mt-3 text-sm text-muted-foreground">{t('Loading conversation...')}</p>
    </div>
  )
}

function LoadFailedState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-center max-w-sm mx-auto">
      <AlertCircle className="w-5 h-5 text-destructive" />
      <p className="text-sm text-muted-foreground">{t('Failed to load chat')}</p>
      <p className="text-xs text-muted-foreground/60 break-words">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 px-3 py-1 text-xs rounded-sm border border-border text-foreground hover:bg-secondary transition-colors"
        >
          {t('Retry')}
        </button>
      )}
    </div>
  )
}

// Fixed hover/press treatment shared by every suggestion chip below.
const CHIP_CLASS = 'group flex items-center gap-[7px] h-[34px] px-3.5 rounded-full border border-border bg-card text-[13px] text-muted-foreground transition-colors ease-halo hover:text-foreground hover:border-primary hover:bg-secondary'
const CHIP_ICON_CLASS = 'w-[15px] h-[15px] text-subtle-foreground transition-colors ease-halo group-hover:text-primary'

// Empty state component - adapts to compact mode
function EmptyState({
  isCompact = false,
  message,
  onSuggestion,
  composer,
}: {
  isCompact?: boolean
  /** Replaces the compact hint (a digital human's empty conversation says who to talk to). */
  message?: string
  onSuggestion?: (prompt: string) => void
  /** Centered composer, only rendered in the full (non-compact) takeover. */
  composer?: ReactNode
}) {
  const { t } = useTranslation()
  const openTaskPanel = useTaskPanelStore(s => s.open)

  // Compact mode shows minimal UI
  if (isCompact) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-4">
        <Sparkles className="w-8 h-8 text-primary/70" />
        <p className="mt-4 text-sm text-muted-foreground">
          {message ?? t('Continue the conversation here')}
        </p>
      </div>
    )
  }

  return (
    // Outer scroll container keeps content reachable on short viewports
    <div className="h-full overflow-y-auto px-6 sm:px-8">
      <div className="min-h-full flex flex-col items-center justify-center text-center py-8 animate-fade-up">
        {/* Brand mark — same asset as the NavRail logo, not a generic icon.
            No border-radius: these are transparent ring icons, not the
            prototype's solid rounded-square badge, so the prototype's
            `.empty-logo{radius:12px}` has nothing to apply to here. */}
        <img src={logoOnDark} alt="" aria-hidden="true" className="brand-mark-dark w-11 h-11 mb-4" />
        <img src={logoOnLight} alt="" aria-hidden="true" className="brand-mark-light w-11 h-11 mb-4" />

        {/* Title */}
        <h2 className="text-2xl font-semibold tracking-[-0.01em]">
          {t('What do you want to do today?')}
        </h2>

        {/* Composer — centered here until the first message is sent, then
            it docks to the bottom instead (see ChatView's render). Matches
            the docked composer's own width (InputArea.tsx's non-standalone
            `max-w-chat`) so it doesn't visibly narrow once the first
            message sends it to the bottom. */}
        {/* text-left stops the empty state's centering (meant for the logo,
            title and chips) from reaching into the composer, whose menus and
            hints are ordinary left-reading UI. */}
        {composer && (
          <div className="mt-7 w-full max-w-chat text-left">
            {composer}
          </div>
        )}

        {/* Fixed set of entry points into Halo's capabilities. Wider cap than
            the composer above: English labels ("Continue recent task",
            "Create digital human", ...) run noticeably longer than the
            Chinese originals and wrapped to two lines at 640px. flex-wrap
            still handles narrow viewports — this only matters once the
            viewport has the room to use it. */}
        <div className="mt-[18px] w-full max-w-[900px] flex flex-wrap items-center justify-center gap-2">
          <button onClick={openTaskPanel} className={CHIP_CLASS}>
            <SquareCheckBig className={CHIP_ICON_CLASS} strokeWidth={1.8} />
            {t('Continue recent task')}
          </button>
          <button onClick={() => onSuggestion?.(t('Help me generate code'))} className={CHIP_CLASS}>
            <Code className={CHIP_ICON_CLASS} strokeWidth={1.8} />
            {t('Generate code')}
          </button>
          <button onClick={() => onSuggestion?.(t('Help me create a digital human'))} className={CHIP_CLASS}>
            <Bot className={CHIP_ICON_CLASS} strokeWidth={1.8} />
            {t('Create digital human')}
          </button>
          <button onClick={() => onSuggestion?.(t('Help me analyze this document'))} className={CHIP_CLASS}>
            <FileText className={CHIP_ICON_CLASS} strokeWidth={1.8} />
            {t('Analyze document')}
          </button>
          <button onClick={() => onSuggestion?.(t('Mount my knowledge base'))} className={CHIP_CLASS}>
            <BookOpen className={CHIP_ICON_CLASS} strokeWidth={1.8} />
            {t('Mount knowledge base')}
          </button>
        </div>
      </div>
    </div>
  )
}
