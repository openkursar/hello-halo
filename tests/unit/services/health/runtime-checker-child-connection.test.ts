/**
 * Run diagnostics checks the router from a child process too: security
 * software can refuse the engine's process while the app's own probe gets
 * through, so the check that the caller supplies reports on its own row and
 * a failure counts as a service issue.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildLocalConnectionInfo } from '../../../../src/shared/types/health'

vi.mock('../../../../src/main/services/health/health-checker/probes/service-probe', () => ({
  checkOpenAIRouter: vi.fn(async () => ({ healthy: true, data: { responseTime: 3 } })),
  checkHttpServer: vi.fn(),
}))
vi.mock('../../../../src/main/services/health/process-guardian', () => ({
  getCurrentProcesses: () => [],
  unregisterProcess: vi.fn(),
  getRegistryStats: vi.fn(),
}))
vi.mock('../../../../src/main/services/health/process-guardian/platform', () => ({
  getPlatformOps: () => ({ findChildProcesses: async () => [] }),
}))
vi.mock('../../../../src/main/openai-compat-router', () => ({ getRouterInfo: () => ({ port: 4321 }) }))
vi.mock('../../../../src/main/http', () => ({ getServerInfo: () => ({ running: false }) }))
vi.mock('../../../../src/main/services/health/health-checker/event-listener', () => ({
  getRecentEvents: () => [],
  getTotalErrorCount: () => 0,
}))
vi.mock('../../../../src/main/services/health/resource-sampler', () => ({
  formatResourceSample: vi.fn(),
  getLatestResourceSample: () => null,
}))

import { runImmediateCheck } from '../../../../src/main/services/health/health-checker/runtime-checker'

let now = 1_000_000
beforeEach(() => {
  // Checks closer than two seconds apart share one result.
  now += 10_000
  vi.spyOn(Date, 'now').mockReturnValue(now)
})

describe('run diagnostics: child process local connection', () => {
  it('reports a connection the child process made', async () => {
    const check = vi.fn(async (): Promise<ChildLocalConnectionInfo> => ({ reachable: true, blocked: false, program: '/halo' }))

    const result = await runImmediateCheck({ checkChildLocalConnection: check })

    expect(check).toHaveBeenCalledWith(4321)
    expect(result.services.childLocalConnection).toEqual({ reachable: true, blocked: false, program: '/halo' })
    expect(result.issues).toEqual([])
    expect(result.healthy).toBe(true)
  })

  it('reports a refused connection as an issue that names the program', async () => {
    const blocked: ChildLocalConnectionInfo = { reachable: false, blocked: true, error: 'EACCES', program: 'C:\\Halo\\Halo.exe' }

    const result = await runImmediateCheck({ checkChildLocalConnection: async () => blocked })

    expect(result.services.childLocalConnection).toEqual(blocked)
    expect(result.issues).toEqual([
      'Child process cannot connect to 127.0.0.1:4321 (EACCES) — blocked by the system for C:\\Halo\\Halo.exe',
    ])
    expect(result.healthy).toBe(false)
  })

  it('leaves the row out when no check is supplied', async () => {
    const result = await runImmediateCheck()

    expect(result.services).not.toHaveProperty('childLocalConnection')
  })
})
