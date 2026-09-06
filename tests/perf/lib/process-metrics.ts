import type { ElectronApplication } from '@playwright/test'
import type { CpuStat, MemStat, ProcessType } from '../types'

interface RawSample {
  pid: number
  type: string
  cpuPercent: number
  memKB: number
  /** Which poll produced this sample, so the processes alive at one instant can be summed. */
  tick: number
}

export interface ProcessWindowStat {
  cpuAvg: number
  cpuMax: number
  rssAvgMB: number
  rssMaxMB: number
  sampleCount: number
}

function summarizeWindow(list: RawSample[]): ProcessWindowStat {
  const cpuValues = list.map((s) => s.cpuPercent)
  const rssValuesMB = list.map((s) => s.memKB / 1024)
  return {
    cpuAvg: average(cpuValues),
    cpuMax: Math.max(...cpuValues),
    rssAvgMB: average(rssValuesMB),
    rssMaxMB: Math.max(...rssValuesMB),
    sampleCount: list.length
  }
}

/** Maps Electron's `ProcessMetric.type` to our normalized bucket. */
function normalizeType(type: string): ProcessType | null {
  switch (type) {
    case 'Browser':
      return 'browser'
    case 'Tab':
    case 'Renderer':
      return 'renderer'
    case 'GPU':
      return 'gpu'
    case 'Utility':
      return 'utility'
    default:
      return null
  }
}

/**
 * Polls `app.getAppMetrics()` from the Node side every `intervalMs`.
 * This is the only layer that can tell renderer vs main vs GPU vs utility
 * apart — every other layer only sees the renderer it is attached to.
 *
 * Failed ticks (app unreachable — the exact moment a real hang would cause
 * this) are counted, not just dropped — silently
 * averaging only the ticks that survived biases every summary toward
 * whatever was happening *before* the app seized up, since that's disproportionately
 * what remains once the bad stretch stops responding.
 */
