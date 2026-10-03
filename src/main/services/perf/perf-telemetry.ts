/**
 * Performance telemetry — always-on, low-rate reporting of process health.
 *
 * Consumes the health resource samples (never measures on its own) and emits
 * `perf.*` events through analytics, which routes them to the internal
 * Telemetry provider only. Numbers, booleans and fixed enums only. Schema:
 * local_docs/perf-impl/perf-telemetry-schema.md (kept in sync with the
 * provider's EVENT_WHITELIST).
 *
 * - perf.heartbeat: a 30-minute aggregate of the samples.
 * - perf.process_crash: a non-main process went away while main stayed up.
 * - perf.memory_pressure: every level change.
 * - perf.crash_snapshot: once per launch, about how the previous session ended.
 *   Evidence is persisted before it can be lost: the last samples are written
 *   to `halo-pre-crash-<ts>.json` next to the minidumps when renderer recovery
 *   halts, before a relaunch, and on critical memory pressure; the next launch
 *   reports and deletes it.
 */

import type { ResourceSample } from '../health'
import type { PreviousSessionExit } from '../../foundation/session-integrity'
import type { MemoryPressureLevel } from '../../../shared/types/memory-pressure'

export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000
const RING_SIZE = 30
export const PRE_CRASH_PREFIX = 'halo-pre-crash-'

type Props = Record<string, number | boolean | string>

export type SnapshotReason = 'renderer-halt' | 'relaunch' | 'memory-critical'

export interface PerfRecorderDeps {
  track(event: string, properties: Props): void
  now(): number
  vdi: boolean
  sessionStats(): { limit: number | null; resident: number; evictions: number }
}

/** A sample reduced to what telemetry and the pre-crash file keep. */
export interface CompactSample {
  at: number
  availPct: number | null
  availSource: ResourceSample['system']['availableSource']
  totalMemMb: number
  mainRssMb: number
  mainHeapMb: number
  rendererMb: number | null
  electronMb: number
  gpuMb: number
  rendererCount: number
  agentCount: number
  agentMb: number | null
  elP99Ms: number
  pressure: MemoryPressureLevel
  residentSessions: number
}

const round = (n: number): number => Math.round(n)

export function compactSample(sample: ResourceSample, pressure: MemoryPressureLevel, residentSessions: number): CompactSample {
  return {
    at: sample.at,
    availPct: sample.system.availableRatio === null ? null : round(sample.system.availableRatio * 100),
    availSource: sample.system.availableSource,
    totalMemMb: round(sample.system.totalMb),
    mainRssMb: round(sample.main.rssMb),
    mainHeapMb: round(sample.main.heapUsedMb),
    rendererMb: sample.rendererMb === null ? null : round(sample.rendererMb),
    electronMb: round(sample.processes.electronTotalMb),
    gpuMb: round(sample.processes.gpuMb),
    rendererCount: sample.processes.rendererCount,
    agentCount: sample.agents.count,
    agentMb: sample.agents.rssMb === null ? null : round(sample.agents.rssMb),
    elP99Ms: round(sample.eventLoop.p99Ms),
    pressure,
    residentSessions,
  }
}

