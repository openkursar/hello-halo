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
  /**
   * teamId → the digital human of MINE this office's conversations open onto.
   * Opening a team should land on your own digital human, and on the one you
   * last spoke to when you brought several — but that is your habit on this
   * screen, not a fact about the office, so it never leaves this machine.
   */
  defaultMemberByTeam: Record<string, string>
  setDefaultMember: (teamId: string, appId: string) => void
}

export const useTeamViewPrefsStore = create<TeamViewPrefsState>()(
  persist(
    (set) => ({
      skinByTeam: {},
      setOfficeSkin: (teamId, skin) =>
        set((state) => ({ skinByTeam: { ...state.skinByTeam, [teamId]: skin } })),
      defaultMemberByTeam: {},
      setDefaultMember: (teamId, appId) =>
        set((state) =>
          state.defaultMemberByTeam[teamId] === appId
            ? state
            : { defaultMemberByTeam: { ...state.defaultMemberByTeam, [teamId]: appId } }
        ),
    }),
    {
      name: 'halo-team-view-prefs',
      partialize: (state) => ({
        skinByTeam: state.skinByTeam,
        defaultMemberByTeam: state.defaultMemberByTeam,
      }),
    },
  ),
)

/** The office skin for a team, falling back to the default when unset. */
export function useOfficeSkin(teamId: string): OfficeSkin {
  return useTeamViewPrefsStore((state) => state.skinByTeam[teamId] ?? DEFAULT_OFFICE_SKIN)
}

/**
 * Which digital human of yours a team conversation talks to.
 *
 * Order: the one you last spoke to here → the first one you brought → the team
 * lead. The lead is the fallback for someone who brought nobody (they are only
 * watching), never the default for someone who did. Candidates are the ones that
 * can actually answer, so a remembered choice that has since been uninstalled
 * falls through instead of pointing the chat at nothing.
 */
export function pickChatTarget(
  remembered: string | undefined,
  candidateAppIds: string[],
  leadAppId: string | null
): string | null {
  if (remembered && candidateAppIds.includes(remembered)) return remembered
  return candidateAppIds[0] ?? leadAppId
}

export function useDefaultChatTarget(
  teamId: string,
  candidateAppIds: string[],
  leadAppId: string | null
): string | null {
  const remembered = useTeamViewPrefsStore((state) => state.defaultMemberByTeam[teamId])
  return pickChatTarget(remembered, candidateAppIds, leadAppId)
}
