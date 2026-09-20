import { api } from '../api'
import { useAppsStore } from '../stores/apps.store'
import { useAppsPageStore } from '../stores/apps-page.store'
import { usePeopleViewStore, type TeamNavigationTarget } from '../stores/people-view.store'
import { useTeamStore } from '../stores/team.store'
import { useAppStore } from '../stores/app.store'

export function openPersonTeam(target: TeamNavigationTarget, returnPerson: string | null = null) {
  usePeopleViewStore.setState({ teamTarget: target, returnPerson, returnInbox: useAppsPageStore.getState().currentTab === 'inbox', returnTeam: null })
  useTeamStore.getState().selectTeam(target.teamId)
  useAppsPageStore.getState().setCurrentTab('team')
  useAppStore.getState().setView('apps')
}

export interface WorkNavigationTarget {
  appId: string
  entryId?: string
  teamId?: string
  epochId?: string
  runId?: string
}

export async function openWorkNotification(target: WorkNavigationTarget) {
  let decision: boolean | undefined
  if (target.entryId) {
    try {
      const result = await api.appGetActivityEntry(target.appId, target.entryId)
      if (result.success && result.data) {
        const entry = result.data
        useAppsStore.getState().handleNewActivityEntry(target.appId, entry)
        decision = entry.type === 'escalation'
        target = { ...target, teamId: entry.content.source?.teamId ?? entry.content.teamContext?.teamId ?? target.teamId, epochId: entry.content.source?.epochId ?? entry.content.teamContext?.epochId ?? target.epochId }
      } else console.warn('[PeopleNavigation] Notification record unavailable', { appId: target.appId, entryId: target.entryId, error: result.error })
    } catch (error) { console.warn('[PeopleNavigation] Notification record lookup failed', { appId: target.appId, entryId: target.entryId, error }) }
  }
  useAppsPageStore.getState().setInitialAppId(null)
  if (target.teamId) {
    const current = useAppsPageStore.getState()
    openPersonTeam({ teamId: target.teamId, epochId: target.epochId, appId: target.appId, entryId: target.entryId, decision }, current.currentTab === 'my-digital-humans' ? current.selectedAppId : null)
    return
  }
  useAppsPageStore.getState().setCurrentTab('my-digital-humans')
  if (target.entryId) {
    usePeopleViewStore.setState({ focusEntry: { appId: target.appId, entryId: target.entryId } })
    useAppsPageStore.getState().openActivityThread(target.appId)
  } else if (target.runId) useAppsPageStore.getState().openSessionDetail(target.appId, target.runId)
  else useAppsPageStore.getState().openActivityThread(target.appId)
  useAppStore.getState().setView('apps')
}
