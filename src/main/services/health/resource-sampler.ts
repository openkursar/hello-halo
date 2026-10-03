/**
 * Resource sampler — the single source of resource numbers in the main process.
 *
 * Every sample reads, once: system available memory, every Electron process
 * (`app.getAppMetrics()`: main, renderers, GPU, utility), the main-window
 * renderer, the `claude` engine children (RSS by PID from the process
 * registry), the main heap, and main event-loop delay. Consumers never measure
 * on their own; they read `getLatestResourceSample()` or follow
 * `onResourceSample(cb)`: memory pressure (fed here), the session budget, and
 * performance telemetry.
 *
 * Cadence: 120 s, 30 s while memory pressure is above normal. Every read is
 * asynchronous or O(1); nothing here blocks the main thread on I/O.
 */

import { app } from 'electron'
import { execFile } from 'child_process'
import os from 'os'
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks'
import { getMainWindow } from '../../foundation/window.service'
import { evaluateMemoryPressure, getMemoryPressure, type MemoryReading } from '../../platform/background'
import { getCurrentProcesses } from './process-guardian'

export interface ResourceSample {
  at: number
  system: {
    totalMb: number
    availableMb: number | null
    availableRatio: number | null
    availableSource: MemoryReading['availableSource']
  }
  main: { rssMb: number; heapUsedMb: number; heapTotalMb: number }
  /** Main-window renderer (private bytes where reported, else working set). */
  rendererMb: number | null
  processes: {
    rendererCount: number
    rendererTotalMb: number
    gpuMb: number
    utilityMb: number
    /** Sum over every Electron process, main included. */
    electronTotalMb: number
  }
  agents: { count: number; rssMb: number | null }
  eventLoop: { p50Ms: number; p99Ms: number; maxMs: number }
}

export const SAMPLE_INTERVAL_MS = 120_000
export const PRESSURE_SAMPLE_INTERVAL_MS = 30_000
const EXEC_TIMEOUT_MS = 5_000
const MB = 1024 * 1024

// ── Available memory ───────────────────────────────────────────────────

export interface AvailableMemoryInput {
  platform: NodeJS.Platform
  totalBytes: number
  freeBytes: number
  /** macOS kernel free percentage (0–100), or null when the read failed. */
  kernelFreePercent: number | null
}

/** Map the platform readings to one available-memory figure (see memory-pressure). */
export function resolveAvailableMemory(input: AvailableMemoryInput): {
  availableBytes: number
  source: MemoryReading['availableSource']
} {
  if (input.platform === 'darwin') {
    if (input.kernelFreePercent !== null) {
      return { availableBytes: (input.totalBytes * input.kernelFreePercent) / 100, source: 'kernel' }
    }
    return { availableBytes: input.freeBytes, source: 'fallback' }
  }
  return { availableBytes: input.freeBytes, source: 'os' }
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })
}

let kernelFallbackLogged = false

async function readKernelFreePercent(): Promise<number | null> {
  try {
    const value = Number.parseInt((await execFileText('sysctl', ['-n', 'kern.memorystatus_level'])).trim(), 10)
    if (Number.isFinite(value) && value >= 0 && value <= 100) return value
    throw new Error('unexpected value')
  } catch (error) {
    if (!kernelFallbackLogged) {
      kernelFallbackLogged = true
      console.warn(
        '[Health][Resources] kern.memorystatus_level unavailable, using os.freemem() ' +
        '(does not count reclaimable pages; needs three consecutive readings to raise pressure): ' +
        (error as Error).message
      )
    }
    return null
  }
}

// ── Engine child RSS ───────────────────────────────────────────────────

/** Parse `ps -o pid=,rss=` output (RSS in KB) into a total in MB. */
export function parsePsRss(stdout: string): number {
  let kb = 0
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2) {
      const rss = Number.parseInt(parts[1], 10)
      if (Number.isFinite(rss)) kb += rss
    }
  }
  return kb / 1024
}

/** Parse PowerShell `Get-Process | Select WorkingSet64 | ConvertTo-Json` into MB. */
export function parseWindowsWorkingSet(stdout: string): number {
  const text = stdout.trim()
  if (!text) return 0
  const parsed: unknown = JSON.parse(text)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  let bytes = 0
  for (const row of rows) {
    const value = (row as { WorkingSet64?: unknown } | null)?.WorkingSet64
    if (typeof value === 'number') bytes += value
  }
  return bytes / MB
}

