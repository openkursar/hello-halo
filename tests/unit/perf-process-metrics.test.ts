import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import type { ElectronApplication } from '@playwright/test'
import { ProcessMetricsSampler } from '../perf/lib/process-metrics'

const native = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../perf/lib/darwin-process-cpu', () => ({ readDarwinCpu: native.read }))

const identity = { backend: 'darwin-proc-pid-rusage-v4', clock: 'CLOCK_MONOTONIC_RAW', cpuUnit: 'nanoseconds', cpuResolutionNs: 1,
  machTimebase: { numer: 1, denom: 1 }, sourceSha256: 'source', executableSha256: 'executable', compiler: 'clang', compilerVersion: 'test', compileArguments: [], probe: { idlePercentOneCore: 0, busyPercentOneCore: 100 } }

function metric(creationTime = 1000): { pid: number; creationTime: number; type: string; cpu: { percentCPUUsage: number; cumulativeCPUUsage?: number }; memory: { workingSetSize: number } } {
  return { pid: 123, creationTime, type: 'Tab', cpu: { percentCPUUsage: 99, cumulativeCPUUsage: 99 }, memory: { workingSetSize: 4096 } }
}

function report(timeNs: string, cpuNs: string, startTimeUs = '1000000') {
  return { identity, report: { ...identity, samples: [{ pid: 123, startTimeUs, sampleTimeNs: timeNs, userCpuNs: cpuNs, systemCpuNs: '0' }] } }
}

function fakeApp(metrics = vi.fn(() => [metric()])) {
  const evaluate = vi.fn(async (callback: (electron: unknown, argument: unknown) => unknown, argument?: unknown) => callback({ app: { getAppMetrics: metrics } }, argument))
  return { app: { evaluate } as unknown as ElectronApplication, evaluate, metrics }
}

