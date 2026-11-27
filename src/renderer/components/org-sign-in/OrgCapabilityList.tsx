import { useTranslation } from '../../i18n'
import type { OrgCapabilityView } from '../../../shared/types/enterprise-identity'

/** Each capability with whether it works now; shared by the composer popover and the settings card. */
export function OrgCapabilityList({ capabilities, compact = false }: { capabilities: OrgCapabilityView[]; compact?: boolean }) {
  const { t } = useTranslation()
  const signedIn = capabilities.some(capability => capability.status !== 'missing')
  return (
    <ul className={compact ? 'space-y-1' : 'space-y-2'}>
      {capabilities.map(capability => {
        const text = capability.status === 'ready'
          ? t('Connected')
          : capability.status === 'expired' ? t('Expired, sign in again') : signedIn ? t('Not included') : t('Not signed in')
        const tone = capability.status === 'ready'
          ? 'text-green-600 dark:text-green-400'
          : capability.status === 'expired' ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground'
        return (
          <li key={capability.id} className="flex items-center justify-between gap-3 text-sm" data-testid="org-capability" data-status={capability.status}>
            <span className="truncate min-w-0">{capability.label}</span>
            <span className={`shrink-0 whitespace-nowrap text-xs ${tone}`}>{text}</span>
          </li>
        )
      })}
    </ul>
  )
}
