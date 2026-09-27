import { beforeEach, expect, it, vi } from 'vitest'
const env = vi.hoisted(() => ({ appListPeople: vi.fn() }))
vi.mock('../../../src/renderer/api', () => ({ api: env }))
import { usePeopleDirectoryStore } from '../../../src/renderer/stores/people-directory.store'
beforeEach(() => { vi.clearAllMocks(); usePeopleDirectoryStore.setState({ data: null, query: null, loading: false, error: false }) })
it('keeps a later search result when an earlier bounded page arrives late', async () => {
  let finish!: (result: unknown) => void
  env.appListPeople.mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValueOnce({ success: true, data: { items: [{ id: 'match' }], total: 1 } })
  const old = usePeopleDirectoryStore.getState().load({ offset: 24, limit: 24 })
  await usePeopleDirectoryStore.getState().load({ q: 'evidence', offset: 0, limit: 24 })
  finish({ success: true, data: { items: [{ id: 'old' }], total: 200 } })
  await old
  expect(usePeopleDirectoryStore.getState().data?.items.map(person => person.id)).toEqual(['match'])
  expect(env.appListPeople).toHaveBeenLastCalledWith({ q: 'evidence', offset: 0, limit: 24 })
})
it('retains the last useful page and the exact query for a failed refresh retry', async () => {
  env.appListPeople.mockResolvedValueOnce({ success: true, data: { items: [{ id: 'person' }], total: 1 } }).mockResolvedValueOnce({ success: false, error: 'offline' })
  const query = { teamId: 'team', attention: true, limit: 24, offset: 0 }
  await usePeopleDirectoryStore.getState().load(query)
  await usePeopleDirectoryStore.getState().refresh()
  expect(usePeopleDirectoryStore.getState().error).toBe(true)
  expect(usePeopleDirectoryStore.getState().data?.items[0].id).toBe('person')
  expect(env.appListPeople).toHaveBeenLastCalledWith(query)
})
