/**
 * The timeline note of a run that did not start because connections it
 * declares are unusable: which ones and why, in the user's language, and the
 * way to the settings where they are installed, turned on or switched off.
 */

import type { TFunction } from 'i18next'
import type { MissingConnection } from '../../../shared/apps/app-types'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation } from '../../i18n'

function describe(connection: MissingConnection, t: TFunction): string {
  const name = connection.name
  switch (connection.state) {
    case 'not_installed': return t('{{name}}: not installed', { name })
    case 'disabled': return t('{{name}}: turned off', { name })
    case 'needs_login': return t('{{name}}: waiting for sign-in', { name })
    case 'error': return t('{{name}}: connection failing', { name })
  }
}

export function MissingConnectionsNote({ appId, missing }: { appId: string; missing: MissingConnection[] }) {
  const { t } = useTranslation()
  const openAppConfigAt = useAppsPageStore(s => s.openAppConfigAt)
  return (
    <div className="space-y-1.5">
      <p className="text-sm">{t('This run did not start: a connection it needs is unavailable.')}</p>
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        {missing.map(connection => <li key={connection.id} className="break-words">{describe(connection, t)}</li>)}
      </ul>
      <p className="text-xs text-muted-foreground">
        {t('Install or turn it on in this digital human’s Tools & Resources, or switch it off there if it can work without it.')}
      </p>
      <button
        onClick={() => openAppConfigAt(appId, 'settings-group-tools')}
        className="min-h-8 text-xs font-medium text-primary hover:underline"
      >
        {t('Open Tools & Resources')}
      </button>
    </div>
  )
}
