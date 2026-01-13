/**
 * ChatCapsule - Floating capsule button for returning to chat
 *
 * Displayed when Canvas is maximized, providing a quick way to
 * exit maximized mode and return to the chat view.
 *
 * Design:
 * - Circular button with frosted glass effect
 * - Displays Halo icon
 * - Fixed position on left edge, vertically centered
 * - Subtle shadow and hover effects
 *
 * Future enhancements (TODO):
 * - Show unread message count badge
 * - Show AI typing/thinking animation
 * - Hover preview of recent messages
 */

import { MessageCircle } from 'lucide-react'
import { useCanvasStore } from '../../stores/canvas.store'
import { useTranslation } from '../../i18n'

interface ChatCapsuleProps {
  className?: string
}

export function ChatCapsule({ className = '' }: ChatCapsuleProps) {
  const { t } = useTranslation()
  const setMaximized = useCanvasStore(state => state.setMaximized)

  const handleClick = () => {
    setMaximized(false)
  }

  return (
    <button
      onClick={handleClick}
      className={`
        fixed left-3 top-1/2 -translate-y-1/2 z-50
        w-11 h-11
        flex items-center justify-center
        rounded-full
        bg-background/80 backdrop-blur-md
        border border-border/50
        shadow-lg shadow-black/10
        hover:bg-background hover:border-border
        hover:shadow-xl hover:shadow-black/15
        hover:scale-105
        active:scale-95
        transition-all duration-200 ease-out
        group
        ${className}
      `}
      title={t('Return to conversation')}
      aria-label={t('Exit fullscreen and return to chat')}
    >
      {/* Halo-style icon - using MessageCircle as chat indicator */}
      <MessageCircle
        className="
          w-5 h-5
          text-muted-foreground
          group-hover:text-primary
          transition-colors duration-200
        "
      />

      {/*
        TODO: Unread message count badge
        {unreadCount > 0 && (
          <span className="
            absolute -top-1 -right-1
            min-w-5 h-5 px-1.5
            flex items-center justify-center
            rounded-full
            bg-destructive text-destructive-foreground
            text-xs font-medium
          ">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      */}

      {/*
        TODO: AI typing indicator
        {isAITyping && (
          <span className="
            absolute -bottom-1 left-1/2 -translate-x-1/2
            flex gap-0.5
          ">
            <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
          </span>
        )}
      */}
    </button>
  )
}