/**
 * Whether engine child memory is read in this sample. On Windows the read starts
 * PowerShell (hundreds of ms of CPU, tens of MB), so it stays at the normal
 * cadence even while pressure shortens the sampling interval, and the last
 * reading is reused in between. `ps` elsewhere is cheap enough for every sample.
 */
export function shouldReadAgentRss(platform: NodeJS.Platform, lastReadAt: number | null, now: number): boolean {
  if (platform !== 'win32' || lastReadAt === null) return true
  return now - lastReadAt >= SAMPLE_INTERVAL_MS - PRESSURE_SAMPLE_INTERVAL_MS / 2
}

let lastAgentRead: { at: number; pids: string; rssMb: number | null } | null = null

async function sampleAgentRssMb(pids: number[]): Promise<number | null> {
  const now = Date.now()
  const key = pids.join(',')
  // A changed set of engine processes is always re-read.
  if (lastAgentRead && lastAgentRead.pids === key && !shouldReadAgentRss(process.platform, lastAgentRead.at, now)) {
    return lastAgentRead.rssMb
  }
  const rssMb = await readAgentRssMb(pids)
  lastAgentRead = { at: now, pids: key, rssMb }
  return rssMb
}

async function readAgentRssMb(pids: number[]): Promise<number | null> {
  if (pids.length === 0) return 0
  try {
    if (process.platform === 'win32') {
      const stdout = await execFileText('powershell', [
        '-NoProfile', '-Command',
        `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object WorkingSet64 | ConvertTo-Json -Compress`,
      ])
      return parseWindowsWorkingSet(stdout)
    }
    return parsePsRss(await execFileText('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')]))
  } catch (error) {
    // ps exits 1 when none of the PIDs exist any more.
    if ((error as { code?: number }).code === 1) return 0
    console.warn('[Health][Resources] Engine process memory read failed:', (error as Error).message)
    return null
  }
}

// ── Electron processes ─────────────────────────────────────────────────

export interface ProcessMetricLike {
  pid: number
  type: string
  memory: { workingSetSize: number; privateBytes?: number }
}

/** Summarize `app.getAppMetrics()` (memory in KB) around the main-window renderer. */
export function summarizeAppMetrics(
  metrics: readonly ProcessMetricLike[],
  mainRendererPid: number | null,
): { rendererMb: number | null; processes: ResourceSample['processes'] } {
  const mbOf = (m: ProcessMetricLike) => (m.memory.privateBytes ?? m.memory.workingSetSize) / 1024
  const processes = { rendererCount: 0, rendererTotalMb: 0, gpuMb: 0, utilityMb: 0, electronTotalMb: 0 }
  let rendererMb: number | null = null
  for (const metric of metrics) {
    const mb = mbOf(metric)
    processes.electronTotalMb += mb
    if (metric.type === 'Tab') {
      processes.rendererCount += 1
      processes.rendererTotalMb += mb
      if (metric.pid === mainRendererPid) rendererMb = mb
    } else if (metric.type === 'GPU') {
      processes.gpuMb += mb
    } else if (metric.type === 'Utility') {
      processes.utilityMb += mb
    }
  }
  return { rendererMb, processes }
}

function mainRendererPid(): number | null {
  const window = getMainWindow()
  if (!window || window.isDestroyed()) return null
  try {
    const pid = window.webContents.getOSProcessId()
    return pid > 0 ? pid : null
  } catch {
    return null
  }
}

// ── Sampling loop ──────────────────────────────────────────────────────

type SampleListener = (sample: ResourceSample) => void

const listeners = new Set<SampleListener>()
let latest: ResourceSample | null = null
let timer: NodeJS.Timeout | null = null
let histogram: IntervalHistogram | null = null
let inFlight: Promise<ResourceSample | null> | null = null
let running = false

export function getLatestResourceSample(): ResourceSample | null {
  return latest
}

