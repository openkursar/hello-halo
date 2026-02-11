/**
 * usePulseMode - Determines which Pulse form to display
 *
 * Form decision logic:
 * - Wide window + ConversationList closed → 'inline' (Form A / A-collapsed)
 * - Wide window + ConversationList open  → 'sidebar' (Form B, embedded in ConversationList)
 * - Narrow window or mobile              → 'beacon' (Form C, Header Beacon)
 *
 * The threshold is based on whether the chat area has enough space
 * to render the inline panel without squeezing the conversation.
 *
 * Uses a fixed breakpoint for now; can be refined to use CSS container queries later.
 */

import { useState, useEffect } from 'react'
import { useIsMobile } from './useIsMobile'

export type PulseMode = 'inline' | 'sidebar' | 'beacon'

/**
 * Minimum window width (px) to show inline Pulse panel.
 * Below this, Pulse degrades to Header Beacon mode.
 * This accounts for: traffic lights (80px) + Pulse panel (280px) + minimum chat width (~400px).
 */
const PULSE_INLINE_MIN_WIDTH = 860

interface UsePulseModeOptions {
  /** Whether ConversationList sidebar is currently open */
  isConversationListOpen: boolean
}

export function usePulseMode({ isConversationListOpen }: UsePulseModeOptions): PulseMode {
  const isMobile = useIsMobile()
  const [isNarrow, setIsNarrow] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.innerWidth < PULSE_INLINE_MIN_WIDTH
  })

  useEffect(() => {
    const handleResize = () => {
      setIsNarrow(window.innerWidth < PULSE_INLINE_MIN_WIDTH)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  if (isMobile || isNarrow) return 'beacon'
  if (isConversationListOpen) return 'sidebar'
  return 'inline'
}
