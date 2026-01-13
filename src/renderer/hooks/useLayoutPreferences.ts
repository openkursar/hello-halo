/**
 * useLayoutPreferences Hook
 *
 * Manages layout preferences for a space with the following priority:
 * 1. Maximized mode override (highest priority)
 * 2. User's real-time interaction (current session)
 * 3. Persisted space preferences (meta.json)
 * 4. System defaults (lowest priority)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSpaceStore } from '../stores/space.store'
import { useCanvasIsOpen } from '../stores/canvas.store'
import type { SpaceLayoutPreferences } from '../types'

// Default values
const LAYOUT_DEFAULTS = {
  chatWidth: 420,
  chatWidthMin: 320,
  chatWidthMax: 800,
  chatWidthMaxWhenMaximized: 800,
  chatWidthMinWhenMaximized: 320,
  artifactRailExpanded: false, // Default: collapsed when canvas is open
}

interface UseLayoutPreferencesReturn {
  // Current effective values (considering all overrides)
  effectiveRailExpanded: boolean
  effectiveChatWidth: number

  // Raw preference values (from storage)
  preferences: SpaceLayoutPreferences | undefined

  // Whether user has manually overridden in this session
  hasUserOverride: boolean

  // Actions
  setRailExpanded: (expanded: boolean) => void
  setChatWidth: (width: number) => void

  // Constraints
  chatWidthMin: number
  chatWidthMax: number
}

export function useLayoutPreferences(
  spaceId: string | undefined,
  isMaximized: boolean = false
): UseLayoutPreferencesReturn {
  const { getSpacePreferences, updateSpacePreferences, currentSpace } = useSpaceStore()
  const isCanvasOpen = useCanvasIsOpen()

  // Get persisted preferences
  const preferences = spaceId ? getSpacePreferences(spaceId) : undefined
  const layoutPrefs = preferences?.layout

  // Track if user has manually overridden rail state in this session
  const [userRailOverride, setUserRailOverride] = useState<boolean | null>(null)

  // Track current chat width (may differ from persisted during drag)
  const [currentChatWidth, setCurrentChatWidth] = useState<number>(
    layoutPrefs?.chatWidth ?? LAYOUT_DEFAULTS.chatWidth
  )

  // Ref to track if we've initialized from preferences
  const initializedRef = useRef(false)

  // Sync chat width from preferences when space changes
  useEffect(() => {
    if (spaceId && !initializedRef.current) {
      const prefs = getSpacePreferences(spaceId)
      if (prefs?.layout?.chatWidth) {
        setCurrentChatWidth(prefs.layout.chatWidth)
      }
      initializedRef.current = true
    }
  }, [spaceId, getSpacePreferences])

  // Reset user override when space changes
  useEffect(() => {
    setUserRailOverride(null)
    initializedRef.current = false
  }, [spaceId])

  // Calculate effective rail expanded state
  const effectiveRailExpanded = (() => {
    // Priority 1: User's current session override (highest priority)
    // This ensures user's manual toggle always works
    if (userRailOverride !== null) {
      return userRailOverride
    }

    // Priority 2: If canvas is not open, default to expanded
    if (!isCanvasOpen) {
      return true
    }

    // Priority 3: Persisted preference
    if (layoutPrefs?.artifactRailExpanded !== undefined) {
      return layoutPrefs.artifactRailExpanded
    }

    // Priority 4: Default (collapsed when canvas open)
    return LAYOUT_DEFAULTS.artifactRailExpanded
  })()

  // Calculate width constraints based on maximized state
  const chatWidthMin = isMaximized
    ? LAYOUT_DEFAULTS.chatWidthMinWhenMaximized
    : LAYOUT_DEFAULTS.chatWidthMin

  const chatWidthMax = isMaximized
    ? LAYOUT_DEFAULTS.chatWidthMaxWhenMaximized
    : LAYOUT_DEFAULTS.chatWidthMax

  // Calculate effective chat width
  const effectiveChatWidth = (() => {
    // Clamp to current constraints
    let width = currentChatWidth

    // If maximized, apply stricter constraints
    if (isMaximized) {
      width = Math.min(width, chatWidthMax)
    }

    return Math.max(chatWidthMin, Math.min(chatWidthMax, width))
  })()

  // Set rail expanded state (user action)
  const setRailExpanded = useCallback((expanded: boolean) => {
    console.log('[useLayoutPreferences] 🟡 setRailExpanded called:', expanded, 'time:', Date.now())
    // Mark as user override
    setUserRailOverride(expanded)

    // Persist to storage (unless in maximized mode, where override is temporary)
    if (spaceId && !isMaximized) {
      updateSpacePreferences(spaceId, {
        layout: {
          ...layoutPrefs,
          artifactRailExpanded: expanded
        }
      })
    }
  }, [spaceId, isMaximized, layoutPrefs, updateSpacePreferences])

  // Set chat width (called on drag end)
  const setChatWidth = useCallback((width: number) => {
    // Clamp to constraints
    const clampedWidth = Math.max(chatWidthMin, Math.min(chatWidthMax, width))
    setCurrentChatWidth(clampedWidth)

    // Persist to storage
    if (spaceId) {
      updateSpacePreferences(spaceId, {
        layout: {
          ...layoutPrefs,
          chatWidth: clampedWidth
        }
      })
    }
  }, [spaceId, chatWidthMin, chatWidthMax, layoutPrefs, updateSpacePreferences])

  return {
    effectiveRailExpanded,
    effectiveChatWidth,
    preferences: layoutPrefs ? { layout: layoutPrefs } : undefined,
    hasUserOverride: userRailOverride !== null,
    setRailExpanded,
    setChatWidth,
    chatWidthMin,
    chatWidthMax,
  }
}

// Export defaults for use in components
export { LAYOUT_DEFAULTS }
