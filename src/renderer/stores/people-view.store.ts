import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { EscalationAnswer } from '../../shared/apps/app-types'
import type { TranscriptPosition } from '../components/chat/transcript'

export interface TeamNavigationTarget {
  teamId: string
  epochId?: string
  appId?: string
  entryId?: string
  decision?: boolean
}

interface PeopleViewState {
  query: string
  team: string
  space: string
  page: number
  directoryScroll: number
  scrolls: Record<string, number>
  /** Reading position of team session transcripts, keyed by conversation id. */
  transcriptPositions: Record<string, TranscriptPosition>
  drafts: Record<string, EscalationAnswer[]>
  focusEntry: { appId: string; entryId: string } | null
  teamTarget: TeamNavigationTarget | null
  returnInbox: boolean
  returnPerson: string | null
  returnTeam: TeamNavigationTarget | null
  setFilters: (patch: Partial<Pick<PeopleViewState, 'query' | 'team' | 'space' | 'page'>>) => void
  saveScroll: (key: string, top: number) => void
  saveTranscriptPosition: (key: string, position: TranscriptPosition) => void
  saveDraft: (key: string, answers: EscalationAnswer[]) => void
  clearDraft: (key: string) => void
}

export const usePeopleViewStore = create<PeopleViewState>()(persist((set) => ({
  query: '', team: '', space: '', page: 1,
  directoryScroll: 0, scrolls: {}, transcriptPositions: {}, drafts: {}, focusEntry: null, teamTarget: null, returnInbox: false, returnPerson: null, returnTeam: null,
  setFilters: patch => set({ ...patch, page: patch.page ?? 1 }),
  saveScroll: (key, top) => set(state => ({ scrolls: { ...state.scrolls, [key]: top } })),
  saveTranscriptPosition: (key, position) => set(state => ({ transcriptPositions: { ...state.transcriptPositions, [key]: position } })),
  saveDraft: (key, answers) => set(state => ({ drafts: { ...state.drafts, [key]: answers } })),
  clearDraft: key => set(state => { const drafts = { ...state.drafts }; delete drafts[key]; return { drafts } }),
}), {
  name: 'halo-people-view',
  partialize: state => ({ query: state.query, team: state.team, space: state.space, page: state.page }),
}))
