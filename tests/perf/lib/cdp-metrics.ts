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
