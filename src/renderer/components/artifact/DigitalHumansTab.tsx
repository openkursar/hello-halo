/**
 * DigitalHumansTab - digital-human content for the space resource rail
 *
 * Read-only list of automation apps usable in this space: installed in the
 * space itself or globally; each carries a badge naming its scope — the
 * dual-scope convention shared with the Skill and MCP tabs.
 * Management (pause/uninstall/move) stays on the digital-humans page.
 *
 * Row interaction:
 * - Row click → the app's detail overview page (the detail page is the
 *   observation surface; chat lives on the main conversation board).
 * - Hover reveals a "Chat" pill → starts a new conversation with this digital
 *   human on the main board, mirroring what the input's own selector does.
 */

import { Bot } from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useAppStore } from '../../stores/app.store'
import { useSpaceStore } from '../../stores/space.store'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { automationStatusLabel, deriveAutomationStatus } from '../../utils/automation-status'
import { AutomationAvatar } from '../apps/AutomationAvatar'
import { SpaceResourceRow } from './SpaceResourceRow'
import { navigateToAppChat, startDigitalHumanConversation } from '../../utils/conversation-navigation'
import { useSpaceDigitalHumans } from '../../hooks/useSpaceDigitalHumans'
import { api } from '../../api'

export function DigitalHumansTab() {
  const { t } = useTranslation()
  const spaceId = useSpaceStore(state => state.currentSpace?.id ?? '')
  const appStates = useAppsStore(s => s.appStates)
  const digitalHumans = useSpaceDigitalHumans(spaceId)

  const handleOpenOverview = (appId: string) => {
    useAppsPageStore.getState().setCurrentTab('my-digital-humans')
    useAppsPageStore.getState().openActivityThread(appId)
    useAppStore.getState().navigate('apps')
  }

  // Starts a fresh session rather than reopening the app's existing one:
  // acting on a digital human from a browsing surface means "talk to it now",
  // and resuming a past conversation is the left list's job.
  const handleOpenChat = async (appId: string, appSpaceId: string | null) => {
    const conversationId = await startDigitalHumanConversation(appId)
    if (conversationId) navigateToAppChat(appSpaceId, appId, conversationId)
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
        const effectiveStatus = deriveAutomationStatus(app.status, appStates[app.id]?.status)
        return (
          <SpaceResourceRow
            key={app.id}
            icon={<AutomationAvatar name={name || app.id} size={26} />}
            bareIcon
            name={name || app.id}
            description={automationStatusLabel(effectiveStatus, t)}
            scope={app.spaceId === null ? 'global' : 'space'}
            onClick={() => handleOpenOverview(app.id)}
            onUse={() => { void handleOpenChat(app.id, app.spaceId) }}
            useLabel={t('Chat')}
          />
        )
      })}
    </div>
  )
}
