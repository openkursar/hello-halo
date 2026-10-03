/**
 * Wires performance telemetry into the running app: resource samples and
 * memory-pressure changes in, `perf.*` events out, pre-crash evidence on disk.
 * See perf-telemetry.ts for the event model.
 */

import { app } from 'electron'
import { readdirSync, writeFileSync, unlinkSync, readFileSync } from 'fs'
import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { analytics } from '../analytics/analytics.service'
import { onResourceSample } from '../health'
import { onMemoryPressure } from '../../platform/background'
import { getPreviousSessionExit } from '../../foundation/session-integrity'
import { isVirtualDesktopSession } from '../../foundation/host-identity'
import {
  getResidentSessionLimit,
  getSessionEvictionCount,
  listResidentSessions,
} from '../agent'
import {
  buildCrashSnapshot,
  findDumpProcessType,
  HEARTBEAT_INTERVAL_MS,
  normalizeDumpProcessType,
  PerfRecorder,
  PRE_CRASH_PREFIX,
  type CrashpadSummary,
  type PreCrashFile,
  type SnapshotReason,
} from './perf-telemetry'

const MAX_DUMP_SCAN_BYTES = 32 * 1024 * 1024
const MEMORY_SNAPSHOT_MIN_INTERVAL_MS = 10 * 60 * 1000

let recorder: PerfRecorder | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let disposers: Array<() => void> = []
let lastMemorySnapshotAt = 0

function crashDumpsDir(): string {
  return app.getPath('crashDumps')
}

/** Start reporting. Call once analytics is initialized (events before that are dropped). */
export function startPerfTelemetry(): void {
  if (recorder) return
  const vdi = isVirtualDesktopSession()
  recorder = new PerfRecorder({
    track: (event, properties) => void analytics.track(event, properties),
    now: Date.now,
    vdi,
    sessionStats: () => ({
      limit: getResidentSessionLimit(),
      resident: listResidentSessions().length,
      evictions: getSessionEvictionCount(),
    }),
  })
  disposers = [
    onResourceSample((sample) => recorder?.recordSample(sample)),
    onMemoryPressure((level, previous) => {
      recorder?.recordPressure(level, previous)
      const now = Date.now()
      if (level === 'critical' && now - lastMemorySnapshotAt >= MEMORY_SNAPSHOT_MIN_INTERVAL_MS) {
        lastMemorySnapshotAt = now
        writePreCrashSnapshot('memory-critical')
      }
    }),
  ]
  heartbeatTimer = setInterval(() => recorder?.flushHeartbeat(), HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref()
  void reportPreviousSession(vdi)
  console.log(`[PerfTelemetry] Started (vdi=${vdi})`)
}

export function stopPerfTelemetry(): void {
  for (const dispose of disposers) dispose()
  disposers = []
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
  recorder = null
}

/** A non-main process went away (main-window renderer, GPU, utility, other renderers). */
export function recordProcessGone(input: Parameters<PerfRecorder['recordProcessCrash']>[0]): void {
  recorder?.recordProcessCrash(input)
}

export function recordRendererHang(): void {
  recorder?.recordRendererHang()
}

/**
 * Persist the recent samples next to the minidumps, synchronously — callers
 * may be about to exit. Reported and deleted on the next launch.
 */
export function writePreCrashSnapshot(reason: SnapshotReason): void {
  try {
    const at = Date.now()
    const file: PreCrashFile = { reason, at, version: app.getVersion(), samples: [...(recorder?.recentSamples ?? [])] }
    writeFileSync(join(crashDumpsDir(), `${PRE_CRASH_PREFIX}${at}.json`), JSON.stringify(file))
  } catch (error) {
    console.warn('[PerfTelemetry] Could not write pre-crash snapshot:', (error as Error).message)
  }
}

/** Newest pre-crash snapshot, deleting every one found. */
function takePreCrashSnapshot(): PreCrashFile | null {
  let newest: PreCrashFile | null = null
  try {
    const dir = crashDumpsDir()
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(PRE_CRASH_PREFIX) || !name.endsWith('.json')) continue
      const path = join(dir, name)
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as PreCrashFile
        if (!newest || parsed.at > newest.at) newest = parsed
      } catch {
        // Torn write from a dying process: nothing to report.
      }
      try { unlinkSync(path) } catch { /* next launch retries */ }
    }
  } catch {
    // No crash-dumps directory yet.
  }
  return newest
}

async function summarizeCrashpad(): Promise<CrashpadSummary> {
  const dir = join(crashDumpsDir(), 'pending')
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => name.endsWith('.dmp'))
  } catch {
    return { pending: 0, latestProcessType: 'none', latestAgeHours: null }
  }
  let latest: { path: string; mtimeMs: number; size: number } | null = null
  for (const name of names) {
    try {
      const st = await stat(join(dir, name))
      if (!latest || st.mtimeMs > latest.mtimeMs) latest = { path: join(dir, name), mtimeMs: st.mtimeMs, size: st.size }
    } catch { /* vanished */ }
  }
  let processType: string | null = null
  if (latest && latest.size <= MAX_DUMP_SCAN_BYTES) {
    try {
      processType = findDumpProcessType(await readFile(latest.path))
    } catch { /* unreadable dump */ }
  }
  return {
    pending: names.length,
    latestProcessType: normalizeDumpProcessType(processType),
    latestAgeHours: latest ? Math.round((Date.now() - latest.mtimeMs) / 3_600_000) : null,
  }
}

async function reportPreviousSession(vdi: boolean): Promise<void> {
  try {
    const snapshot = takePreCrashSnapshot()
    const crashpad = await summarizeCrashpad()
    const props = buildCrashSnapshot({
      previousExit: getPreviousSessionExit(),
      currentVersion: app.getVersion(),
      snapshot,
      crashpad,
      now: Date.now(),
      vdi,
    })
    if (props) {
      void analytics.track('perf.crash_snapshot', props)
      console.log(
        `[PerfTelemetry] Previous session: exit=${props.previousExit} snapshot=${props.snapshotReason} ` +
        `crashpadPending=${props.crashpadPending} latestDump=${props.latestDumpProcessType}`
      )
    }
  } catch (error) {
    console.warn('[PerfTelemetry] Previous-session report failed:', (error as Error).message)
  }
}

/** Count of pending minidumps, for diagnostics surfaces. */
export function countPendingCrashDumps(): number {
  try {
    return readdirSync(join(crashDumpsDir(), 'pending')).filter(name => name.endsWith('.dmp')).length
  } catch {
    return 0
  }
}

