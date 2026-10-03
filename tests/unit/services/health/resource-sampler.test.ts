/**
 * Resource sampler parsing: per-platform available memory, Electron process
 * summary around the main-window renderer, and engine child RSS parsing.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../src/main/foundation/window.service', () => ({ getMainWindow: () => null }))
vi.mock('../../../../src/main/services/health/process-guardian', () => ({ getCurrentProcesses: () => [] }))

import {
  parsePsRss,
  parseWindowsWorkingSet,
  resolveAvailableMemory,
  shouldReadAgentRss,
  summarizeAppMetrics,
} from '../../../../src/main/services/health/resource-sampler'

const GB = 1024 ** 3

describe('resolveAvailableMemory', () => {
  it.each([
    // macOS: the kernel free percentage wins over os.freemem (free pages only)
    ['darwin', 16 * GB, 0.5 * GB, 46, 16 * GB * 0.46, 'kernel'],
    // macOS kernel read failed → os.freemem, marked as fallback
    ['darwin', 16 * GB, 0.5 * GB, null, 0.5 * GB, 'fallback'],
    // Linux: os.freemem already reads MemAvailable
    ['linux', 8 * GB, 3 * GB, null, 3 * GB, 'os'],
    // Windows: os.freemem already reads ullAvailPhys
    ['win32', 8 * GB, 1 * GB, null, 1 * GB, 'os'],
    // A stray kernel value on another platform is ignored
    ['win32', 8 * GB, 1 * GB, 90, 1 * GB, 'os'],
  ] as const)('%s total=%d free=%d kernel=%s', (platform, totalBytes, freeBytes, kernel, expectedBytes, source) => {
    const result = resolveAvailableMemory({ platform, totalBytes, freeBytes, kernelFreePercent: kernel })
    expect(result.source).toBe(source)
    expect(result.availableBytes).toBeCloseTo(expectedBytes)
  })
})

describe('summarizeAppMetrics', () => {
  it('sums by type and picks the main-window renderer, preferring private bytes', () => {
    const summary = summarizeAppMetrics([
      { pid: 1, type: 'Browser', memory: { workingSetSize: 200 * 1024 } },
      { pid: 2, type: 'Tab', memory: { workingSetSize: 500 * 1024, privateBytes: 400 * 1024 } },
      { pid: 3, type: 'Tab', memory: { workingSetSize: 100 * 1024 } },
      { pid: 4, type: 'GPU', memory: { workingSetSize: 50 * 1024 } },
      { pid: 5, type: 'Utility', memory: { workingSetSize: 20 * 1024 } },
    ], 2)
    expect(summary.rendererMb).toBe(400)
    expect(summary.processes).toEqual({
      rendererCount: 2, rendererTotalMb: 500, gpuMb: 50, utilityMb: 20, electronTotalMb: 770,
    })
  })

  it('reports no renderer when the main window has none', () => {
    expect(summarizeAppMetrics([], null).rendererMb).toBeNull()
  })
})

describe('engine child RSS parsing', () => {
  it('sums ps rss in KB', () => {
    expect(parsePsRss(' 101  102400\n 102  51200\n')).toBe(150)
  })

  it('sums PowerShell WorkingSet64 for one or many processes', () => {
    expect(parseWindowsWorkingSet('{"WorkingSet64":104857600}')).toBe(100)
    expect(parseWindowsWorkingSet('[{"WorkingSet64":104857600},{"WorkingSet64":52428800}]')).toBe(150)
    expect(parseWindowsWorkingSet('')).toBe(0)
  })
})

describe('shouldReadAgentRss', () => {
  it('reads every sample off Windows', () => {
    expect(shouldReadAgentRss('darwin', 0, 30_000)).toBe(true)
    expect(shouldReadAgentRss('linux', 0, 30_000)).toBe(true)
  })

  it('on Windows keeps the 120 s cadence even when samples come every 30 s', () => {
    expect(shouldReadAgentRss('win32', null, 0)).toBe(true)
    expect(shouldReadAgentRss('win32', 0, 30_000)).toBe(false)
    expect(shouldReadAgentRss('win32', 0, 90_000)).toBe(false)
    expect(shouldReadAgentRss('win32', 0, 120_000)).toBe(true)
    // A sample landing a little early on the 120 s cadence still reads.
    expect(shouldReadAgentRss('win32', 0, 110_000)).toBe(true)
  })
})
