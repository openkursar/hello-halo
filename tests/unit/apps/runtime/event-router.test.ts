/**
 * Unit tests for apps/runtime/event-router (+ event-filter, event-dedup).
 *
 * The event router is a pure, dependency-free in-memory hub, so these tests
 * run it directly (no mocks). They pin the routing contract App subscriptions
 * depend on:
 *
 *   event-router:
 *     - emit is a no-op until start(); stop() clears subscriptions + dedup
 *     - matching subscribers are dispatched; unsubscribe removes a handler
 *     - a throwing handler is isolated (later handlers still run)
 *     - dedupKey drops a repeat within the TTL window
 *     - source adapters: register/start/stop lifecycle + listSources + replace
 *
 *   event-filter (matchesFilter / matchTypeGlob / applyOperator / getByPath):
 *     - type glob, source OR, rule AND, and the path resolver's array indexing
 *
 *   event-dedup (createDedupCache):
 *     - first-seen vs duplicate, TTL expiry, and maxSize eviction
 *
 * Dispatch is fire-and-forget (void Promise) so async assertions await a
 * microtask flush before checking handler side effects.
 */

import { describe, it, expect, vi } from 'vitest'
import { createEventRouter } from '../../../../src/main/apps/runtime/event-router'
import {
  matchesFilter,
  matchTypeGlob,
  applyOperator,
  getByPath,
} from '../../../../src/main/apps/runtime/event-filter'
import { createDedupCache } from '../../../../src/main/apps/runtime/event-dedup'
import type {
  AutomationEvent,
  AutomationEventInput,
  EventSourceAdapter,
} from '../../../../src/main/apps/runtime/event-types'

// dispatchEvent runs as a detached microtask; let it settle.
const flush = () => new Promise<void>(r => setTimeout(r, 0))

function makeInput(overrides: Partial<AutomationEventInput> = {}): AutomationEventInput {
  return {
    type: 'file.changed',
    source: 'src-1',
    payload: {},
    ...overrides,
  }
}

function makeSource(id: string, type: EventSourceAdapter['type'] = 'internal'): EventSourceAdapter & {
  started: boolean
  stopped: boolean
  emitFn: ((e: AutomationEventInput) => void) | null
} {
  const src = {
    id,
    type,
    started: false,
    stopped: false,
    emitFn: null as ((e: AutomationEventInput) => void) | null,
    start(emit: (e: AutomationEventInput) => void) {
      src.started = true
      src.emitFn = emit
    },
    stop() {
      src.stopped = true
    },
  }
  return src
}

// ============================================
// event-router: lifecycle + dispatch
// ============================================

