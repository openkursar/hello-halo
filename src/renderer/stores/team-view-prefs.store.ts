/**
 * Team view preferences — client-local, per-office view choices.
 *
 * These are pure presentation preferences (how the office renders on THIS
 * screen), deliberately kept out of the team domain model and backend: an
 * office's coordination data never carries a skin. Persisted to localStorage,
 * keyed by team id, mirroring the per-space layout-preference pattern.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** How the office topology renders: plain status cards, or cartoon workstations. */
export type OfficeSkin = 'default' | 'cartoon'

/** Cartoon is the default: the workstation metaphor reads more clearly than an
 *  abstract node graph. One click switches any office back to plain cards. */
export const DEFAULT_OFFICE_SKIN: OfficeSkin = 'cartoon'

interface TeamViewPrefsState {
  /** teamId → chosen skin. Absent means "use the default". */
  skinByTeam: Record<string, OfficeSkin>
  setOfficeSkin: (teamId: string, skin: OfficeSkin) => void
}

export const useTeamViewPrefsStore = create<TeamViewPrefsState>()(
  persist(
    (set) => ({
      skinByTeam: {},
      setOfficeSkin: (teamId, skin) =>
        set((state) => ({ skinByTeam: { ...state.skinByTeam, [teamId]: skin } })),
    }),
    {
      name: 'halo-team-view-prefs',
      partialize: (state) => ({ skinByTeam: state.skinByTeam }),
    },
  ),
)

/** The office skin for a team, falling back to the default when unset. */
export function useOfficeSkin(teamId: string): OfficeSkin {
  return useTeamViewPrefsStore((state) => state.skinByTeam[teamId] ?? DEFAULT_OFFICE_SKIN)
}