function p50(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

const max = (values: number[]): number => (values.length === 0 ? 0 : Math.max(...values))
const min = (values: number[]): number => (values.length === 0 ? 0 : Math.min(...values))
const present = <T>(values: Array<T | null>): T[] => values.filter((v): v is T => v !== null)

/** Heartbeat properties from one window of samples. */
export function buildHeartbeat(input: {
  samples: CompactSample[]
  windowMs: number
  uptimeMs: number
  vdi: boolean
  pressureMs: Record<MemoryPressureLevel, number>
  pressureChanges: number
  sessionLimit: number | null
  evictions: number
  rendererCrashes: number
  rendererHangs: number
}): Props {
  const s = input.samples
  const avail = present(s.map(x => x.availPct))
  const renderer = present(s.map(x => x.rendererMb))
  const agentMb = present(s.map(x => x.agentMb))
  const totalPressureMs = input.pressureMs.normal + input.pressureMs.low + input.pressureMs.critical
  const share = (ms: number) => (totalPressureMs > 0 ? round((ms / totalPressureMs) * 100) : 0)
  const props: Props = {
    windowSec: round(input.windowMs / 1000),
    samples: s.length,
    uptimeMin: round(input.uptimeMs / 60000),
    vdi: input.vdi,
    totalMemMb: s.length ? s[s.length - 1].totalMemMb : 0,
    availPctP50: p50(avail),
    availPctMin: min(avail),
    availSource: s.length ? s[s.length - 1].availSource : 'os',
    mainRssMbP50: p50(s.map(x => x.mainRssMb)),
    mainRssMbMax: max(s.map(x => x.mainRssMb)),
    mainHeapMbMax: max(s.map(x => x.mainHeapMb)),
    rendererMbP50: p50(renderer),
    rendererMbMax: max(renderer),
    electronMbMax: max(s.map(x => x.electronMb)),
    gpuMbMax: max(s.map(x => x.gpuMb)),
    rendererCountMax: max(s.map(x => x.rendererCount)),
    agentCountMax: max(s.map(x => x.agentCount)),
    elP99MsP50: p50(s.map(x => x.elP99Ms)),
    elP99MsMax: max(s.map(x => x.elP99Ms)),
    pressureLowPct: share(input.pressureMs.low),
    pressureCriticalPct: share(input.pressureMs.critical),
    pressureChanges: input.pressureChanges,
    residentSessionsMax: max(s.map(x => x.residentSessions)),
    sessionEvictions: input.evictions,
    rendererCrashes: input.rendererCrashes,
    rendererHangs: input.rendererHangs,
  }
  if (agentMb.length > 0) props.agentMbMax = max(agentMb)
  if (input.sessionLimit !== null) props.sessionLimit = input.sessionLimit
  return props
}

/** Stateful recorder: aggregates samples and turns runtime events into perf.* events. */
export class PerfRecorder {
  private window: CompactSample[] = []
  private ring: CompactSample[] = []
  private windowStart: number
  private readonly startedAt: number
  private pressure: MemoryPressureLevel = 'normal'
  private pressureSince: number
  private pressureMs: Record<MemoryPressureLevel, number> = { normal: 0, low: 0, critical: 0 }
  private pressureChanges = 0
  private rendererCrashes = 0
  private rendererHangs = 0
  private evictionsAtWindowStart: number

  constructor(private readonly deps: PerfRecorderDeps) {
    this.startedAt = deps.now()
    this.windowStart = this.startedAt
    this.pressureSince = this.startedAt
    this.evictionsAtWindowStart = deps.sessionStats().evictions
  }

  get lastSample(): CompactSample | null {
    return this.ring.length ? this.ring[this.ring.length - 1] : null
  }

  get recentSamples(): readonly CompactSample[] {
    return this.ring
  }

  recordSample(sample: ResourceSample): void {
    const compact = compactSample(sample, this.pressure, this.deps.sessionStats().resident)
    this.window.push(compact)
    this.ring.push(compact)
    if (this.ring.length > RING_SIZE) this.ring.shift()
  }

  recordPressure(to: MemoryPressureLevel, from: MemoryPressureLevel): void {
    const now = this.deps.now()
    this.pressureMs[this.pressure] += now - this.pressureSince
    this.pressure = to
    this.pressureSince = now
    this.pressureChanges += 1
    const last = this.lastSample
    const stats = this.deps.sessionStats()
    const props: Props = {
      from,
      to,
      vdi: this.deps.vdi,
      residentSessions: stats.resident,
    }
    if (stats.limit !== null) props.sessionLimit = stats.limit
    if (last?.availPct != null) props.availPct = last.availPct
    if (last) props.availSource = last.availSource
    if (last?.rendererMb != null) props.rendererMb = last.rendererMb
    if (last) props.agentCount = last.agentCount
    this.deps.track('perf.memory_pressure', props)
  }

  recordProcessCrash(input: {
    processType: 'renderer' | 'gpu' | 'utility' | 'other'
    mainWindow: boolean
    reason: string
    exitCode: number
    recovery: 'reload' | 'halt' | 'ignore' | 'none'
    crashesInWindow: number
  }): void {
    if (input.mainWindow) this.rendererCrashes += 1
    const last = this.lastSample
    const props: Props = { ...input, pressure: this.pressure, vdi: this.deps.vdi }
    if (last?.availPct != null) props.availPct = last.availPct
    if (last?.rendererMb != null) props.rendererMb = last.rendererMb
    this.deps.track('perf.process_crash', props)
  }

  recordRendererHang(): void {
    this.rendererHangs += 1
  }

  /** Emit the heartbeat for the window that ends now and start the next one. */
  flushHeartbeat(): Props | null {
    const now = this.deps.now()
    this.pressureMs[this.pressure] += now - this.pressureSince
    this.pressureSince = now
    const stats = this.deps.sessionStats()
    const props = this.window.length === 0 ? null : buildHeartbeat({
      samples: this.window,
      windowMs: now - this.windowStart,
      uptimeMs: now - this.startedAt,
      vdi: this.deps.vdi,
      pressureMs: this.pressureMs,
      pressureChanges: this.pressureChanges,
      sessionLimit: stats.limit,
      evictions: stats.evictions - this.evictionsAtWindowStart,
      rendererCrashes: this.rendererCrashes,
      rendererHangs: this.rendererHangs,
    })
    if (props) this.deps.track('perf.heartbeat', props)
    this.window = []
    this.windowStart = now
    this.pressureMs = { normal: 0, low: 0, critical: 0 }
    this.pressureChanges = 0
    this.rendererCrashes = 0
    this.rendererHangs = 0
    this.evictionsAtWindowStart = stats.evictions
    return props
  }
}

// ── Next-launch crash snapshot ─────────────────────────────────────────

export interface PreCrashFile {
  reason: SnapshotReason
  at: number
  version: string
  samples: CompactSample[]
}

const RELAUNCH_REASONS = new Set([
  'renderer-recovery', 'user-restart-after-renderer-halt', 'settings-restart', 'health-recovery-S3', 'health-recovery-S4',
])

const DUMP_PROCESS_TYPES = new Set(['browser', 'renderer', 'gpu-process', 'utility', 'node'])

export function normalizeDumpProcessType(value: string | null): string {
  if (value === null) return 'unknown'
  return DUMP_PROCESS_TYPES.has(value) ? value : 'unknown'
}

export interface CrashpadSummary {
  pending: number
  latestProcessType: string
  latestAgeHours: number | null
}

/**
 * The `perf.crash_snapshot` event for this launch, or null when there is
 * nothing to report (clean exit, no snapshot, no pending dumps).
 */
export function buildCrashSnapshot(input: {
  previousExit: PreviousSessionExit
  currentVersion: string
  snapshot: PreCrashFile | null
  crashpad: CrashpadSummary
  now: number
  vdi: boolean
}): Props | null {
  const { previousExit, snapshot, crashpad } = input
  if (previousExit.kind === 'clean' && !snapshot && crashpad.pending === 0) return null
  const props: Props = {
    previousExit: previousExit.kind,
    crashpadPending: crashpad.pending,
    latestDumpProcessType: crashpad.pending > 0 ? crashpad.latestProcessType : 'none',
    snapshotReason: snapshot?.reason ?? 'none',
    vdi: input.vdi,
  }
  if (previousExit.kind === 'relaunch') {
    props.relaunchReason = RELAUNCH_REASONS.has(previousExit.reason) ? previousExit.reason : 'other'
  }
  if (previousExit.kind !== 'clean' && previousExit.previousVersion) {
    props.sameVersion = previousExit.previousVersion === input.currentVersion
  }
  if (crashpad.latestAgeHours !== null) props.latestDumpAgeHours = crashpad.latestAgeHours
  const last = snapshot?.samples[snapshot.samples.length - 1]
  if (snapshot) props.snapshotAgeSec = Math.max(0, round((input.now - snapshot.at) / 1000))
  if (last) {
    if (last.availPct !== null) props.lastAvailPct = last.availPct
    if (last.rendererMb !== null) props.lastRendererMb = last.rendererMb
    props.lastMainRssMb = last.mainRssMb
    props.lastElectronMb = last.electronMb
    if (last.agentMb !== null) props.lastAgentMb = last.agentMb
    props.lastAgentCount = last.agentCount
    props.lastElP99Ms = last.elP99Ms
    props.lastPressure = last.pressure
  }
  return props
}

/** The `process_type` annotation of a minidump, found by scanning its strings. */
export function findDumpProcessType(dump: Buffer): string | null {
  const key = dump.indexOf('process_type')
  if (key < 0) return null
  // The value is the next printable run after the key.
  let i = key + 'process_type'.length
  const isPrintable = (b: number) => b >= 0x21 && b <= 0x7e
  // Like `strings`: skip runs shorter than four printable bytes.
  const limit = Math.min(dump.length, key + 4096)
  while (i < limit) {
    while (i < limit && !isPrintable(dump[i])) i++
    const start = i
    while (i < limit && isPrintable(dump[i])) i++
    if (i - start >= 4) return dump.toString('latin1', start, Math.min(i, start + 32))
  }
  return null
}
