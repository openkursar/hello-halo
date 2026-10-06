import os from 'node:os'
import type { ElectronApplication } from '@playwright/test'
import type { CpuStat, MemStat, ProcessType } from '../types'
import { readDarwinCpu, type NativeCpuIdentity } from './darwin-process-cpu'

type CpuQuality = 'measured' | 'priming' | 'missing-cumulative' | 'pid-reused' | 'invalid-interval' | 'native-read-failed'

interface RawSample {
  pid: number
  creationTime: number
  type: string
  cpuPercent: number | null
  cpuQuality: CpuQuality
  cpuIntervalMs: number
  memKB: number
  tick: number
}

interface CpuBaseline {
  creationTime: number
  startTime: string
  cpuNs: bigint
  timeNs: bigint
}

export interface ProcessWindowStat {
  cpuAvg: number
  cpuMax: number
  rssAvgMB: number
  rssMaxMB: number
  sampleCount: number
  cpuSampleCount?: number
  creationTime?: number
}

export interface CpuSamplingQuality {
  source: 'legacy-percent' | 'cumulative'
  native?: NativeCpuIdentity
  samples: Record<CpuQuality, number>
  notMeasured: Array<{ pid: number; creationTime: number; reason: CpuQuality }>
  noPrior: Array<{ pid: number; creationTime: number; samples: number; rssAvgMB: number; cpuAvg: null; cpuMax: null }>
}

function measured(list: RawSample[]): Array<RawSample & { cpuPercent: number }> {
  return list.filter((sample): sample is RawSample & { cpuPercent: number } => sample.cpuPercent !== null && Number.isFinite(sample.cpuPercent))
}

function cpuSummary(list: RawSample[]): CpuStat | null {
  const values = measured(list)
  if (!values.length) return null
  const interval = values.reduce((sum, sample) => sum + sample.cpuIntervalMs, 0)
  return { avg: values.reduce((sum, sample) => sum + sample.cpuPercent * sample.cpuIntervalMs, 0) / interval,
    max: Math.max(...values.map(sample => sample.cpuPercent)) }
}

function summarizeWindow(list: RawSample[]): ProcessWindowStat | null {
  const cpu = cpuSummary(list)
  if (!cpu) return null
  const memory = list.map(sample => sample.memKB / 1024)
  return { cpuAvg: cpu.avg, cpuMax: cpu.max, rssAvgMB: average(memory), rssMaxMB: Math.max(...memory),
    sampleCount: list.length, cpuSampleCount: measured(list).length, creationTime: list[0].creationTime }
}

function normalizeType(type: string): ProcessType | null {
  switch (type) {
    case 'Browser': return 'browser'
    case 'Tab':
    case 'Renderer': return 'renderer'
    case 'GPU': return 'gpu'
    case 'Utility': return 'utility'
    default: return null
  }
}

/** Cumulative mode controls its own CPU intervals; the percent mode preserves existing scenarios. */
export class ProcessMetricsSampler {
  private samples: RawSample[] = []
  private drainCursor = 0
  private plannedTicks = 0
  private succeededTicks = 0
  private timer: NodeJS.Timeout | null = null
  private running = false
  private pending: Promise<void> | null = null
  private lastError: unknown
  private baseline = new Map<number, CpuBaseline>()
  private nativeIdentity: NativeCpuIdentity | undefined
  private cores = os.cpus().length

  constructor(private readonly app: ElectronApplication, private readonly intervalMs = 500,
    private readonly options: { cpuSource?: 'legacy-percent' | 'cumulative' } = {}) {}

  start(): void {
    if (this.running) return
    this.running = true
    if (this.options.cpuSource === 'cumulative') this.baseline.clear()
    this.launchTick()
  }

