/**
 * ChatCapsuleOverlay - Floating capsule button for returning to chat
 *
 * This is the overlay version of ChatCapsule that renders in the
 * overlay WebContentsView, ensuring it appears above BrowserViews.
 *
 * Design:
 * - Halo brand color (blue) for high visibility on any background
 * - Circular button with shadow for depth
 * - Fixed position on left edge, vertically centered
 *
 * Future enhancements (TODO):
 * - Show unread message count badge
 * - Show AI typing/thinking animation
 * - Hover preview of recent messages
 */

import { MessageCircle } from 'lucide-react'
import { useTranslation } from '../i18n'

interface ChatCapsuleOverlayProps {
  onClick: () => void
}

export function ChatCapsuleOverlay({ onClick }: ChatCapsuleOverlayProps) {
  const { t } = useTranslation()

  return (
    <button
      onClick={onClick}
      style={{
        // Inline styles for reliability (no CSS class dependency)
        position: 'fixed',
        left: '12px',
        top: '50%',
        transform: 'translateY(-50%)',
        width: '44px',
        height: '44px',
        borderRadius: '50%',
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Halo brand blue - visible on both light and dark backgrounds
        backgroundColor: '#3b82f6',
        // Strong shadow for visibility and depth
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3), 0 0 0 2px rgba(255, 255, 255, 0.2)',
        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
        pointerEvents: 'auto',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-50%) scale(1.1)'
        e.currentTarget.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.4), 0 0 0 2px rgba(255, 255, 255, 0.3)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(-50%) scale(1)'
        e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3), 0 0 0 2px rgba(255, 255, 255, 0.2)'
      }}
      onMouseDown={(e) => {
        e.currentTarget.style.transform = 'translateY(-50%) scale(0.95)'
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = 'translateY(-50%) scale(1.1)'
      }}
      title={t('Return to conversation')}
      aria-label={t('Exit fullscreen and return to chat')}
    >
      {/* White icon on blue background for maximum contrast */}
      <MessageCircle
        style={{
          width: '22px',
          height: '22px',
          color: 'white',
        }}
      />
    </button>
  )
}
