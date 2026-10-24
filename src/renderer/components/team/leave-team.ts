/**
 * What taking this computer's digital humans out of a team hosted elsewhere
 * says before it happens: all of them at once (leaving the team), or one.
 *
 * Leaving takes every one of them, and a person who has one in mind reads
 * "leave" as about that one — so leaving names each and says how many, and is
 * marked destructive when it takes more than one. With one there is nobody
 * else to take by surprise, and red would only make leaving someone else's
 * team look dangerous. Either way the duty written for each is kept on this
 * computer and comes back when it rejoins the same team. Pure: the screen asks
 * and acts.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string

export interface LeaveConfirmCopy {
  title: string
  message: string
  confirmLabel: string
  variant: 'danger' | 'default'
}

/** The whole computer leaves; `memberNames` are its digital humans in the team. */
export function leaveTeamConfirm(teamName: string, memberNames: readonly string[], t: Translate): LeaveConfirmCopy {
  const count = memberNames.length
  const message = count > 1
    ? t('All {{count}} of your digital humans leave this team with you: {{names}}. They go back to being just yours — they, their spaces, and everything in them are untouched, and the duty you wrote for each of them here is kept on your computer for when it joins this team again. What is deleted is this team’s record on your computer: what it did, and any periodic checks teammates set on your digital humans. To take part again you will need an invite link.', { count, names: memberNames.join(', ') })
    : count === 1
      ? t('{{name}} leaves this team with you and goes back to being just yours — it, its space, and everything in it are untouched, and the duty you wrote for it here is kept on your computer for when it joins this team again. What is deleted is this team’s record on your computer: what it did, and any periodic checks teammates set on your digital human. To take part again you will need an invite link.', { name: memberNames[0] })
      : t('Your digital humans stop working in this team and go back to being just yours — they, their spaces, and everything in them are untouched. What is deleted is this team\u2019s record on your computer: what it did, and any periodic checks teammates set on your digital humans. To take part again you will need an invite link.')
  return {
    title: t('Leave {{name}}?', { name: teamName }),
    message,
    confirmLabel: count > 1 ? t('Leave with all {{count}}', { count }) : t('Leave'),
    variant: count > 1 ? 'danger' : 'default',
  }
}

/** One digital human leaves; this computer's others stay in the team. */
export function withdrawMemberConfirm(teamName: string, memberName: string, t: Translate): LeaveConfirmCopy {
  return {
    title: t('Remove {{name}} from {{team}}?', { name: memberName, team: teamName }),
    message: t('Only {{name}} leaves — your other digital humans stay in this team. {{name}} itself, its space, and everything in it are untouched, and the duty you wrote for it here is kept on your computer: if it joins this team again, the duty comes back. Bringing it back needs an invite link.', { name: memberName }),
    confirmLabel: t('Remove'),
    variant: 'default',
  }
}

/** The line under the leave button, read before it is pressed. */
export function leaveTeamHint(memberCount: number, t: Translate): string {
  return memberCount > 1
    ? t('Takes all {{count}} of your digital humans out of this team. To take out just one, use the button on it under Members.', { count: memberCount })
    : t('Stop taking part. Your digital humans stay yours.')
}
