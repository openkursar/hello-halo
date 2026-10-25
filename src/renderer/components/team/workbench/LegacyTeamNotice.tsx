import type { TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'

export function LegacyTeamNotice({ recovery, repairing, onRetry, onCreate, onReturn }: {
  recovery: NonNullable<TeamDetail['legacyCoordinator']>
  repairing: boolean
  onRetry: () => void
  onCreate: () => void
  onReturn?: () => void
}) {
  const { t } = useTranslation()
  const message = recovery.ownedHere
    ? repairing
      ? t('Repairing your previously saved team…')
      : recovery.repairDeferred
        ? t('This team is still working in its original conversation. Let it finish or stop it there, then retry the repair. Your current work is unchanged.')
        : t('This old team could not be repaired. Retry, or create a new team. Your existing records are unchanged.')
    : recovery.ownerName
      ? t('This team was saved by an older version. Ask {{owner}} to update their client and reopen this team for automatic repair. You do not need to update.', { owner: recovery.ownerName })
      : t('This team was saved by an older version. Ask its creator, another teammate, to update their client and reopen this team for automatic repair. You do not need to update.')
  return <div role="status" className="shrink-0 border-b border-border bg-halo-warning/5 px-4 py-3 text-sm">
    <p className="break-words leading-6">{message}</p>
    {recovery.ownedHere && <div className="mt-2 flex flex-wrap gap-2">
      <button disabled={repairing} onClick={onRetry} className="min-h-9 rounded-lg border border-border px-3 text-primary disabled:opacity-50">{t('Retry')}</button>
      {recovery.repairDeferred && onReturn
        ? <button onClick={onReturn} className="min-h-9 rounded-lg border border-border px-3 text-primary">{t('Return to conversation')}</button>
        : <button disabled={repairing} onClick={onCreate} className="min-h-9 rounded-lg border border-border px-3 text-primary disabled:opacity-50">{t('New team')}</button>}
    </div>}
  </div>
}
