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

import { useState, useCallback, useEffect, useRef } from 'react'
import { useSpaceStore } from '../../stores/space.store'
import { useChatStore } from '../../stores/chat.store'
import { useOnboardingStore } from '../../stores/onboarding.store'
import { useAIBrowserStore } from '../../stores/ai-browser.store'
import { MessageList } from './MessageList'
import type { MessageListHandle } from './MessageList'
import { InputArea } from './InputArea'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { Sparkles } from '../icons/ToolIcons'
import {
  ONBOARDING_ARTIFACT_NAME,
  getOnboardingAiResponse,
  getOnboardingHtmlArtifact,
  getOnboardingPrompt,
} from '../onboarding/onboardingData'
import { api } from '../../api'
import type { ImageAttachment } from '../../types'
import { useTranslation } from '../../i18n'

interface ChatViewProps {
  isCompact?: boolean
}

export function ChatView({ isCompact = false }: ChatViewProps) {
  const { t } = useTranslation()
  const { currentSpace } = useSpaceStore()
  const {
    getCurrentConversation,
    getCurrentSession,
    sendMessage,
    stopGeneration,
    continueAfterInterrupt,
    answerQuestion
  } = useChatStore()

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
  const session = getCurrentSession()
  const { isGenerating, streamingContent, isStreaming, thoughts, isThinking, compactInfo, error, errorType, textBlockVersion, pendingQuestion } = session

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

  // AI Browser state
  const { enabled: aiBrowserEnabled } = useAIBrowserStore()

  // Handle send (with optional images for multi-modal messages, optional thinking mode)
  const handleSend = async (content: string, images?: ImageAttachment[], thinkingEnabled?: boolean) => {
    // In onboarding mode, intercept and play mock response
    if (isOnboarding && currentStep === 'send-message') {
      handleOnboardingSend()
      return
    }

    // Can send if has text OR has images
    if ((!content.trim() && (!images || images.length === 0)) || isGenerating) return

    // Pass both AI Browser and thinking state to sendMessage
    await sendMessage(content, images, aiBrowserEnabled, thinkingEnabled)
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
  const hasMessages = displayMessages.length > 0 || displayStreamingContent || displayIsThinking

  // Track previous compact state for smooth transitions
  const prevCompactRef = useRef(isCompact)
  const isTransitioningLayout = prevCompactRef.current !== isCompact

  useEffect(() => {
    prevCompactRef.current = isCompact
  }, [isCompact])

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
        {/* Virtuoso manages its own scroll container */}
        <div
          className={`
            h-full
            transition-[padding] duration-300 ease-out
            ${isCompact ? 'px-3' : 'px-4'}
          `}
        >
          {isLoadingConversation ? (
            <LoadingState />
          ) : !hasMessages ? (
            <EmptyState isTemp={currentSpace?.isTemp || false} isCompact={isCompact} />
          ) : (
            <MessageList
              key={currentConversation?.id ?? 'empty'}
              ref={messageListRef}
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
      <InputArea
        onSend={handleSend}
        onStop={handleStop}
        isGenerating={isGenerating}
        placeholder={isCompact ? t('Continue conversation...') : (currentSpace?.isTemp ? t('Say something to Halo...') : t('Continue conversation...'))}
        isCompact={isCompact}
      />
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

// Empty state component - adapts to compact mode
function EmptyState({ isTemp, isCompact = false }: { isTemp: boolean; isCompact?: boolean }) {
  const { t } = useTranslation()
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
    <div className="h-full flex flex-col items-center justify-center text-center px-8">
      {/* Icon */}
      <Sparkles className="w-12 h-12 text-primary" />

      {/* Title - concise and warm */}
      <h2 className="mt-6 text-xl font-medium">
        Halo
      </h2>
      <p className="mt-2 text-muted-foreground">
        {t('Not just chat, help you get things done')}
      </p>

      {/* Powered by badge - simplified */}
      <div className="mt-8 px-3 py-1.5 rounded-full border border-border">
        <span className="text-xs text-muted-foreground">
          Powered by Claude Code
        </span>
      </div>
    </div>
  )
}