export class ProcessMetricsSampler {
  private samples: RawSample[] = []
  private drainCursor = 0
  private plannedTicks = 0
  private succeededTicks = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly app: ElectronApplication, private readonly intervalMs = 500) {}

  start(): void {
    if (this.timer) return
    const tick = async () => {
      const tickIndex = this.plannedTicks++
      try {
        const metrics = await this.app.evaluate(({ app }) =>
          app.getAppMetrics().map((m) => ({
            pid: m.pid,
            type: m.type,
            cpuPercent: m.cpu.percentCPUUsage,
            memKB: m.memory.workingSetSize
          }))
        )
        this.samples.push(...metrics.map((m) => ({ ...m, tick: tickIndex })))
        this.succeededTicks++
      } catch {
        // App unreachable this tick — counted in plannedTicks/succeededTicks
        // (see `sampling` on PerfResult) instead of vanishing silently.
      }
    }
    void tick()
    this.timer = setInterval(() => void tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getSamplingStats(): { plannedTicks: number; succeededTicks: number } {
    return { plannedTicks: this.plannedTicks, succeededTicks: this.succeededTicks }
  }

  /** Aggregates collected samples into the fixed cpu/mem result shape. */
  summarize(): {
    cpu: { byProcessType: Partial<Record<ProcessType, CpuStat>> }
    mem: { byProcessType: Partial<Record<ProcessType, MemStat>> }
  } {
    const byType = new Map<ProcessType, RawSample[]>()
    for (const sample of this.samples) {
      const type = normalizeType(sample.type)
      if (!type) continue
      const list = byType.get(type) ?? []
      list.push(sample)
      byType.set(type, list)
    }

    const cpu: Partial<Record<ProcessType, CpuStat>> = {}
    const mem: Partial<Record<ProcessType, MemStat>> = {}

    for (const [type, list] of byType) {
      const cpuValues = list.map((s) => s.cpuPercent)
      const memValuesMB = list.map((s) => s.memKB / 1024)
      cpu[type] = {
        avg: average(cpuValues),
        max: Math.max(...cpuValues)
      }
      mem[type] = {
        avgMB: average(memValuesMB),
        maxMB: Math.max(...memValuesMB),
        // A single surviving sample makes first===last, i.e. a fabricated
        // "zero growth" — the shape a silently-failed probe takes. Report
        // callers should treat deltaMB as unreliable whenever
        // `sampling.succeededTicks` is small; we don't have a per-type
        // count here so the scenario-level `sampling` field is the signal.
        deltaMB: memValuesMB.length >= 2 ? memValuesMB[memValuesMB.length - 1] - memValuesMB[0] : 0
      }
    }

    return { cpu: { byProcessType: cpu }, mem: { byProcessType: mem } }
  }

  /**
   * Summarizes the samples taken since the previous call, then advances past
   * them. `summarize()` answers what a scenario cost; a soak asks whether that
   * cost is drifting, and a run-long average hides a curve by construction.
   *
   * Both views come from one call because they share a cursor. The per-pid view
   * is not a refinement of the per-type one: `normalizeType` folds `Tab` and
   * `Renderer` together, so a scenario that opens a PDF — its own renderer
   * process — gets the main window's memory averaged against a second, much
   * smaller process on exactly those cycles. Asking about one window means
   * asking by pid.
   */
  drain(): { byType: Partial<Record<ProcessType, ProcessWindowStat>>; byPid: Map<number, ProcessWindowStat>; totalRssAvgMB: number | null } {
    const taken = this.samples.slice(this.drainCursor)
    this.drainCursor = this.samples.length

    const byTypeSamples = new Map<ProcessType, RawSample[]>()
    const byPidSamples = new Map<number, RawSample[]>()
    const rssByTick = new Map<number, number>()
    for (const sample of taken) {
      const type = normalizeType(sample.type)
      if (type) {
        const list = byTypeSamples.get(type) ?? []
        list.push(sample)
        byTypeSamples.set(type, list)
      }
      const pidList = byPidSamples.get(sample.pid) ?? []
      pidList.push(sample)
      byPidSamples.set(sample.pid, pidList)
      rssByTick.set(sample.tick, (rssByTick.get(sample.tick) ?? 0) + sample.memKB / 1024)
    }

    const byType: Partial<Record<ProcessType, ProcessWindowStat>> = {}
    for (const [type, list] of byTypeSamples) byType[type] = summarizeWindow(list)
    const byPid = new Map<number, ProcessWindowStat>()
    for (const [pid, list] of byPidSamples) byPid.set(pid, summarizeWindow(list))

    // Summed per tick before averaging: a tick where one process failed to
    // report would otherwise pull the whole-app total down as if memory had
    // been released.
    const tickTotals = [...rssByTick.values()]
    return { byType, byPid, totalRssAvgMB: tickTotals.length ? average(tickTotals) : null }
  }

  /**
   * Per-pid breakdown — use when a scenario spans more than one renderer
   * (e.g. a PDF tab's own BrowserView process) and the type-level aggregate
   * would blend it into the main window's numbers.
   */
  summarizeByPid(): Array<{ pid: number; type: string; cpuAvg: number; cpuMax: number; memAvgMB: number; memMaxMB: number }> {
    const byPid = new Map<number, RawSample[]>()
    for (const sample of this.samples) {
      const list = byPid.get(sample.pid) ?? []
      list.push(sample)
      byPid.set(sample.pid, list)
    }

    return [...byPid.entries()].map(([pid, list]) => {
      const cpuValues = list.map((s) => s.cpuPercent)
      const memValuesMB = list.map((s) => s.memKB / 1024)
      return {
        pid,
        type: list[0].type,
        cpuAvg: average(cpuValues),
        cpuMax: Math.max(...cpuValues),
        memAvgMB: average(memValuesMB),
        memMaxMB: Math.max(...memValuesMB)
      }
    })
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}
