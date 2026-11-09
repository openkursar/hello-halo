/**
 * The route store listens to the router only while a group conversation is on
 * screen, shares one listener between viewers, and reads what the router
 * already knows when a view opens late.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  listeners: [] as Array<(report: unknown) => void>,
  wsListeners: new Set<(state: string) => void>(),
  desktop: false,
  stops: 0,
  routes: vi.fn(),
}))

vi.mock('../../../src/renderer/api', () => ({
  api: {
    onAIGroupRoute: (callback: (report: unknown) => void) => {
      env.listeners.push(callback)
      return () => {
        env.stops += 1
        env.listeners.splice(env.listeners.indexOf(callback), 1)
      }
    },
    aiGroupsRoutes: env.routes,
    onWsStateChange: (listener: (state: string) => void) => {
      env.wsListeners.add(listener)
      return () => { env.wsListeners.delete(listener) }
    },
  },
}))

vi.mock('../../../src/renderer/api/transport', () => ({ isElectron: () => env.desktop }))

import { loadGroupRoutes, useGroupRouteStore, watchGroupRoutes } from '../../../src/renderer/stores/ai-group-route.store'
import type { GroupRouteInfo } from '../../../src/shared/types/ai-groups-runtime'

const report = (sessionKey: string, at: number): GroupRouteInfo => ({ groupId: 'g1', sessionKey, state: 'serving', at })

beforeEach(() => {
  env.listeners.length = 0
  env.wsListeners.clear()
  env.desktop = false
  env.stops = 0
  env.routes.mockReset().mockResolvedValue({ success: true, data: [] })
  useGroupRouteStore.setState({ routes: {} })
})

describe('watching the router', () => {
  it('listens once for any number of viewers and stops with the last one', () => {
    const first = watchGroupRoutes(['c1', 's1'])
    const second = watchGroupRoutes(['c1', 's1'])
    expect(env.listeners).toHaveLength(1)
    first()
    expect(env.stops).toBe(0)
    second()
    expect(env.stops).toBe(1)
    expect(env.listeners).toHaveLength(0)
  })

  it('counts a viewer leaving twice only once', () => {
    const first = watchGroupRoutes(['c1', 's1'])
    const second = watchGroupRoutes(['c1', 's1'])
    first()
    first()
    expect(env.stops).toBe(0)
    second()
    expect(env.stops).toBe(1)
  })

  it('keeps what the router reports while someone watches', () => {
    const stop = watchGroupRoutes(['c1', 's1'])
    env.listeners[0](report('c1', 5))
    expect(useGroupRouteStore.getState().routes.c1.at).toBe(5)
    stop()
  })

  it('listens again after everyone has left and someone returns', () => {
    watchGroupRoutes(['c1', 's1'])()
    const stop = watchGroupRoutes(['c1', 's1'])
    expect(env.listeners).toHaveLength(1)
    stop()
  })
})

describe('recovering the visible routes', () => {
  const reconnect = async () => {
    for (const state of ['disconnected', 'connecting', 'connected']) {
      env.wsListeners.forEach(listener => listener(state))
    }
    await new Promise(resolve => setImmediate(resolve))
  }

  it('recovers the first reconnect even when views mounted after the initial connection', async () => {
    const stop = watchGroupRoutes(['c1', 'native-cc'])
    try {
      useGroupRouteStore.getState().ingest([report('native-cc', 1)])
      env.routes.mockResolvedValue({ success: true, data: [report('native-cc', 2)] })
      await reconnect()
      expect(env.routes).toHaveBeenCalledTimes(1)
      expect(env.routes).toHaveBeenCalledWith(['c1', 'native-cc'])
      expect(useGroupRouteStore.getState().routes['native-cc'].at).toBe(2)
      env.wsListeners.forEach(listener => listener('connected'))
      await new Promise(resolve => setImmediate(resolve))
      expect(env.routes).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
    expect(env.wsListeners.size).toBe(0)
  })

  it('coalesces all mounted cards into one recovery read and forgets closed views', async () => {
    const stops = [watchGroupRoutes(['c1', 's1']), watchGroupRoutes(['c1', 's1']), watchGroupRoutes(['c2'])]
    expect(env.wsListeners.size).toBe(1)
    try {
      await reconnect()
      expect(env.routes).toHaveBeenCalledTimes(1)
      expect(env.routes).toHaveBeenLastCalledWith(['c1', 'c2', 's1'])
      stops[2]()
      await reconnect()
      expect(env.routes).toHaveBeenCalledTimes(2)
      expect(env.routes).toHaveBeenLastCalledWith(['c1', 's1'])
    } finally {
      stops.forEach(stop => stop())
    }
    await reconnect()
    expect(env.routes).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a snapshot request that began before disconnect', async () => {
    const stop = watchGroupRoutes(['c1'])
    let resolveOld!: (value: unknown) => void
    env.routes.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
    const old = loadGroupRoutes(['c1'])
    await Promise.resolve()
    env.routes.mockResolvedValue({ success: true, data: [report('c1', 20)] })
    try {
      await reconnect()
      expect(env.routes).toHaveBeenCalledTimes(2)
      resolveOld({ success: true, data: [report('c1', 10)] })
      await old
      expect(useGroupRouteStore.getState().routes.c1.at).toBe(20)
    } finally {
      stop()
    }
  })

  it('adds no recovery listener or request for desktop or unobserved conversations', async () => {
    await reconnect()
    expect(env.routes).not.toHaveBeenCalled()
    env.desktop = true
    const stop = watchGroupRoutes(['c1'])
    try {
      expect(env.wsListeners.size).toBe(0)
      await reconnect()
      expect(env.routes).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
})

describe('reading what the router already knows', () => {
  it('shares simultaneous reads of the same keys and releases them after settlement', async () => {
    let finish!: (value: unknown) => void
    env.routes.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const first = loadGroupRoutes(['c1', 's1'])
    const second = loadGroupRoutes(['s1', 'c1', 'c1'])
    await Promise.resolve()
    expect(env.routes).toHaveBeenCalledTimes(1)
    finish({ success: true, data: [] })
    await Promise.all([first, second])
    await loadGroupRoutes(['c1', 's1'])
    expect(env.routes).toHaveBeenCalledTimes(2)
  })

  it('keeps the reports it is given', async () => {
    env.routes.mockResolvedValue({ success: true, data: [report('c1', 7)] })
    await loadGroupRoutes(['c1', 's1'])
    expect(env.routes).toHaveBeenCalledWith(['c1', 's1'])
    expect(useGroupRouteStore.getState().routes.c1.at).toBe(7)
  })

  it('does not ask about nothing', async () => {
    await loadGroupRoutes([])
    expect(env.routes).not.toHaveBeenCalled()
  })

  it('carries on when the router cannot answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    env.routes.mockRejectedValue(new Error('offline'))
    await expect(loadGroupRoutes(['c1'])).resolves.toBeUndefined()
    env.routes.mockResolvedValue({ success: false, error: 'no' })
    await expect(loadGroupRoutes(['c1'])).resolves.toBeUndefined()
    expect(useGroupRouteStore.getState().routes).toEqual({})
    warn.mockRestore()
  })

  it('does not let an older answer replace a newer report that arrived meanwhile', async () => {
    useGroupRouteStore.getState().ingest([report('c1', 50)])
    env.routes.mockResolvedValue({ success: true, data: [report('c1', 10)] })
    await loadGroupRoutes(['c1'])
    expect(useGroupRouteStore.getState().routes.c1.at).toBe(50)
  })
})
