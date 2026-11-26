import { useTranslation } from '../../i18n'
import type { OrgSignInNotice as Notice } from './org-sign-in-view'

export function OrgSignInNotice({ notice }: { notice: Notice }) {
  const { t } = useTranslation()
  const warning = notice === 'withdrawal' || notice === 'issue-failed'
  const text = (() => {
    switch (notice) {
      case 'withdrawal': return t('Earlier access may still work until it expires.')
      case 'incompatible': return t('The organization sign-in component is incompatible with this version of Halo.')
      case 'temporary': return t('Organization sign-in is temporarily unavailable. Halo keeps working.')
      case 'issue-failed': return t('Some tools could not get access with this sign-in.')
      case 'read-failed': return t('Could not check your organization sign-in.')
      case 'pending': return t('Checking your sign-in…')
    }
  })()
  return <p className={`text-sm ${warning ? 'text-halo-warning' : 'text-muted-foreground'}`}>{text}</p>
}