  async startAsync(): Promise<void> {
    const successful = this.succeededTicks
    this.start()
    try { await this.awaitPending() } catch (error) { this.stop(); throw error }
    if (this.succeededTicks === successful) throw this.lastError ?? new Error('Process metrics priming failed')
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async stopSettled(): Promise<void> {
    this.stop()
    await this.awaitPending()
  }

  private async awaitPending(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.pending, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Process metrics request did not settle at the sampling boundary')), 15000)
      })])
    } finally { clearTimeout(timer) }
  }

  /** Ends the window with one final reading, after all scheduled requests have settled. */
  async drainSettled(): Promise<ReturnType<ProcessMetricsSampler['drain']>> {
    await this.stopSettled()
    const successful = this.succeededTicks
    const request = this.tick()
    this.pending = request
    void request.finally(() => { if (this.pending === request) this.pending = null })
    await this.awaitPending()
    if (this.succeededTicks === successful) throw this.lastError ?? new Error('Process metrics boundary read failed')
    return this.drain()
  }

  private launchTick(): void {
    if (!this.running || this.pending) return
    const request = this.tick()
    this.pending = request
    void request.finally(() => {
      if (this.pending === request) this.pending = null
      if (this.running) this.timer = setTimeout(() => { this.timer = null; this.launchTick() }, this.intervalMs)
    })
  }

  private async tick(): Promise<void> {
    const tick = this.plannedTicks++
    try {
      const nativeCumulative = this.options.cpuSource === 'cumulative' && process.platform === 'darwin'
      const snapshot = await this.app.evaluate(({ app }, nativeCumulative) => ({
        timeNs: process.hrtime.bigint().toString(),
        metrics: app.getAppMetrics().map(metric => ({ pid: metric.pid, creationTime: metric.creationTime, type: metric.type,
          cpuPercent: nativeCumulative ? null : metric.cpu.percentCPUUsage, cpuSeconds: nativeCumulative ? null : metric.cpu.cumulativeCPUUsage ?? null, memKB: metric.memory.workingSetSize })),
      }), nativeCumulative)
      const cumulative = this.options.cpuSource === 'cumulative'
      const native = cumulative && process.platform === 'darwin' ? await readDarwinCpu(snapshot.metrics.map(metric => metric.pid)) : undefined
      if (native) this.nativeIdentity = native.identity
      const cpuByPid = new Map(native?.report.samples.map(sample => [sample.pid, sample]))
      const next: RawSample[] = []
      for (const metric of snapshot.metrics) {
        let cpuPercent: number | null = metric.cpuPercent
        let quality: CpuQuality = 'measured'
        let intervalMs = this.intervalMs
        if (cumulative) {
          cpuPercent = null
          const own = cpuByPid.get(metric.pid)
          let cpuNs: bigint | undefined
          let timeNs: bigint | undefined
          let startTime = String(metric.creationTime)
          if (native) {
            if (own?.error || !own?.userCpuNs || !own.systemCpuNs || !own.sampleTimeNs || !own.startTimeUs) quality = 'native-read-failed'
            else if (Math.abs(Number(own.startTimeUs) / 1000 - metric.creationTime) > 2) quality = 'pid-reused'
            else {
              cpuNs = BigInt(own.userCpuNs) + BigInt(own.systemCpuNs)
              timeNs = BigInt(own.sampleTimeNs)
              startTime = own.startTimeUs
            }
          } else if (metric.cpuSeconds === null || !Number.isFinite(metric.cpuSeconds) || metric.cpuSeconds < 0) quality = 'missing-cumulative'
          else {
            cpuNs = BigInt(Math.round(metric.cpuSeconds * 1e9))
            timeNs = BigInt(snapshot.timeNs)
          }
          if (cpuNs !== undefined && timeNs !== undefined) {
            const previous = this.baseline.get(metric.pid)
            if (!previous) quality = 'priming'
            else if (previous.creationTime !== metric.creationTime || previous.startTime !== startTime) quality = 'pid-reused'
            else {
              const elapsed = timeNs - previous.timeNs
              const used = cpuNs - previous.cpuNs
              if (elapsed <= 0n || used < 0n) quality = 'invalid-interval'
              else {
                intervalMs = Number(elapsed) / 1e6
                cpuPercent = Number(used) / Number(elapsed) * 100 / this.cores
              }
            }
            this.baseline.set(metric.pid, { creationTime: metric.creationTime, startTime, cpuNs, timeNs })
          } else this.baseline.delete(metric.pid)
        }
        next.push({ pid: metric.pid, creationTime: metric.creationTime, type: metric.type, cpuPercent, cpuQuality: quality, cpuIntervalMs: intervalMs, memKB: metric.memKB, tick })
      }
      const live = new Set(snapshot.metrics.map(metric => metric.pid))
      for (const pid of this.baseline.keys()) if (!live.has(pid)) this.baseline.delete(pid)
      this.samples.push(...next)
      this.succeededTicks++
      this.lastError = undefined
    } catch (error) {
      this.lastError = error
    }
  }

  getSamplingStats(): { plannedTicks: number; succeededTicks: number } {
    return { plannedTicks: this.plannedTicks, succeededTicks: this.succeededTicks }
  }

  getCpuQuality(): CpuSamplingQuality {
    const samples: CpuSamplingQuality['samples'] = { measured: 0, priming: 0, 'missing-cumulative': 0, 'pid-reused': 0, 'invalid-interval': 0, 'native-read-failed': 0 }
    const notMeasured = new Map<string, CpuSamplingQuality['notMeasured'][number]>()
    const processes = new Map<string, RawSample[]>()
    for (const sample of this.samples) {
      const key = `${sample.pid}:${sample.creationTime}`
      const list = processes.get(key) ?? []
      list.push(sample)
      processes.set(key, list)
      samples[sample.cpuQuality]++
      if (sample.cpuQuality !== 'measured' && sample.cpuQuality !== 'priming') {
        notMeasured.set(`${sample.pid}:${sample.creationTime}:${sample.cpuQuality}`, { pid: sample.pid, creationTime: sample.creationTime, reason: sample.cpuQuality })
      }
    }
    const noPrior = [...processes.values()].filter(list => !measured(list).length).map(list => ({ pid: list[0].pid, creationTime: list[0].creationTime, samples: list.length, rssAvgMB: average(list.map(sample => sample.memKB / 1024)), cpuAvg: null, cpuMax: null }))
    return { source: this.options.cpuSource ?? 'legacy-percent', native: this.nativeIdentity, samples, notMeasured: [...notMeasured.values()], noPrior }
  }

  summarize(): { cpu: { byProcessType: Partial<Record<ProcessType, CpuStat>> }; mem: { byProcessType: Partial<Record<ProcessType, MemStat>> } } {
    const byType = new Map<ProcessType, RawSample[]>()
    for (const sample of this.samples) {
      const type = normalizeType(sample.type)
      if (type) byType.set(type, [...(byType.get(type) ?? []), sample])
    }
    const cpu: Partial<Record<ProcessType, CpuStat>> = {}
    const mem: Partial<Record<ProcessType, MemStat>> = {}
    for (const [type, list] of byType) {
      const summary = cpuSummary(list)
      if (summary) cpu[type] = summary
      const memory = list.map(sample => sample.memKB / 1024)
      mem[type] = { avgMB: average(memory), maxMB: Math.max(...memory), deltaMB: memory.length >= 2 ? memory.at(-1)! - memory[0] : 0 }
    }
    return { cpu: { byProcessType: cpu }, mem: { byProcessType: mem } }
  }

  drain(): { byType: Partial<Record<ProcessType, ProcessWindowStat>>; byPid: Map<number, ProcessWindowStat>; totalRssAvgMB: number | null } {
    const taken = this.samples.slice(this.drainCursor)
    this.drainCursor = this.samples.length
    const byTypeSamples = new Map<ProcessType, RawSample[]>()
    const byProcess = new Map<string, RawSample[]>()
    const rssByTick = new Map<number, number>()
    for (const sample of taken) {
      const type = normalizeType(sample.type)
      if (type) byTypeSamples.set(type, [...(byTypeSamples.get(type) ?? []), sample])
      const key = `${sample.pid}:${sample.creationTime}`
      byProcess.set(key, [...(byProcess.get(key) ?? []), sample])
      rssByTick.set(sample.tick, (rssByTick.get(sample.tick) ?? 0) + sample.memKB / 1024)
    }
    const byType: Partial<Record<ProcessType, ProcessWindowStat>> = {}
    for (const [type, list] of byTypeSamples) {
      const summary = summarizeWindow(list)
      if (summary) byType[type] = summary
    }
    const byPid = new Map<number, ProcessWindowStat>()
    for (const list of byProcess.values()) {
      const summary = summarizeWindow(list)
      if (summary) byPid.set(list[0].pid, summary)
    }
    const totals = [...rssByTick.values()]
    return { byType, byPid, totalRssAvgMB: totals.length ? average(totals) : null }
  }

  summarizeByPid(): Array<{ pid: number; creationTime: number; type: string; cpuAvg: number; cpuMax: number; memAvgMB: number; memMaxMB: number }> {
    const processes = new Map<string, RawSample[]>()
    for (const sample of this.samples) {
      const key = `${sample.pid}:${sample.creationTime}`
      processes.set(key, [...(processes.get(key) ?? []), sample])
    }
    const result: ReturnType<ProcessMetricsSampler['summarizeByPid']> = []
    for (const list of processes.values()) {
      const summary = summarizeWindow(list)
      if (summary) result.push({ pid: list[0].pid, creationTime: list[0].creationTime, type: list[0].type, cpuAvg: summary.cpuAvg, cpuMax: summary.cpuMax, memAvgMB: summary.rssAvgMB, memMaxMB: summary.rssMaxMB })
    }
    return result
  }
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}
