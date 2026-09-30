/**
 * Last-used thinking level — the level most recently picked on any model card.
 *
 * Conversations and digital humans keep their own level (see
 * ThinkingLevelControl); this one seeds new conversations and rides on every
 * send as the fallback for anything that has none. Unset until the user first
 * moves a slider, so the Deep Thinking default and each model's configured
 * effort apply as before.
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

/** The level a send carries as its fallback, or undefined when the user never picked one. */
export function lastUsedThinkingLevel(): ThinkingLevel | undefined {
  return useThinkingLevelStore.getState().level ?? undefined
}
