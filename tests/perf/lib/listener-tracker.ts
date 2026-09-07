import type { Page } from '@playwright/test'

/**
 * Records who adds event listeners that are never removed, and keeps the call
 * stack of the code that added them.
 *
 * Why this rather than a heap snapshot: a snapshot says which objects survive,
 * not which line created them, and the leak being chased is ~1 listener per
 * file open/close — diffuse rather than a hot spot, so the useful question is
 * "which call site accumulates" rather than "what is big".
 *
 * A listener whose target has since been collected is not a leak: the target
 * held it, and both are gone. Targets are therefore held through `WeakRef` and
 * a dead reference disqualifies the record at dump time, which is what
 * separates a leak from ordinary churn.
 */

export interface ListenerGroup {
  count: number
  type: string
  capture: boolean
  target: string
  /** The call site, truncated to its first frames — this is the grouping key. */
  origin: string
  /** One representative record's full stack. */
  sampleStack: string
}

export interface ListenerDump {
  ok: boolean
  error?: string
  /** Adds seen while recording. */
  added: number
  /** Of those, later removed through `removeEventListener`. */
  removed: number
  /** Still registered, but the target is gone — the target held them, so not a leak. */
  targetCollected: number
  /** Still registered on a target that is still alive. */
  outstanding: number
  groups: ListenerGroup[]
}

/**
 * `EventTarget.prototype` is wrapped in place, so listeners registered before
 * this call are invisible to it. That is intentional: the question is what
 * accumulates across the measured cycles, and startup registrations would only
 * add a fixed offset to every group.
 */
const INSTALL_SOURCE = `
(() => {
  if (window.__leakTracker) return 'already-installed'

  const proto = EventTarget.prototype
  const originalAdd = proto.addEventListener
  const originalRemove = proto.removeEventListener

  const records = []
  const byTarget = new WeakMap()
  let recording = false

  function describe(target) {
    try {
      if (target === window) return 'window'
      if (target === document) return 'document'
      if (target && target.nodeType === 1) {
        const cls = typeof target.className === 'string' && target.className.trim()
          ? '.' + target.className.trim().split(/\\s+/).slice(0, 2).join('.')
          : ''
        return target.tagName.toLowerCase() + cls
      }
      return (target && target.constructor && target.constructor.name) || typeof target
    } catch {
      return 'undescribable'
    }
  }

  function captureStack() {
    // Frame 0 is the Error line, frame 1 is this wrapper. Everything after is
    // the code that actually asked for the listener.
    const raw = new Error().stack || ''
    return raw.split('\\n').slice(3).join('\\n')
  }

  proto.addEventListener = function (type, listener, options) {
    const returned = originalAdd.apply(this, arguments)
    if (recording && listener) {
      try {
        const capture = typeof options === 'boolean' ? options : !!(options && options.capture)
        const record = {
          type: String(type),
          capture,
          target: describe(this),
          stack: captureStack(),
          ref: new WeakRef(this),
          removed: false
        }
        records.push(record)
        let perTarget = byTarget.get(this)
        if (!perTarget) { perTarget = new Map(); byTarget.set(this, perTarget) }
        const key = type + '|' + capture
        let entries = perTarget.get(key)
        if (!entries) { entries = []; perTarget.set(key, entries) }
        entries.push({ listener, record })
      } catch {
        // Bookkeeping must never change what the application sees.
      }
    }
    return returned
  }

  proto.removeEventListener = function (type, listener, options) {
    const returned = originalRemove.apply(this, arguments)
    try {
      const perTarget = byTarget.get(this)
      if (perTarget) {
        const capture = typeof options === 'boolean' ? options : !!(options && options.capture)
        const entries = perTarget.get(type + '|' + capture)
        if (entries) {
          const index = entries.findIndex((e) => e.listener === listener)
          if (index >= 0) {
            entries[index].record.removed = true
            entries.splice(index, 1)
          }
        }
      }
    } catch {
      // Same: never let the wrapper throw into application code.
    }
    return returned
  }

  window.__leakTracker = {
    start() { recording = true },
    stop() { recording = false },
    reset() { records.length = 0 },
    dump(maxGroups) {
      let removed = 0
      let targetCollected = 0
      const groups = new Map()
      for (const record of records) {
        if (record.removed) { removed++; continue }
        if (record.ref.deref() === undefined) { targetCollected++; continue }
        const frames = record.stack.split('\\n').map((l) => l.trim()).filter(Boolean)
        const origin = frames.slice(0, 3).join(' <- ')
        const key = record.type + '|' + record.capture + '|' + record.target + '|' + origin
        const existing = groups.get(key)
        if (existing) existing.count++
        else groups.set(key, {
          count: 1,
          type: record.type,
          capture: record.capture,
          target: record.target,
          origin,
          sampleStack: record.stack
        })
      }
      const sorted = [...groups.values()].sort((a, b) => b.count - a.count)
      const outstanding = sorted.reduce((sum, g) => sum + g.count, 0)
      return {
        ok: true,
        added: records.length,
        removed,
        targetCollected,
        outstanding,
        groups: sorted.slice(0, maxGroups || 40)
      }
    }
  }
  return 'installed'
})()
`

export async function installListenerTracker(page: Page): Promise<string> {
  return page.evaluate(INSTALL_SOURCE) as Promise<string>
}

export async function startListenerRecording(page: Page): Promise<void> {
  await page.evaluate('window.__leakTracker.reset(); window.__leakTracker.start()')
}

export async function stopListenerRecording(page: Page): Promise<void> {
  await page.evaluate('window.__leakTracker.stop()')
}

export async function dumpOutstandingListeners(page: Page, maxGroups = 40): Promise<ListenerDump> {
  try {
    return (await page.evaluate(`window.__leakTracker.dump(${maxGroups})`)) as ListenerDump
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      added: 0,
      removed: 0,
      targetCollected: 0,
      outstanding: 0,
      groups: []
    }
  }
}
