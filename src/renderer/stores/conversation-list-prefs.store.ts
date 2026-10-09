/**
 * Conversation list view preferences — which sections and digital-human
 * groups are open (per space) and how tall the resizable panes are. Pure
 * presentation, so client-local (localStorage) like the other view-prefs stores.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ConversationSection = 'pinned' | 'digital-humans' | 'conversations'

/** Panes whose height the user can drag; the conversations pane takes what is left. */
export type ResizablePane = Exclude<ConversationSection, 'conversations'>

/** Digital humans start folded: most people talk to Halo itself far more often. */
const DEFAULT_SECTION_OPEN: Record<ConversationSection, boolean> = {
  pinned: true,
  'digital-humans': false,
  conversations: true,
}

export function isSectionOpen(
  choices: Partial<Record<ConversationSection, boolean>> | undefined,
  section: ConversationSection,
): boolean {
  return choices?.[section] ?? DEFAULT_SECTION_OPEN[section]
}

interface ConversationListPrefsState {
  /** spaceId -> section -> the user's open/closed choice; absent uses the default. */
  sectionOpen: Record<string, Partial<Record<ConversationSection, boolean>>>
  /**
   * spaceId -> appId -> the user's explicit open/closed choice for that
   * digital human's group. Absent means the list decides; what it opens on its own is not stored.
   */
  appGroupOpen: Record<string, Record<string, boolean>>
  /** Heights the user dragged panes to; absent keeps each pane's default. */
  paneHeights: Partial<Record<ResizablePane, number>>

  setSectionOpen: (spaceId: string, section: ConversationSection, open: boolean) => void
  setAppGroupOpen: (spaceId: string, appId: string, open: boolean) => void
  setPaneHeight: (pane: ResizablePane, height: number | undefined) => void
  /** Drop a deleted or forgotten space's choices. */
  forgetSpace: (spaceId: string) => void
}

export const useConversationListPrefs = create<ConversationListPrefsState>()(
  persist(
    (set) => ({
      sectionOpen: {},
      appGroupOpen: {},
      paneHeights: {},

      setSectionOpen: (spaceId, section, open) =>
        set((state) => {
          const current = state.sectionOpen[spaceId] ?? {}
          if (current[section] === open) return state
          return { sectionOpen: { ...state.sectionOpen, [spaceId]: { ...current, [section]: open } } }
        }),

      setAppGroupOpen: (spaceId, appId, open) =>
        set((state) => {
          const current = state.appGroupOpen[spaceId] ?? {}
          if (current[appId] === open) return state
          return { appGroupOpen: { ...state.appGroupOpen, [spaceId]: { ...current, [appId]: open } } }
        }),

      setPaneHeight: (pane, height) =>
        set((state) => {
          const next = { ...state.paneHeights }
          if (height === undefined) delete next[pane]
          else next[pane] = height
          return { paneHeights: next }
        }),

      forgetSpace: (spaceId) =>
        set((state) => {
          if (!(spaceId in state.sectionOpen) && !(spaceId in state.appGroupOpen)) return state
          const { [spaceId]: _sections, ...sectionOpen } = state.sectionOpen
          const { [spaceId]: _groups, ...appGroupOpen } = state.appGroupOpen
          return { sectionOpen, appGroupOpen }
        }),
    }),
    { name: 'halo-conversation-list-prefs' }
  )
)
