/**
 * Chat View - Main chat interface
 * Uses session-based state for multi-conversation support
 * Supports onboarding mode with mock AI response
 * Features smart auto-scroll via react-virtuoso (stops when user reads history)
 *
 * Layout modes:
 * - Full width (isCompact=false): Centered content with max-width
 * - Compact mode (isCompact=true): Sidebar-style when Canvas is open
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { ReactNode } from 'react'
import { SquareCheckBig, Code, Bot, FileText, BookOpen } from 'lucide-react'
import logoOnDark from '../../assets/brand/halo-logo-icon-on-dark.svg'
import logoOnLight from '../../assets/brand/halo-logo-icon-on-light.svg'
import { useSpaceStore } from '../../stores/space.store'
import { useChatStore } from '../../stores/chat.store'
import { useOnboardingStore } from '../../stores/onboarding.store'
import { useTaskPanelStore } from '../../stores/taskPanel.store'
import { MessageList } from './MessageList'
import type { MessageListHandle } from './MessageList'
import { InputArea } from './InputArea'
import { useConversationMentionCandidates } from './cross-conversation'
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
import { AppChatView } from '../apps/AppChatView'
import { useSpaceDigitalHumans } from '../../hooks/useSpaceDigitalHumans'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { getAppChatConversationId } from '../../api/_shared'
import type { DigitalHumanSelectorConfig } from './DigitalHumanSelector'

interface ChatViewProps {
  isCompact?: boolean
}

export function ChatView({ isCompact = false }: ChatViewProps) {
  const { t } = useTranslation()
  const { currentSpace } = useSpaceStore()
  const {
    getCurrentConversation,
    getCurrentConversationId,
    getCurrentSession,
    getSession,
    sessionInitInfo,
    sendMessage,
    stopGeneration,
    injectMessage,
    continueAfterInterrupt,
    answerQuestion,
    loadMessageThoughts,
    currentSpaceId,
    selectAppChatConversation,
    clearAppChatSelection,
  } = useChatStore()

  // ── Digital-human selection ──
  const selectedAppChat = useChatStore(
    s => (currentSpaceId ? s.spaceStates.get(currentSpaceId)?.selectedAppChat ?? null : null)
  )
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

  // MessageList ref for scroll control (Virtuoso-based)
  const messageListRef = useRef<MessageListHandle>(null)

  // Scroll-to-bottom button visibility — driven by Virtuoso's atBottomStateChange
  const [showScrollButton, setShowScrollButton] = useState(false)
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setShowScrollButton(!atBottom)
  }, [])

  // Handle search result navigation - scroll to message and highlight search term
  // With Virtuoso, we first scroll the target message into view by index,
  // then apply DOM-based highlighting once it's rendered.
  const displayMessagesRef = useRef<{ id: string }[]>([])

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

      // Find message index in displayMessages
      const messageIndex = displayMessagesRef.current.findIndex(m => m.id === messageId)
      if (messageIndex === -1) {
        console.warn(`[ChatView] Message not found in displayMessages for ID: ${messageId}`)
        return
      }

      // Scroll to the message via Virtuoso
      messageListRef.current?.scrollToIndex(messageIndex, 'smooth')

      // Wait for Virtuoso to render the item, then apply DOM highlighting
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

      // Small delay to allow Virtuoso to scroll and render
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

  // Get current conversation and its session state
  const currentConversation = getCurrentConversation()
  const { isLoadingConversation } = useChatStore()

  // Lazy loader for a message's separated thoughts, bound to the active
  // space + conversation ids. Passed to MessageList's thoughtsLoader prop.
  const thoughtsLoader = useCallback(
    (messageId: string) =>
      currentSpaceId && currentConversation?.id
        ? loadMessageThoughts(currentSpaceId, currentConversation.id, messageId)
        : Promise.resolve([]),
    [loadMessageThoughts, currentSpaceId, currentConversation?.id]
  )
  const session = getCurrentSession()
  const { isGenerating, streamingContent, isStreaming, thoughts, isThinking, compactInfo, error, errorType, textBlockVersion, pendingQuestion } = session

  // ── Digital-human selector wiring ──
  // The active conversation is whichever link the selector points at; locking
  // reads that link's own session so switching is blocked mid-reply no matter
  // which side (Halo or a digital human) is currently generating.
  const activeConversationId = selectedAppChat ? selectedAppChat.conversationId : currentConversation?.id ?? null
  const activeSession = getSession(activeConversationId ?? '')
  const digitalHumanSelectorLocked = activeSession.isGenerating || activeSession.queuedMessages.length > 0
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

  // Build the slash-command list for the autocomplete menu.
  // Only reads from SDK slash_commands array.
  // Commands are categorized as 'skill' if they appear in the skills array, otherwise 'builtin'.
  const slashCommands = useMemo<SlashCommandItem[]>(() => {
    const conversationId = getCurrentConversationId()
    const initInfo = conversationId ? sessionInitInfo.get(conversationId) : null

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
  }, [sessionInitInfo, getCurrentConversationId])

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

    await sendMessage(content, images, thinkingEnabled)
  }

  // Handle stop - stops the current conversation's generation
  const handleStop = async () => {
    if (currentConversation) {
      await stopGeneration(currentConversation.id)
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

  // Keep displayMessagesRef in sync for search navigation
  displayMessagesRef.current = displayMessages

  const displayStreamingContent = mockStreamingContent || streamingContent
  const displayIsGenerating = isMockAnimating || isGenerating
  const displayIsThinking = isMockThinking || isThinking
  const displayIsStreaming = isStreaming  // Only real streaming (not mock)
  const hasMessages = displayMessages.length > 0 || !!displayStreamingContent || displayIsThinking

  // Track previous compact state for smooth transitions
  const prevCompactRef = useRef(isCompact)
  const isTransitioningLayout = prevCompactRef.current !== isCompact

  useEffect(() => {
    prevCompactRef.current = isCompact
  }, [isCompact])

  // ── Digital-human mode: delegate to AppChatView ──
  // AppChatView already fully implements "chat with a digital human" (its own
  // message loading, send/stop, mentions, WS recovery) — reusing it here keeps
  // that logic in one place instead of re-deriving it inside ChatView. Only the
  // input row is shared in spirit: the same DigitalHumanSelector config is
  // threaded through so the control never visually resets when switching.
  if (selectedAppChat && currentSpace) {
    return (
      <AppChatView
        key={selectedAppChat.conversationId}
        appId={selectedAppChat.appId}
        spaceId={currentSpace.id}
        conversationId={selectedAppChat.conversationId}
        digitalHumanSelector={digitalHumanSelector}
        draftKey={activeConversationId ?? undefined}
      />
    )
  }

  // Full-takeover empty state: composer and suggestions centered on screen,
  // no docked input below — matches the prototype, where the composer only
  // sinks to a bottom dock once the first message is sent. Loading and
  // compact (canvas-open) states keep the normal docked-input layout.
  const isFullTakeoverEmpty = !isCompact && !hasMessages && !isLoadingConversation

  // Built once and handed to whichever position needs it (docked at the
  // bottom, or centered inline in the full-takeover empty state) — only one
  // of those two ever mounts at a time, so there's no duplicate instance,
  // just two possible slots for the same props.
  const inputArea = (
    <InputArea
      key={activeConversationId ?? 'none'}
      onSend={handleSend}
      onInject={(content) => {
        const conversationId = getCurrentConversationId()
        if (conversationId) injectMessage(conversationId, content)
      }}
      onStop={handleStop}
      isGenerating={isGenerating}
      placeholder={isCompact ? t('Continue conversation...') : (currentSpace?.isTemp ? t('Say something to Halo...') : undefined)}
      isCompact={isCompact}
      slashCommands={slashCommands}
      mentionArtifacts={mentionArtifacts}
      mentionConversations={mentionConversations}
      standalone={isFullTakeoverEmpty}
      digitalHumanSelector={digitalHumanSelector}
      draftKey={activeConversationId ?? undefined}
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
        {/* Virtuoso manages its own scroll container. This wrapper itself
            isn't remounted on conversation switch (only its children are,
            via MessageList's own `key`), so the entrance animation plays
            once when the chat page first mounts — not on every switch — and
            never touches Virtuoso's own scroll measurements (transform on an
            ancestor doesn't affect its internal scrollHeight/clientHeight). */}
        <div
          className={`
            h-full animate-fade-up
            transition-[padding] duration-300 ease-out
            ${isCompact ? 'px-3' : 'px-6'}
          `}
        >
          {isLoadingConversation ? (
            <LoadingState />
          ) : !hasMessages ? (
            <EmptyState isCompact />
          ) : (
            <MessageList
              key={currentConversation?.id ?? 'empty'}
              ref={messageListRef}
              conversationId={currentConversation?.id}
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
              onContinue={currentConversation ? () => continueAfterInterrupt(currentConversation.id) : undefined}
              isCompact={isCompact}
              textBlockVersion={textBlockVersion}
              pendingQuestion={pendingQuestion}
              onAnswerQuestion={currentConversation ? (answers) => answerQuestion(currentConversation.id, answers) : undefined}
              onAtBottomStateChange={handleAtBottomStateChange}
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

// Fixed hover/press treatment shared by every suggestion chip below.
const CHIP_CLASS = 'group flex items-center gap-[7px] h-[34px] px-3.5 rounded-full border border-border bg-card text-[13px] text-muted-foreground transition-colors ease-halo hover:text-foreground hover:border-primary hover:bg-secondary'
const CHIP_ICON_CLASS = 'w-[15px] h-[15px] text-subtle-foreground transition-colors ease-halo group-hover:text-primary'

// Empty state component - adapts to compact mode
function EmptyState({
  isCompact = false,
  onSuggestion,
  composer,
}: {
  isCompact?: boolean
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
          {t('Continue the conversation here')}
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
            `max-w-[720px]`) so it doesn't visibly narrow once the first
            message sends it to the bottom. */}
        {composer && (
          <div className="mt-7 w-full max-w-[720px]">
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
