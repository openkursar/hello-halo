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
import { AutomationAvatar } from './AutomationAvatar'
import { PersonStatusDot } from './PersonStatusDot'
import { automationStatusTextClass, describePersonStatus } from '../../utils/automation-status'
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
        const spec = resolveSpecI18n(app.spec, language)
        const name = spec.name || app.id
        const state = appStates[app.id]
        const pending = state?.pendingDecisionCount ?? 0
        const { effective, label, flag } = describePersonStatus(app.status, state, t)
        const flagTone = flag === 'alert'
          ? { text: 'text-halo-error', badge: 'bg-halo-error/15 text-halo-error' }
          : { text: 'text-halo-warning', badge: 'bg-halo-warning/15 text-halo-warning' }
        return {
          id: app.id,
          name,
          description: spec.description,
          status: (
            <>
              <PersonStatusDot appStatus={app.status} effective={effective} flag={flag} />
              <span className={flag ? flagTone.text : automationStatusTextClass(effective)}>{label}</span>
            </>
          ),
          // Same generated face as the directory card and detail header.
          icon: <AutomationAvatar name={name} size={26} />,
          flag,
          dimmed: app.status === 'paused',
          // Same dot as every other row; only open questions add their count.
          trailing: flag ? (
            pending > 0 ? (
              <span className={`flex-shrink-0 rounded-full px-1.5 text-[11px] tabular-nums ${flagTone.badge}`}>{pending}</span>
            ) : (
              <PersonStatusDot appStatus={app.status} effective={effective} flag={flag} />
            )
          ) : (
            <PersonStatusDot appStatus={app.status} effective={effective} />
          ),
        }
      }),
    [apps, appStates, teams, language, t]
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
