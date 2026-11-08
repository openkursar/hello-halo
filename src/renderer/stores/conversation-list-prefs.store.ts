/**
 * Conversation list view preferences — which sections and digital-human
 * groups are open (per space), how tall the resizable panes are, and whether
 * the whole list is folded to its icon strip. Pure presentation, so
 * client-local (localStorage) like the other view-prefs stores.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ConversationSection = 'pinned' | 'digital-humans' | 'conversations'

/** Panes whose height the user can drag; the conversations pane takes what is left. */
export type ResizablePane = Exclude<ConversationSection, 'conversations'>

/** Whether the content canvas is open beside the chat; the list keeps a fold choice for each. */
export type ConversationListLayout = 'with-canvas' | 'without-canvas'

/** Digital humans start folded: most people talk to Halo itself far more often. */
const DEFAULT_SECTION_OPEN: Record<ConversationSection, boolean> = {
  pinned: true,
  'digital-humans': false,
  conversations: true,
}

/** The canvas needs the room, so beside it the list starts folded. */
const DEFAULT_LIST_FOLDED: Record<ConversationListLayout, boolean> = {
  'with-canvas': true,
  'without-canvas': false,
}

export function isSectionOpen(
  choices: Partial<Record<ConversationSection, boolean>> | undefined,
  section: ConversationSection,
): boolean {
  return choices?.[section] ?? DEFAULT_SECTION_OPEN[section]
}

export function isListFolded(
  choices: Partial<Record<ConversationListLayout, boolean>> | undefined,
  layout: ConversationListLayout,
): boolean {
  return choices?.[layout] ?? DEFAULT_LIST_FOLDED[layout]
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
  /** layout -> whether the user left the list folded; absent uses the default. */
  listFolded: Partial<Record<ConversationListLayout, boolean>>

  setSectionOpen: (spaceId: string, section: ConversationSection, open: boolean) => void
  setAppGroupOpen: (spaceId: string, appId: string, open: boolean) => void
  setPaneHeight: (pane: ResizablePane, height: number | undefined) => void
  setListFolded: (layout: ConversationListLayout, folded: boolean) => void
  /** Drop a deleted or forgotten space's choices. */
  forgetSpace: (spaceId: string) => void
}

export const useConversationListPrefs = create<ConversationListPrefsState>()(
  persist(
    (set) => ({
      sectionOpen: {},
      appGroupOpen: {},
      paneHeights: {},
      listFolded: {},

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

      setListFolded: (layout, folded) =>
        set((state) => {
          if (state.listFolded[layout] === folded) return state
          return { listFolded: { ...state.listFolded, [layout]: folded } }
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