describe('createEventRouter — lifecycle gating', () => {
  it('drops emits until started', async () => {
    const router = createEventRouter()
    const handler = vi.fn()
    router.on({}, handler)
    router.emit(makeInput())
    await flush()
    expect(handler).not.toHaveBeenCalled()

    router.start()
    router.emit(makeInput())
    await flush()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('assigns id and timestamp on emitted events', async () => {
    const router = createEventRouter()
    const handler = vi.fn()
    router.on({}, handler)
    router.start()
    router.emit(makeInput({ type: 'webhook.received' }))
    await flush()
    const event = handler.mock.calls[0][0] as AutomationEvent
    expect(typeof event.id).toBe('string')
    expect(event.id.length).toBeGreaterThan(0)
    expect(typeof event.timestamp).toBe('number')
    expect(event.type).toBe('webhook.received')
  })

  it('stop() clears subscriptions and halts further dispatch', async () => {
    const router = createEventRouter()
    const handler = vi.fn()
    router.on({}, handler)
    router.start()
    router.stop()
    router.start()
    router.emit(makeInput())
    await flush()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('createEventRouter — dispatch + subscriptions', () => {
  it('only invokes handlers whose filter matches', async () => {
    const router = createEventRouter()
    const fileHandler = vi.fn()
    const webhookHandler = vi.fn()
    router.on({ types: ['file.*'] }, fileHandler)
    router.on({ types: ['webhook.*'] }, webhookHandler)
    router.start()
    router.emit(makeInput({ type: 'file.changed' }))
    await flush()
    expect(fileHandler).toHaveBeenCalledTimes(1)
    expect(webhookHandler).not.toHaveBeenCalled()
  })

  it('unsubscribe removes the handler', async () => {
    const router = createEventRouter()
    const handler = vi.fn()
    const unsub = router.on({}, handler)
    router.start()
    unsub()
    router.emit(makeInput())
    await flush()
    expect(handler).not.toHaveBeenCalled()
  })

  it('isolates a throwing handler so later handlers still run', async () => {
    const router = createEventRouter()
    const bad = vi.fn(() => {
      throw new Error('handler boom')
    })
    const good = vi.fn()
    router.on({}, bad)
    router.on({}, good)
    router.start()
    router.emit(makeInput())
    await flush()
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('awaits async handlers without breaking the loop', async () => {
    const router = createEventRouter()
    const order: string[] = []
    router.on({}, async () => {
      order.push('a')
    })
    router.on({}, () => {
      order.push('b')
    })
    router.start()
    router.emit(makeInput())
    await flush()
    expect(order).toEqual(['a', 'b'])
  })
})

describe('createEventRouter — dedup', () => {
  it('drops a duplicate dedupKey within the TTL window', async () => {
    const router = createEventRouter({ ttlMs: 60_000 })
    const handler = vi.fn()
    router.on({}, handler)
    router.start()
    router.emit(makeInput({ dedupKey: 'k1' }))
    router.emit(makeInput({ dedupKey: 'k1' }))
    await flush()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not dedup events without a dedupKey', async () => {
    const router = createEventRouter()
    const handler = vi.fn()
    router.on({}, handler)
    router.start()
    router.emit(makeInput())
    router.emit(makeInput())
    await flush()
    expect(handler).toHaveBeenCalledTimes(2)
  })
})

describe('createEventRouter — source adapters', () => {
  it('starts an already-registered source when the router starts', () => {
    const router = createEventRouter()
    const src = makeSource('s1')
    router.registerSource(src)
    expect(src.started).toBe(false)
    router.start()
    expect(src.started).toBe(true)
    expect(router.listSources()).toEqual([{ id: 's1', type: 'internal', running: true }])
  })

  it('starts a source immediately when registered on a running router', () => {
    const router = createEventRouter()
    router.start()
    const src = makeSource('s2')
    router.registerSource(src)
    expect(src.started).toBe(true)
  })

  it('routes events pushed by a running source through the filter', async () => {
    const router = createEventRouter()
    const handler = vi.fn()
    router.on({ sources: ['s3'] }, handler)
    const src = makeSource('s3')
    router.registerSource(src)
    router.start()
    src.emitFn!(makeInput({ source: 's3' }))
    await flush()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('removeSource stops and drops the adapter', () => {
    const router = createEventRouter()
    const src = makeSource('s4')
    router.registerSource(src)
    router.start()
    router.removeSource('s4')
    expect(src.stopped).toBe(true)
    expect(router.listSources()).toHaveLength(0)
  })

  it('replacing a running source stops the old adapter', () => {
    const router = createEventRouter()
    const first = makeSource('dup')
    router.registerSource(first)
    router.start()
    const second = makeSource('dup')
    router.registerSource(second)
    expect(first.stopped).toBe(true)
    // Router already running → the replacement is started immediately.
    expect(second.started).toBe(true)
  })

  it('stop() stops all running sources', () => {
    const router = createEventRouter()
    const src = makeSource('s5')
    router.registerSource(src)
    router.start()
    router.stop()
    expect(src.stopped).toBe(true)
    expect(router.listSources()).toEqual([{ id: 's5', type: 'internal', running: false }])
  })
})

// ============================================
// event-filter
// ============================================

describe('matchTypeGlob', () => {
  it('matches "*" against anything', () => {
    expect(matchTypeGlob('file.changed', '*')).toBe(true)
  })
  it('matches a "prefix.*" glob', () => {
    expect(matchTypeGlob('file.changed', 'file.*')).toBe(true)
    expect(matchTypeGlob('webhook.received', 'file.*')).toBe(false)
  })
  it('matches exact types', () => {
    expect(matchTypeGlob('file.changed', 'file.changed')).toBe(true)
    expect(matchTypeGlob('file.created', 'file.changed')).toBe(false)
  })
})

describe('matchesFilter', () => {
  const base: AutomationEvent = {
    id: 'e1',
    type: 'file.changed',
    source: 'watcher-1',
    timestamp: 0,
    payload: { extension: 'ts', items: [{ price: 10 }] },
  }

  it('matches an empty filter (match-any)', () => {
    expect(matchesFilter(base, {})).toBe(true)
  })

  it('applies OR logic within types', () => {
    expect(matchesFilter(base, { types: ['webhook.*', 'file.*'] })).toBe(true)
    expect(matchesFilter(base, { types: ['webhook.*'] })).toBe(false)
  })

  it('applies OR logic within sources', () => {
    expect(matchesFilter(base, { sources: ['other', 'watcher-1'] })).toBe(true)
    expect(matchesFilter(base, { sources: ['other'] })).toBe(false)
  })

  it('applies AND logic across rules', () => {
    expect(
      matchesFilter(base, {
        rules: [
          { field: 'payload.extension', op: 'eq', value: 'ts' },
          { field: 'payload.items[0].price', op: 'gt', value: 5 },
        ],
      }),
    ).toBe(true)
    expect(
      matchesFilter(base, {
        rules: [
          { field: 'payload.extension', op: 'eq', value: 'ts' },
          { field: 'payload.items[0].price', op: 'gt', value: 50 },
        ],
      }),
    ).toBe(false)
  })
})

describe('applyOperator', () => {
  it('eq / neq', () => {
    expect(applyOperator('a', 'eq', 'a')).toBe(true)
    expect(applyOperator('a', 'neq', 'b')).toBe(true)
  })
  it('contains for strings and arrays', () => {
    expect(applyOperator('hello world', 'contains', 'world')).toBe(true)
    expect(applyOperator(['x', 'y'], 'contains', 'y')).toBe(true)
    expect(applyOperator(5, 'contains', 'y')).toBe(false)
  })
  it('matches with a regex, tolerating invalid patterns', () => {
    expect(applyOperator('abc123', 'matches', '\\d+')).toBe(true)
    expect(applyOperator('abc', 'matches', '(')).toBe(false)
  })
  it('gt / lt only for numbers', () => {
    expect(applyOperator(10, 'gt', 5)).toBe(true)
    expect(applyOperator(3, 'lt', 5)).toBe(true)
    expect(applyOperator('10', 'gt', 5)).toBe(false)
  })
  it('in / nin against arrays', () => {
    expect(applyOperator('a', 'in', ['a', 'b'])).toBe(true)
    expect(applyOperator('c', 'nin', ['a', 'b'])).toBe(true)
    expect(applyOperator('a', 'in', 'not-an-array')).toBe(false)
  })
})

describe('getByPath', () => {
  const obj = { payload: { items: [{ name: 'first' }, { name: 'second' }] } }
  it('resolves dot paths', () => {
    expect(getByPath(obj, 'payload')).toBe(obj.payload)
  })
  it('resolves array index notation', () => {
    expect(getByPath(obj, 'payload.items[1].name')).toBe('second')
  })
  it('returns undefined for unresolvable segments', () => {
    expect(getByPath(obj, 'payload.missing.deep')).toBeUndefined()
    expect(getByPath(obj, 'payload.items[9].name')).toBeUndefined()
    expect(getByPath(obj, '')).toBeUndefined()
  })
})

// ============================================
// event-dedup
// ============================================

describe('createDedupCache', () => {
  it('reports first-seen as not-duplicate and a repeat as duplicate', () => {
    const cache = createDedupCache({ ttlMs: 1000 })
    expect(cache.isDuplicate('k', 0)).toBe(false)
    expect(cache.isDuplicate('k', 500)).toBe(true)
  })

  it('treats a null/undefined key as never-duplicate', () => {
    const cache = createDedupCache()
    expect(cache.isDuplicate(undefined)).toBe(false)
    expect(cache.isDuplicate(null)).toBe(false)
  })

  it('expires an entry after the TTL window', () => {
    const cache = createDedupCache({ ttlMs: 1000 })
    expect(cache.isDuplicate('k', 0)).toBe(false)
    // 1000ms later: outside the window → treated as first-seen again.
    expect(cache.isDuplicate('k', 1000)).toBe(false)
  })

  it('evicts the oldest entry when over maxSize', () => {
    const cache = createDedupCache({ ttlMs: 60_000, maxSize: 2 })
    cache.isDuplicate('a', 0)
    cache.isDuplicate('b', 1)
    cache.isDuplicate('c', 2) // pushes size to 3 → prune drops oldest ('a')
    expect(cache.size()).toBe(2)
    // 'a' was evicted, so it reads as first-seen (not duplicate) again.
    expect(cache.isDuplicate('a', 3)).toBe(false)
  })

  it('clear() empties the cache', () => {
    const cache = createDedupCache()
    cache.isDuplicate('a', 0)
    cache.clear()
    expect(cache.size()).toBe(0)
  })
})
