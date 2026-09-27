import { beforeEach, describe, expect, it, vi } from 'vitest'
const env = vi.hoisted(() => ({ api: {} as Record<string, any> }))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/stores/notification.store', () => ({ useNotificationStore: { getState: () => ({ show: vi.fn() }) } }))
import { useAppsStore } from '../../../src/renderer/stores/apps.store'
import type { ActivityEntry } from '../../../src/shared/apps/app-types'
const request = (id: string): ActivityEntry => ({ id, appId: 'person', runId: 'run', type: 'escalation', ts: 1, content: { summary: 'Decide' } })
beforeEach(() => {
  useAppsStore.setState({ apps: [], appStates: {}, activityEntries: {}, pendingEntries: {}, activityErrors: {} })
  env.api.appGetState = vi.fn().mockResolvedValue({ success: true, data: { status: 'paused', automaticEnabled: false } })
})
describe('decision state across surfaces', () => {
  it('does not resurrect a request from a pending snapshot started before the answer event', async () => {
    const entry = request('race-answer')
    let resolve!: (value: unknown) => void
    env.api.appGetPendingEntries = vi.fn().mockReturnValue(new Promise(done => { resolve = done }))
    const loading = useAppsStore.getState().loadPending('person')
    useAppsStore.getState().handleNewActivityEntry('person', { ...entry, userResponse: { ts: 10, text: 'Yes' } })
    resolve({ success: true, data: [entry] })
    await loading
    expect(useAppsStore.getState().pendingEntries.person).toEqual([])
    expect(useAppsStore.getState().activityEntries.person[0].userResponse?.text).toBe('Yes')
  })
  it('keeps a failed continuation visible as answered and removes only that pending request', () => {
    const first = request('first'), second = request('second')
    useAppsStore.getState().handleNewActivityEntry('person', first)
    useAppsStore.getState().handleNewActivityEntry('person', second)
    useAppsStore.getState().handleNewActivityEntry('person', { ...first, userResponse: { ts: 2, text: 'Okay' }, continuation: { status: 'failed', attempts: 1, updatedAt: 3, error: 'Workspace unavailable' } })
    expect(useAppsStore.getState().pendingEntries.person.map(entry => entry.id)).toEqual(['second'])
    expect(useAppsStore.getState().activityEntries.person.find(entry => entry.id === 'first')?.continuation?.status).toBe('failed')
  })
  it('uses the server timestamp and saved continuation for a successful answer', async () => {
    const canonical = { ...request('canonical'), userResponse: { ts: 42, text: 'Agreed' }, continuation: { status: 'queued' as const, attempts: 0, updatedAt: 43 } }
    env.api.appRespondEscalation = vi.fn().mockResolvedValue({ success: true, data: canonical })
    env.api.appGetPendingEntries = vi.fn().mockResolvedValue({ success: true, data: [] })
    expect(await useAppsStore.getState().respondToEscalation('person', 'canonical', { text: 'Agreed' })).toBe(true)
    expect(useAppsStore.getState().activityEntries.person[0]).toEqual(canonical)
    expect(useAppsStore.getState().appStates.person.automaticEnabled).toBe(false)
  })
})

it('paginates same-millisecond pending requests by the server cursor after earlier answers disappear', async () => {
  const page = Array.from({ length: 100 }, (_, index) => request(`cursor-${String(index).padStart(3, '0')}`))
  env.api.appGetPendingEntries = vi.fn().mockResolvedValueOnce({ success: true, data: page }).mockResolvedValueOnce({ success: true, data: [request('cursor-100')] })
  await useAppsStore.getState().loadPending('person')
  useAppsStore.getState().handleNewActivityEntry('person', { ...page[0], userResponse: { ts: 2, text: 'Done' } })
  await useAppsStore.getState().loadMorePending('person')
  expect(env.api.appGetPendingEntries).toHaveBeenLastCalledWith('person', { limit: 100, afterTs: 1, afterId: 'cursor-099' })
  expect(useAppsStore.getState().pendingEntries.person).toHaveLength(100)
  expect(useAppsStore.getState().pendingEntries.person.map(entry => entry.id)).not.toContain('cursor-000')
  expect(useAppsStore.getState().pendingEntries.person.at(-1)?.id).toBe('cursor-100')
})

it('hydrates only the selected person into the full-record cache without listing every app', async () => {
  const person = { id: 'person-selected', spec: { type: 'automation', name: 'Selected' }, status: 'paused' }
  env.api.appGet = vi.fn().mockResolvedValue({ success: true, data: person })
  env.api.appList = vi.fn()
  await useAppsStore.getState().refreshApp('person-selected')
  expect(useAppsStore.getState().apps).toEqual([person])
  expect(env.api.appList).not.toHaveBeenCalled()
  await useAppsStore.getState().refreshApp('person-selected')
  expect(useAppsStore.getState().apps).toHaveLength(1)
})
