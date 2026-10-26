import type { RosterMember } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'

/** Guidance uses current reachability; the activity view keeps receipt details separate. */
export function UndeliveredNote({ recipient, taskCompleted = false, className }: {
  recipient: RosterMember | undefined
  taskCompleted?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const text = (() => {
    if (!recipient) return t('This message was not delivered.')
    const member = recipient.memberName
    if (taskCompleted) return t('{{member}} did not receive this message.', { member })
    if (recipient.sameMachine !== false) return t('{{member}} did not receive this message. Send it again, or assign the work to another member.', { member })
    const owner = recipient.owner?.trim() || t('A teammate')
    return recipient.presence === 'offline'
      ? t('{{member}} did not receive this message. {{owner}}’s computer is offline right now; once it is back online, send it again, or assign the work to another member.', { member, owner })
      : t('{{member}} did not receive this message. Send it again, or assign the work to another member.', { member })
  })()
  return <p className={className}>{text}</p>
}
