/**
 * Last-used thinking level — the level most recently picked on any model card.
 *
 * Conversations and digital humans keep their own level (see
 * ThinkingLevelControl); this one only seeds new conversations, like the
 * last-used model. Unset until the user first moves a slider.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ReasoningEffortLevel } from '../../shared/constants/reasoning-effort'

/** The stops the slider offers, least to most. Engines clamp to their own ladder. */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'] as const satisfies readonly ReasoningEffortLevel[]
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

interface ThinkingLevelState {
  level: ThinkingLevel | null
  setLevel: (level: ThinkingLevel) => void
}

export const useThinkingLevelStore = create<ThinkingLevelState>()(persist((set) => ({
  level: null,
  setLevel: level => set({ level }),
}), {
  name: 'halo-thinking-level',
  partialize: state => ({ level: state.level }),
  // A stored value that is no longer a slider stop reads as never picked.
  merge: (persisted, current) => {
    const level = (persisted as { level?: unknown } | undefined)?.level
    return { ...current, level: isThinkingLevel(level) ? level : null }
  },
}))

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly unknown[]).includes(value)
}
