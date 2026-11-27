/**
 * DigitalHumansTab - digital-human content for the space resource rail
 *
 * Read-only list of the digital humans installed in this space. They all
 * belong to it, so rows carry no scope badge, unlike the Skill and MCP tabs.
 * Management (pause/uninstall/move) stays on the digital-humans page.
 *
 * Row interaction:
 * - Row click → the app's detail overview page (the detail page is the
 *   observation surface; chat lives on the main conversation board).
 * - Hover reveals a "Chat" pill → continues this digital human's latest
 *   conversation on the main board (starting one when it has none), like every
 *   other "Chat" button. A team lead is listed with its mark but has no pill:
 *   its work arrives through the team, and the input's selector does not offer
 *   it either.
 */

import { useEffect, useMemo } from 'react'
import { Bot } from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useAppStore } from '../../stores/app.store'
import { useSpaceStore } from '../../stores/space.store'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { automationStatusLabel, deriveAutomationStatus, personRuntimeStatus } from '../../utils/automation-status'
import { AutomationAvatar } from '../apps/AutomationAvatar'
import { SpaceResourceRow } from './SpaceResourceRow'
import { openDigitalHumanChat } from '../../utils/conversation-navigation'
import { useSpaceDigitalHumans } from '../../hooks/useSpaceDigitalHumans'
import { useTeamStore } from '../../stores/team.store'
import { coordinatorIds } from '../../utils/people-model'
import { api } from '../../api'
import { markEntry, trackHome, trackNavigate } from '../../services/home-telemetry'

interface DigitalHumansTabProps {
  onItemsChange?: (count: number) => void
}

export function DigitalHumansTab({ onItemsChange }: DigitalHumansTabProps) {
  const { t } = useTranslation()
  const spaceId = useSpaceStore(state => state.currentSpace?.id ?? '')
  const appStates = useAppsStore(s => s.appStates)
  const digitalHumans = useSpaceDigitalHumans(spaceId, { includeCoordinators: true })
  const teams = useTeamStore(s => s.teams)
  const coordinators = useMemo(() => coordinatorIds(teams), [teams])

  useEffect(() => {
    onItemsChange?.(digitalHumans.length)
  }, [onItemsChange, digitalHumans.length])

  const handleOpenOverview = (appId: string) => {
    trackHome('home.rail.item.click', { tab: 'digital-humans', action: 'open', appId })
    trackNavigate('apps', 'rail_tab', 'home_rail_dh')
    useAppsPageStore.getState().setCurrentTab('my-digital-humans')
    useAppsPageStore.getState().openActivityThread(appId)
    useAppStore.getState().navigate('apps')
  }

  const handleOpenChat = (appId: string, appSpaceId: string) => {
    trackHome('home.rail.item.click', { tab: 'digital-humans', action: 'chat', appId })
    markEntry('home_rail_dh')
    return openDigitalHumanChat(appId, appSpaceId)
  }

  if (digitalHumans.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8">
        <Bot className="w-8 h-8 text-muted-foreground/40 mb-2" />
        <p className="text-xs text-muted-foreground">{t('No digital humans in this workspace yet.')}</p>
      </div>
    )
  }

  return (
    <div className="py-2 px-1.5 space-y-1.5 overflow-y-auto h-full">
      {digitalHumans.map(app => {
        const { name, description } = resolveSpecI18n(app.spec, getCurrentLanguage())
        const effectiveStatus = deriveAutomationStatus(app.status, personRuntimeStatus(appStates[app.id]))
        const status = automationStatusLabel(effectiveStatus, t)
        const coordinator = coordinators.has(app.id)
        return (
          <SpaceResourceRow
            key={app.id}
            icon={<AutomationAvatar name={name || app.id} size={26} />}
            bareIcon
            name={name || app.id}
            description={coordinator ? `${t('Team lead')} · ${status}` : status}
            onClick={() => handleOpenOverview(app.id)}
            onUse={coordinator ? undefined : () => { if (app.spaceId) void handleOpenChat(app.id, app.spaceId) }}
            useLabel={t('Chat')}
          />
        )
      })}
    </div>
  )
}
