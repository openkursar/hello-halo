/**
 * When the invite dialog saves its answer for a team's first link.
 *
 * The first link is what makes the team reach another computer, so the answer
 * on screen is saved once the call that may create it returns. Not as the
 * dialog opens: the call may answer that it created nothing (Remote Access is
 * off), and then nothing should change. Not only on success either: a link
 * issued whose reply was lost would be out with every member unset, which lends
 * a colleague everything. Pure: the dialog makes the call and saves.
 */

/** What `generateTeamInvite` answers before it issues anything. */
const NOTHING_ISSUED = new Set(['TEAM_NOT_FOUND', 'REMOTE_ACCESS_OFF', 'FEDERATION_UNAVAILABLE'])

export interface InviteAnswer {
  success: boolean
  error?: string
}

/** Whether a link may exist after this answer; `null` for a call that failed without one. */
export function inviteMayExist(answer: InviteAnswer | null): boolean {
  return answer === null || answer.success || !NOTHING_ISSUED.has(answer.error ?? '')
}

/**
 * Give it every invite call's answer as soon as the call settles, whether or not
 * the dialog is still open: `save` runs after the first answer that may leave a
 * link out, and never again.
 */
export function firstInviteSaver(save: () => void): (answer: InviteAnswer | null) => void {
  let saved = false
  return (answer) => {
    if (saved || !inviteMayExist(answer)) return
    saved = true
    save()
  }
}