/** Called after every sample. Returns an unsubscribe. */
export function onResourceSample(listener: SampleListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

async function collectSample(): Promise<ResourceSample> {
  const totalBytes = os.totalmem()
  const agentPids = getCurrentProcesses()
    .filter((entry) => entry.type === 'v2-session' && typeof entry.pid === 'number')
    .map((entry) => entry.pid as number)

  const [kernelFreePercent, agentRssMb] = await Promise.all([
    process.platform === 'darwin' ? readKernelFreePercent() : Promise.resolve(null),
    sampleAgentRssMb(agentPids),
  ])

  const available = resolveAvailableMemory({
    platform: process.platform,
    totalBytes,
    freeBytes: os.freemem(),
    kernelFreePercent,
  })
  const { rendererMb, processes } = summarizeAppMetrics(app.getAppMetrics(), mainRendererPid())
  const memory = process.memoryUsage()

  let eventLoop = { p50Ms: 0, p99Ms: 0, maxMs: 0 }
  if (histogram) {
    eventLoop = {
      p50Ms: histogram.percentile(50) / 1e6,
      p99Ms: histogram.percentile(99) / 1e6,
      maxMs: histogram.max / 1e6,
    }
    histogram.reset()
  }

  return {
    at: Date.now(),
    system: {
      totalMb: totalBytes / MB,
      availableMb: available.availableBytes / MB,
      availableRatio: totalBytes > 0 ? available.availableBytes / totalBytes : null,
      availableSource: available.source,
    },
    main: { rssMb: memory.rss / MB, heapUsedMb: memory.heapUsed / MB, heapTotalMb: memory.heapTotal / MB },
    rendererMb,
    processes,
    agents: { count: agentPids.length, rssMb: agentRssMb },
    eventLoop,
  }
}

function publish(sample: ResourceSample): void {
  latest = sample
  evaluateMemoryPressure({
    availableRatio: sample.system.availableRatio,
    availableSource: sample.system.availableSource,
    rendererMb: sample.rendererMb,
  })
  for (const listener of listeners) {
    try {
      listener(sample)
    } catch (error) {
      console.error('[Health][Resources] Sample listener failed:', error)
    }
  }
}

function scheduleNext(): void {
  if (!running) return
  if (timer) clearTimeout(timer)
  const delay = getMemoryPressure() === 'normal' ? SAMPLE_INTERVAL_MS : PRESSURE_SAMPLE_INTERVAL_MS
  timer = setTimeout(() => {
    void sampleResourcesNow()
  }, delay)
  timer.unref()
}

/**
 * Take a sample now (coalesced with one already running) and reschedule the
 * next. Use after an event that suggests memory trouble, e.g. a renderer killed
 * for memory, so pressure reflects it before the reloaded window asks.
 */
export function sampleResourcesNow(): Promise<ResourceSample | null> {
  if (inFlight) return inFlight
  inFlight = collectSample()
    .then((sample) => {
      publish(sample)
      return sample
    })
    .catch((error) => {
      console.error('[Health][Resources] Sampling failed:', error)
      return null
    })
    .finally(() => {
      inFlight = null
      scheduleNext()
    })
  return inFlight
}

export function startResourceSampling(): void {
  if (running) return
  running = true
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 })
    histogram.enable()
  } catch (error) {
    histogram = null
    console.warn('[Health][Resources] Event-loop delay monitor unavailable:', (error as Error).message)
  }
  void sampleResourcesNow()
  console.log(`[Health][Resources] Sampling started (${SAMPLE_INTERVAL_MS / 1000}s, ${PRESSURE_SAMPLE_INTERVAL_MS / 1000}s under pressure)`)
}

export function stopResourceSampling(): void {
  running = false
  if (timer) clearTimeout(timer)
  timer = null
  histogram?.disable()
  histogram = null
}

/** One-line summary for the periodic health state log. */
export function formatResourceSample(sample: ResourceSample): string {
  const pct = sample.system.availableRatio === null ? 'n/a' : `${Math.round(sample.system.availableRatio * 100)}%`
  const renderer = sample.rendererMb === null ? 'n/a' : `${Math.round(sample.rendererMb)}MB`
  const agents = sample.agents.rssMb === null ? 'n/a' : `${Math.round(sample.agents.rssMb)}MB`
  return (
    `available=${pct}(${sample.system.availableSource}) renderer=${renderer} ` +
    `electron=${Math.round(sample.processes.electronTotalMb)}MB/${sample.processes.rendererCount}r ` +
    `agents=${sample.agents.count}/${agents} elp99=${sample.eventLoop.p99Ms.toFixed(0)}ms`
  )
}
