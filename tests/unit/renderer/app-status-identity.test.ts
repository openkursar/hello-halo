import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/renderer/api', () => ({
  api: new Proxy({}, { get: () => vi.fn() }),
}))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (s: string) => s } }))

const { useAppsStore, sameAppState } = await import('../../../src/renderer/stores/apps.store')

function app(id: string, status: string) {
  return { id, status, spec: { name: id } } as never
}

describe('app:status_changed keeps object identity when nothing changed', () => {
  beforeEach(() => {
    useAppsStore.setState({
      apps: [app('a', 'active'), app('b', 'active')],
      appStates: { a: { status: 'idle', runningCount: 0 }, b: { status: 'idle', runningCount: 0 } },
    })
  })

  it('an unchanged push leaves every reference as it was', () => {
    const before = useAppsStore.getState()
    useAppsStore.getState().handleStatusChanged('a', { status: 'idle', runningCount: 0 })
    const after = useAppsStore.getState()
    expect(after.appStates).toBe(before.appStates)
    expect(after.apps).toBe(before.apps)
  })

  it('a changed push replaces only that app; the others keep identity', () => {
    const before = useAppsStore.getState()
    useAppsStore.getState().handleStatusChanged('a', { status: 'running', runningCount: 1 })
    const after = useAppsStore.getState()
    expect(after.appStates.a).toEqual({ status: 'running', runningCount: 1 })
    expect(after.appStates.b).toBe(before.appStates.b)
    // running still maps to an active app, so the app list is untouched.
    expect(after.apps).toBe(before.apps)

    useAppsStore.getState().handleStatusChanged('a', { status: 'paused', runningCount: 0 })
    const paused = useAppsStore.getState()
    expect(paused.apps[0]).toMatchObject({ id: 'a', status: 'paused' })
    expect(paused.apps[1]).toBe(before.apps[1])
  })

  it('never lets a push undo an uninstall', () => {
    useAppsStore.setState({ apps: [app('a', 'uninstalled')] })
    const before = useAppsStore.getState().apps
    useAppsStore.getState().handleStatusChanged('a', { status: 'paused' })
    expect(useAppsStore.getState().apps).toBe(before)
  })

  it('compares field by field', () => {
    expect(sameAppState({ status: 'idle', nextRunAtMs: 5 }, { status: 'idle', nextRunAtMs: 5 })).toBe(true)
    expect(sameAppState({ status: 'idle', nextRunAtMs: 5 }, { status: 'idle', nextRunAtMs: 6 })).toBe(false)
    expect(sameAppState({ status: 'idle' }, { status: 'idle', blocked: 'needs_login' })).toBe(false)
    expect(sameAppState(undefined, { status: 'idle' })).toBe(false)
  })
})
