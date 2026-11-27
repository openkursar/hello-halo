/**
 * The organization sign-in offered among the model logins while signed out.
 * Selecting it opens the organization's own sign-in window.
 */
import { Building2 } from 'lucide-react'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { useOrgSignInStore } from '../../stores/org-sign-in.store'
import { AISourceInlinePanel } from '../settings/AISourceInlinePanel'
import { joinLabels } from './org-sign-in-view'

export function OrgSignInOption({ busy }: { busy: boolean }) {
  const { t } = useTranslation()
  const state = useOrgSignInStore(s => s.state)
  const lastResult = useOrgSignInStore(s => s.lastResult)
  const signIn = useOrgSignInStore(s => s.signIn)
  const name = state?.name || t('Organization')
  const labels = state?.capabilities.map(capability => capability.label) ?? []
  const description = state?.signingIn
    ? t('Waiting for sign-in…')
    : labels.length ? t('One sign-in for {{list}}', { list: joinLabels(labels, getCurrentLanguage()) }) : t('Sign in with your organization account')
  return (
    <div data-testid="org-sign-in-option">
      <AISourceInlinePanel
        id="organization-sign-in"
        title={name}
        description={description}
        icon={<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary"><Building2 size={20} className="text-muted-foreground" /></div>}
        open={false}
        busy={busy || state?.signingIn}
        onOpen={() => void signIn()}
      />
      {lastResult === 'failed' && <p role="alert" className="mt-1 pl-1 text-xs text-halo-warning">{t('Sign-in did not complete. Please try again.')}</p>}
      {lastResult === 'expired' && <p role="alert" className="mt-1 pl-1 text-xs text-halo-warning">{t('The sign-in page timed out. Please try again.')}</p>}
    </div>
  )
}
