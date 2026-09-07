import type { CDPSession, Page } from '@playwright/test'

export interface CdpSnapshot {
  heapMB: number
  nodes: number
  listeners: number
  layoutCount: number
  recalcStyleCount: number
}

/**
 * Thin wrapper around a CDP `Performance` session. One instance per window —
 * callers snapshot once at scenario start and once at scenario end to derive
 * the heap/nodes/listeners deltas that flag detached-DOM / listener leaks.
 */
export class CdpMetricsCollector {
  private session: CDPSession | null = null

  constructor(private readonly page: Page) {}

  async connect(): Promise<void> {
    this.session = await this.page.context().newCDPSession(this.page)
    await this.session.send('Performance.enable')
  }

  /**
   * Force a full collection before sampling. `Nodes` and `JSEventListeners`
   * count objects that are unreachable but not yet collected, so ordinary
   * garbage reads as accumulation: a 15-cycle probe measured 434 listeners
   * before collection and 289 after, then stayed at 289 across five further
   * rounds. Distinguishing the two requires collecting first.
   */
  async collectGarbage(): Promise<void> {
    if (!this.session) throw new Error('CdpMetricsCollector.connect() must run first')
    await this.session.send('HeapProfiler.collectGarbage')
  }

  /**
   * Drop what the debugger itself is holding: console entries retain their
   * arguments as remote objects, so anything the page logs stays reachable for
   * as long as a client is attached. That memory is charged to the page and
   * survives `collectGarbage`, and no user without devtools open ever pays it.
   *
   * Only meaningful as one arm of a comparison — a run that never calls this
   * cannot tell the page's retention apart from the debugger's.
   */
  async releaseDebuggerRetention(): Promise<void> {
    if (!this.session) throw new Error('CdpMetricsCollector.connect() must run first')
    await this.session.send('Runtime.discardConsoleEntries')
    await this.session.send('Runtime.releaseObjectGroup', { objectGroup: 'console' })
  }

  /**
   * Make the renderer drop everything it is holding only for reuse, by raising
   * the critical memory-pressure signal it already listens for — the same
   * signal the operating system raised on its own during one soak, which
   * returned 86 MB in two samples. Blink responds by emptying its resource
   * cache (decoded images, fonts, stylesheets), and V8 by releasing its
   * reserves.
   *
   * This is the question `collectGarbage` cannot answer. Almost none of the
   * growth being chased is in the JS heap — 4 MB of it across a run whose
   * working set grew 138 MB — and a JS collection does not touch the native
   * caches where the rest of it may be sitting.
   *
   * Each step is reported rather than thrown, so a run whose purge partly
   * failed cannot be read as a purge that freed nothing.
   * `Memory.prepareForLeakDetection` would be the direct equivalent and is not
   * usable here: it fails outright in this renderer.
   */
  async purgeRetainedCaches(): Promise<Record<string, string>> {
    if (!this.session) throw new Error('CdpMetricsCollector.connect() must run first')
    const session = this.session
    const outcome: Record<string, string> = {}
    const step = async (name: string, method: string, params?: object) => {
      try {
        await session.send(method as Parameters<CDPSession['send']>[0], params)
        outcome[name] = 'ok'
      } catch (err) {
        outcome[name] = err instanceof Error ? err.message : String(err)
      }
    }
    await step('v8', 'Memory.forciblyPurgeJavaScriptMemory')
    await step('pressure', 'Memory.simulatePressureNotification', { level: 'critical' })
    return outcome
  }

  /** Blink's own counters, which `Performance.getMetrics` does not expose. */
  async domCounters(): Promise<Record<string, number>> {
    if (!this.session) throw new Error('CdpMetricsCollector.connect() must run first')
    return (await this.session.send('Memory.getDOMCounters')) as unknown as Record<string, number>
  }

  /** `rate=1` is unthrottled; `rate=4` simulates a 4x-slower CPU. */
  async setCpuThrottlingRate(rate: number): Promise<void> {
    if (!this.session) throw new Error('CdpMetricsCollector.connect() must run first')
    await this.session.send('Emulation.setCPUThrottlingRate', { rate })
  }

  /**
   * These are stable Chromium metric names that
   * should always be present once `Performance.enable` has run — if one is
   * ever missing, that's a signal the session isn't in the state we think it
   * is (not ready yet, or torn down), not a legitimate "0". `?? 0` would
   * quietly turn that into a plausible-looking start/end value and corrupt
   * the delta it feeds into, so a missing name throws instead.
   */
  async snapshot(): Promise<CdpSnapshot> {
    if (!this.session) throw new Error('CdpMetricsCollector.connect() must run first')
    const { metrics } = await this.session.send('Performance.getMetrics')
    const byName = new Map(metrics.map((m) => [m.name, m.value]))
    const required = ['JSHeapUsedSize', 'Nodes', 'JSEventListeners', 'LayoutCount', 'RecalcStyleCount']
    const missing = required.filter((name) => !byName.has(name))
    if (missing.length > 0) {
      throw new Error(`CDP Performance.getMetrics missing expected field(s): ${missing.join(', ')}`)
    }
    return {
      heapMB: byName.get('JSHeapUsedSize')! / (1024 * 1024),
      nodes: byName.get('Nodes')!,
      listeners: byName.get('JSEventListeners')!,
      layoutCount: byName.get('LayoutCount')!,
      recalcStyleCount: byName.get('RecalcStyleCount')!
    }
  }
}