describe('cumulative process sampling', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => { Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' }); vi.useFakeTimers(); native.read.mockReset() })
  afterEach(() => { vi.useRealTimers(); Object.defineProperty(process, 'platform', originalPlatform) })

  it('primes without a fake zero CPU value and uses its own cumulative interval', async () => {
    const { app } = fakeApp()
    native.read.mockResolvedValueOnce(report('1000000000', '500000000')).mockResolvedValueOnce(report('1500000000', '750000000'))
    const sampler = new ProcessMetricsSampler(app, 500, { cpuSource: 'cumulative' })
    await sampler.startAsync()
    expect(sampler.getCpuQuality().samples.priming).toBe(1)
    expect(sampler.getCpuQuality().noPrior[0]).toMatchObject({ cpuAvg: null, cpuMax: null })
    expect(sampler.summarize().cpu.byProcessType.renderer).toBeUndefined()
    const result = await sampler.drainSettled()
    expect(result.byPid.get(123)!.cpuAvg * os.cpus().length).toBeCloseTo(50)
    expect(result.byPid.get(123)!.cpuSampleCount).toBe(1)
    expect(result.totalRssAvgMB).toBe(4)
    expect(sampler.getCpuQuality().native).toEqual(identity)
  })

  it('records a read failure explicitly while keeping available memory', async () => {
    const { app } = fakeApp()
    native.read.mockResolvedValue({ identity, report: { ...identity, samples: [{ pid: 123, error: 'process-read-failed', errno: 3 }] } })
    const sampler = new ProcessMetricsSampler(app, 500, { cpuSource: 'cumulative' })
    await sampler.startAsync()
    const result = await sampler.drainSettled()
    expect(result.byPid.has(123)).toBe(false)
    expect(result.totalRssAvgMB).toBe(4)
    expect(sampler.getCpuQuality().notMeasured).toEqual([{ pid: 123, creationTime: 1000, reason: 'native-read-failed' }])
  })

  it('collects native CPU and RSS without reading Electron CPU getters', async () => {
    const processMetric = metric()
    const readCpu = vi.fn(() => { throw new Error('Electron CPU fields must not be read by the native collector') })
    Object.defineProperty(processMetric, 'cpu', { get: readCpu })
    const { app } = fakeApp(vi.fn(() => [processMetric]))
    native.read.mockResolvedValueOnce(report('1000000000', '500000000')).mockResolvedValueOnce(report('1500000000', '750000000'))
    const sampler = new ProcessMetricsSampler(app, 500, { cpuSource: 'cumulative' })
    await sampler.startAsync()
    const result = await sampler.drainSettled()
    expect(readCpu).not.toHaveBeenCalled()
    expect(result.byPid.get(123)!.cpuAvg * os.cpus().length).toBeCloseTo(50)
    expect(result.totalRssAvgMB).toBe(4)
    expect(sampler.getSamplingStats()).toEqual({ plannedTicks: 2, succeededTicks: 2 })
    expect(sampler.getCpuQuality().notMeasured).toEqual([])
  })

  it('does not combine CPU across a reused PID', async () => {
    const metrics = vi.fn().mockReturnValueOnce([metric()]).mockReturnValueOnce([metric(2000)])
    const { app } = fakeApp(metrics)
    native.read.mockResolvedValueOnce(report('1000000000', '1000000000')).mockResolvedValueOnce(report('1500000000', '1000000', '2000000'))
    const sampler = new ProcessMetricsSampler(app, 500, { cpuSource: 'cumulative' })
    await sampler.startAsync()
    expect((await sampler.drainSettled()).byPid.has(123)).toBe(false)
    expect(sampler.getCpuQuality().samples['pid-reused']).toBe(1)
  })

  it('never overlaps polls and the stopping boundary waits for the issued request', async () => {
    let resolve!: (snapshot: unknown) => void
    const evaluate = vi.fn(() => new Promise(accept => { resolve = accept }))
    const sampler = new ProcessMetricsSampler({ evaluate } as unknown as ElectronApplication, 500, { cpuSource: 'cumulative' })
    native.read.mockResolvedValue(report('1000000000', '1000000000'))
    sampler.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(evaluate).toHaveBeenCalledTimes(1)
    let stopped = false
    const boundary = sampler.stopSettled().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    resolve({ timeNs: '1000000000', metrics: [{ pid: 123, creationTime: 1000, type: 'Tab', cpuPercent: 99, cpuSeconds: 99, memKB: 4096 }] })
    await boundary
    expect(sampler.getSamplingStats()).toEqual({ plannedTicks: 1, succeededTicks: 1 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it('a new window primes again instead of charging CPU spent outside its boundary', async () => {
    const { app } = fakeApp()
    native.read.mockResolvedValueOnce(report('1000000000', '100000000'))
      .mockResolvedValueOnce(report('1500000000', '600000000'))
      .mockResolvedValueOnce(report('2000000000', '2000000000'))
      .mockResolvedValueOnce(report('2500000000', '2250000000'))
    const sampler = new ProcessMetricsSampler(app, 500, { cpuSource: 'cumulative' })
    await sampler.startAsync()
    expect((await sampler.drainSettled()).byPid.get(123)!.cpuAvg * os.cpus().length).toBeCloseTo(100)
    await sampler.startAsync()
    expect((await sampler.drainSettled()).byPid.get(123)!.cpuAvg * os.cpus().length).toBeCloseTo(50)
  })

  it('missing cumulative data outside Darwin remains unmeasured', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' })
    const metrics = vi.fn(() => [{ ...metric(), cpu: { percentCPUUsage: 99 } }])
    const { app } = fakeApp(metrics)
    const sampler = new ProcessMetricsSampler(app, 500, { cpuSource: 'cumulative' })
    await sampler.startAsync()
    expect((await sampler.drainSettled()).byPid.has(123)).toBe(false)
    expect(sampler.getCpuQuality().samples['missing-cumulative']).toBe(2)
    expect(sampler.getCpuQuality().noPrior[0]).toMatchObject({ cpuAvg: null, cpuMax: null })
    expect(native.read).not.toHaveBeenCalled()
  })
})
