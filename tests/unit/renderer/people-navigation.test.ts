import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ api: { appGetActivityEntry: vi.fn() }, people: {} as Record<string, unknown>, page: { currentTab: 'my-digital-humans', selectedAppId: 'previous', setInitialAppId: vi.fn(), setCurrentTab: vi.fn(), openActivityThread: vi.fn(), openSessionDetail: vi.fn() }, selectTeam: vi.fn(), upsert: vi.fn(), setView: vi.fn() }))
vi.mock('../../../src/renderer/api', () => ({ api: state.api }))
vi.mock('../../../src/renderer/stores/people-view.store', () => ({ usePeopleViewStore: { setState: (patch: object) => Object.assign(state.people, patch) } }))
vi.mock('../../../src/renderer/stores/apps-page.store', () => ({ useAppsPageStore: { getState: () => state.page } }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: { getState: () => ({ handleNewActivityEntry: state.upsert }) } }))
vi.mock('../../../src/renderer/stores/team.store', () => ({ useTeamStore: { getState: () => ({ selectTeam: state.selectTeam }) } }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: { getState: () => ({ setView: state.setView }) } }))
import { openWorkNotification } from '../../../src/renderer/utils/people-navigation'
beforeEach(() => { vi.clearAllMocks(); state.people = {}; state.page.currentTab = 'my-digital-humans' })
it('resolves the canonical team task and decision instead of opening an unrelated person execution', async () => {
  const entry = { id: 'question', type: 'escalation', content: { source: { kind: 'team', teamId: 'real-team', epochId: 'real-task' } } }
  state.api.appGetActivityEntry.mockResolvedValue({ success: true, data: entry })
  await openWorkNotification({ appId: 'person', entryId: 'question', teamId: 'old-team' })
  expect(state.upsert).toHaveBeenCalledWith('person', entry)
  expect(state.people.teamTarget).toEqual({ teamId: 'real-team', epochId: 'real-task', appId: 'person', entryId: 'question', decision: true })
  expect(state.people.returnPerson).toBe('previous')
  expect(state.page.openActivityThread).not.toHaveBeenCalled()
})
it('keeps a report an activity anchor and preserves an inbox return destination', async () => {
  state.page.currentTab = 'inbox'
  state.api.appGetActivityEntry.mockResolvedValue({ success: true, data: { type: 'output', content: { source: { kind: 'team', teamId: 'team', epochId: 'task' } } } })
  await openWorkNotification({ appId: 'person', entryId: 'report' })
  expect(state.people.teamTarget).toMatchObject({ entryId: 'report', decision: false })
  expect(state.people.returnInbox).toBe(true)
})
it('opens an exact independent request and preserves app-only legacy notification behavior', async () => {
  state.api.appGetActivityEntry.mockResolvedValue({ success: true, data: { type: 'escalation', content: { source: { kind: 'automation' } } } })
  await openWorkNotification({ appId: 'person', entryId: 'question' })
  expect(state.people.focusEntry).toEqual({ appId: 'person', entryId: 'question' })
  expect(state.page.openActivityThread).toHaveBeenCalledWith('person')
  await openWorkNotification({ appId: 'legacy' })
  expect(state.page.openActivityThread).toHaveBeenLastCalledWith('legacy')
})
