/**
 * PeopleSwitcher — DetailSwitcher rows for digital humans: stable install
 * order, with a status dot or a "needs you" count on each row.
 */

import { useEffect, useMemo } from 'react'
import { useAppsStore } from '../../stores/apps.store'
import { useTeamStore } from '../../stores/team.store'
import { visibleDigitalHumans } from '../../utils/people-model'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { needsAttention } from '../../../shared/apps/app-types'
import { AppTypeIcon } from '../store/AppTypeIcon'
import { AppStatusDot } from './AppStatusDot'
import { DetailSwitcher, type DetailSwitcherItem } from './DetailSwitcher'

interface PeopleSwitcherProps {
  selectedAppId: string
  onSelect: (appId: string) => void
}

export function PeopleSwitcher({ selectedAppId, onSelect }: PeopleSwitcherProps) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const appStates = useAppsStore(s => s.appStates)
  const teams = useTeamStore(s => s.teams)

  // A deep link (notification, team) loads only the opened person; runtime
  // states for everyone come from startup and live status events.
  useEffect(() => {
    const store = useAppsStore.getState()
    if (!store.hasFullList) void store.loadApps()
  }, [])

  const language = getCurrentLanguage()
  const items = useMemo<DetailSwitcherItem[]>(
    () => visibleDigitalHumans(apps, teams)
      .filter(app => app.status !== 'uninstalled')
      .map(app => {
        const name = resolveSpecI18n(app.spec, language).name || app.id
        const state = appStates[app.id]
        const flagged = needsAttention(state)
        const pending = state?.pendingDecisionCount ?? 0
        return {
          id: app.id,
          name,
          icon: <AppTypeIcon type="automation" icon={app.spec.icon} name={name} size="xs" />,
          flagged,
          dimmed: app.status === 'paused',
          trailing: flagged ? (
            <span className="flex-shrink-0 rounded-full bg-halo-warning/15 px-1.5 text-[11px] tabular-nums text-halo-warning">
              {pending > 0 ? pending : '!'}
            </span>
          ) : (
            <AppStatusDot status={app.status} runtimeStatus={state?.status} size="sm" className="flex-shrink-0" />
          ),
        }
      }),
    [apps, appStates, teams, language]
  )

  return (
    <DetailSwitcher
      title={t('Digital Humans')}
      searchPlaceholder={t('Search digital humans')}
      items={items}
      selectedId={selectedAppId}
      onSelect={onSelect}
    />
  )
}
