/**
 * Performance telemetry: heartbeat aggregation, event shapes that pass the
 * provider whitelist, next-launch crash snapshot, minidump process type, and
 * perf.* routed to the internal Telemetry provider only.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildCrashSnapshot,
  findDumpProcessType,
  PerfRecorder,
  type CompactSample,
} from '../../../../src/main/services/perf/perf-telemetry'
import { providersForEvent } from '../../../../src/main/services/analytics/analytics.service'
import { isVirtualDesktopSession } from '../../../../src/main/foundation/host-identity'
import type { ResourceSample } from '../../../../src/main/services/health/resource-sampler'

function sample(at: number, over: Partial<{ avail: number; renderer: number; rss: number; el: number; agents: number }> = {}): ResourceSample {
  return {
    at,
    system: { totalMb: 16384, availableMb: 0, availableRatio: (over.avail ?? 40) / 100, availableSource: 'kernel' },
    main: { rssMb: over.rss ?? 200, heapUsedMb: 90, heapTotalMb: 120 },
    rendererMb: over.renderer ?? 300,
    processes: { rendererCount: 2, rendererTotalMb: 400, gpuMb: 50, utilityMb: 20, electronTotalMb: 700 },
    agents: { count: over.agents ?? 3, rssMb: 310 },
    eventLoop: { p50Ms: 1, p99Ms: over.el ?? 12, maxMs: 30 },
  }
}

function recorder(now: { t: number }) {
  const track = vi.fn()
  const stats = { limit: 10 as number | null, resident: 4, evictions: 0 }
  const rec = new PerfRecorder({ track, now: () => now.t, vdi: true, sessionStats: () => stats })
  return { rec, track, stats }
}

describe('PerfRecorder', () => {
  it('aggregates a window into one heartbeat with p50/max and pressure shares', () => {
    const now = { t: 0 }
    const { rec, track, stats } = recorder(now)
    rec.recordSample(sample(0, { avail: 40, renderer: 300, rss: 200, el: 10 }))
    rec.recordSample(sample(1, { avail: 30, renderer: 500, rss: 260, el: 40 }))
    now.t = 600_000
    rec.recordPressure('low', 'normal')
    rec.recordSample(sample(2, { avail: 12, renderer: 400, rss: 240, el: 20 }))
    rec.recordRendererHang()
    rec.recordProcessCrash({ processType: 'renderer', mainWindow: true, reason: 'oom', exitCode: 1, recovery: 'reload', crashesInWindow: 1 })
    stats.evictions = 3
    now.t = 1_800_000

    const hb = rec.flushHeartbeat()!
    expect(hb).toMatchObject({
      windowSec: 1800, samples: 3, vdi: true, availPctP50: 30, availPctMin: 12,
      mainRssMbP50: 240, mainRssMbMax: 260, rendererMbP50: 400, rendererMbMax: 500,
      elP99MsP50: 20, elP99MsMax: 40, pressureLowPct: 67, pressureCriticalPct: 0, pressureChanges: 1,
      sessionLimit: 10, residentSessionsMax: 4, sessionEvictions: 3, rendererCrashes: 1, rendererHangs: 1,
      agentCountMax: 3, agentMbMax: 310,
    })
    expect(track.mock.calls.map(c => c[0])).toEqual(['perf.memory_pressure', 'perf.process_crash', 'perf.heartbeat'])

    // Counters restart with the next window.
    rec.recordSample(sample(3))
    now.t = 3_600_000
    expect(rec.flushHeartbeat()).toMatchObject({ rendererCrashes: 0, rendererHangs: 0, sessionEvictions: 0, pressureChanges: 0 })
  })

  it('emits no heartbeat for an empty window', () => {
    const { rec, track } = recorder({ t: 0 })
    expect(rec.flushHeartbeat()).toBeNull()
    expect(track).not.toHaveBeenCalled()
  })

  it('carries only numbers, booleans and enums', () => {
    const now = { t: 0 }
    const { rec, track } = recorder(now)
    rec.recordSample(sample(0))
    rec.recordProcessCrash({ processType: 'gpu', mainWindow: false, reason: 'crashed', exitCode: 3, recovery: 'none', crashesInWindow: 0 })
    now.t = 1000
    rec.flushHeartbeat()
    for (const [, props] of track.mock.calls) {
      for (const value of Object.values(props as Record<string, unknown>)) {
        expect(['number', 'boolean', 'string']).toContain(typeof value)
        if (typeof value === 'string') expect(value).toMatch(/^[a-z-]+$/)
      }
    }
  })
})

describe('buildCrashSnapshot', () => {
  const last: CompactSample = {
    at: 1000, availPct: 6, availSource: 'kernel', totalMemMb: 8192, mainRssMb: 300, mainHeapMb: 100, rendererMb: 1400,
    electronMb: 2000, gpuMb: 80, rendererCount: 3, agentCount: 9, agentMb: 950, elP99Ms: 250, pressure: 'critical', residentSessions: 9,
  }
  const noDumps = { pending: 0, latestProcessType: 'none', latestAgeHours: null }

  it('reports nothing after a clean exit with no evidence', () => {
    expect(buildCrashSnapshot({ previousExit: { kind: 'clean' }, currentVersion: '1', snapshot: null, crashpad: noDumps, now: 0, vdi: false })).toBeNull()
  })

  it('reports an unexplained death with the last persisted sample', () => {
    const props = buildCrashSnapshot({
      previousExit: { kind: 'unclean', previousVersion: '1' },
      currentVersion: '1',
      snapshot: { reason: 'memory-critical', at: 1000, version: '1', samples: [last] },
      crashpad: { pending: 2, latestProcessType: 'browser', latestAgeHours: 1 },
      now: 61_000,
      vdi: true,
    })!
    expect(props).toMatchObject({
      previousExit: 'unclean', sameVersion: true, snapshotReason: 'memory-critical', snapshotAgeSec: 60,
      lastAvailPct: 6, lastRendererMb: 1400, lastAgentCount: 9, lastPressure: 'critical',
      crashpadPending: 2, latestDumpProcessType: 'browser', latestDumpAgeHours: 1, vdi: true,
    })
  })

  it('maps relaunch reasons to the enum', () => {
    const base = { currentVersion: '1', snapshot: null, crashpad: noDumps, now: 0, vdi: false }
    expect(buildCrashSnapshot({ ...base, previousExit: { kind: 'relaunch', reason: 'renderer-recovery' } })!.relaunchReason).toBe('renderer-recovery')
    expect(buildCrashSnapshot({ ...base, previousExit: { kind: 'relaunch', reason: 'something/else' } })!.relaunchReason).toBe('other')
  })
})

describe('findDumpProcessType', () => {
  it('reads the value after the process_type annotation, skipping short runs', () => {
    const dump = Buffer.concat([
      Buffer.from([0, 1, 2]), Buffer.from('process_type'), Buffer.from([0, 0, 0x41, 0]), Buffer.from('renderer'), Buffer.from([0]),
    ])
    expect(findDumpProcessType(dump)).toBe('renderer')
    expect(findDumpProcessType(Buffer.from('no annotation here'))).toBeNull()
  })
})

describe('perf.* routing', () => {
  const providers = [{ name: 'Baidu' }, { name: 'GA4' }, { name: 'Telemetry' }]
  it('sends perf.* only to the internal Telemetry provider', () => {
    expect(providersForEvent('perf.heartbeat', providers).map(p => p.name)).toEqual(['Telemetry'])
    expect(providersForEvent('app_launch', providers).map(p => p.name)).toEqual(['Baidu', 'GA4', 'Telemetry'])
  })
})

describe('isVirtualDesktopSession', () => {
  it.each([
    [{ SESSIONNAME: 'RDP-Tcp#12' }, true],
    [{ SESSIONNAME: 'ICA-CGP#3' }, true],
    [{ SESSIONNAME: 'Console' }, false],
    [{ ViewClient_Machine_Name: 'thin-client' }, true],
    [{}, false],
  ])('%o → %s', (env, expected) => {
    expect(isVirtualDesktopSession(env as NodeJS.ProcessEnv)).toBe(expected)
  })
})
