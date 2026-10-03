/**
 * Guard: the `perf.*` telemetry contract stays in one piece.
 *
 * - Every perf.* event has an EVENT_WHITELIST entry in the Telemetry provider,
 *   and its keys equal what the emitters can produce (so nothing ships
 *   unreviewed and nothing emitted is silently dropped).
 * - perf.* events are routed to the Telemetry provider only.
 */

import { describe, it, expect } from 'vitest'
import { readSource } from './lib/source-scan'

const PERF_EVENTS = ['perf.heartbeat', 'perf.process_crash', 'perf.crash_snapshot', 'perf.memory_pressure'] as const

/** Keys of one EVENT_WHITELIST entry, read from the provider source. */
function whitelistKeys(event: string): string[] {
  const source = readSource('src/main/services/analytics/providers/telemetry.ts')
  const start = source.indexOf(`'${event}': [`)
  expect(start, `${event} missing from EVENT_WHITELIST`).toBeGreaterThan(-1)
  const body = source.slice(start + event.length + 5, source.indexOf(']', start))
  return [...body.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]).sort()
}

describe('perf telemetry contract', () => {
  it('every perf event is whitelisted with exactly the keys its emitter produces', async () => {
    const { PerfRecorder, buildCrashSnapshot } = await import('../../../src/main/services/perf/perf-telemetry')
    const produced = new Map<string, Set<string>>()
    const note = (event: string, props: Record<string, unknown>) => {
      const keys = produced.get(event) ?? new Set<string>()
      Object.keys(props).forEach((k) => keys.add(k))
      produced.set(event, keys)
    }
    let now = 0
    const rec = new PerfRecorder({
      track: note,
      now: () => now,
      vdi: false,
      sessionStats: () => ({ limit: 10, resident: 1, evictions: 0 }),
    })
    rec.recordSample({
      at: 0,
      system: { totalMb: 8192, availableMb: 4096, availableRatio: 0.5, availableSource: 'os' },
      main: { rssMb: 100, heapUsedMb: 50, heapTotalMb: 60 },
      rendererMb: 200,
      processes: { rendererCount: 1, rendererTotalMb: 200, gpuMb: 10, utilityMb: 5, electronTotalMb: 315 },
      agents: { count: 1, rssMb: 90 },
      eventLoop: { p50Ms: 1, p99Ms: 5, maxMs: 9 },
    })
    rec.recordPressure('low', 'normal')
    rec.recordProcessCrash({ processType: 'renderer', mainWindow: true, reason: 'oom', exitCode: 1, recovery: 'reload', crashesInWindow: 1 })
    now = 1000
    rec.flushHeartbeat()
    note('perf.crash_snapshot', buildCrashSnapshot({
      previousExit: { kind: 'relaunch', reason: 'renderer-recovery', previousVersion: '1' },
      currentVersion: '1',
      snapshot: { reason: 'relaunch', at: 0, version: '1', samples: [{
        at: 0, availPct: 5, availSource: 'kernel', totalMemMb: 8192, mainRssMb: 1, mainHeapMb: 1, rendererMb: 1,
        electronMb: 1, gpuMb: 1, rendererCount: 1, agentCount: 1, agentMb: 1, elP99Ms: 1, pressure: 'critical', residentSessions: 1,
      }] },
      crashpad: { pending: 1, latestProcessType: 'renderer', latestAgeHours: 2 },
      now: 1000,
      vdi: false,
    })!)

    for (const event of PERF_EVENTS) {
      expect([...(produced.get(event) ?? [])].sort(), event).toEqual(whitelistKeys(event))
    }
  })

  it('perf.* is routed to the Telemetry provider only', () => {
    const service = readSource('src/main/services/analytics/analytics.service.ts')
    expect(service).toMatch(/providersForEvent\(eventName, this\.providers\)/)
    expect(service).toContain("const PERF_PROVIDER_NAME = 'Telemetry'")
  })
})
