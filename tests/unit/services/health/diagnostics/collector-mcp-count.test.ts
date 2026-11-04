/**
 * The diagnostics report counts the installed MCP servers through the app
 * manager, loaded on demand so it stays out of the collector's startup tier.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ aiSources: undefined }),
  getHaloDir: () => '/tmp/halo-test',
}))
vi.mock('../../../../../src/main/services/health/orchestrator', () => ({
  getHealthState: () => ({ consecutiveFailures: 0, recoveryAttempts: 0 }),
}))
vi.mock('../../../../../src/main/services/health/process-guardian', () => ({
  getRegistryStats: () => ({ totalProcesses: 0, orphanProcesses: 0 }),
}))
vi.mock('../../../../../src/main/services/health/health-checker', () => ({
  getRecentEvents: () => [],
}))
vi.mock('../../../../../src/main/services/app-bridge', () => ({
  getImChannelStatuses: () => [],
}))
vi.mock('../../../../../src/main/services/agent', () => ({
  getSdkDiagnostics: () => undefined,
}))

const listApps = vi.fn()
vi.mock('../../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ listApps }),
}))

import { collectDiagnosticReport } from '../../../../../src/main/services/health/diagnostics/collector'

describe('diagnostics MCP server count', () => {
  it('counts installed MCP apps and skips uninstalled ones', async () => {
    listApps.mockReturnValue([
      { id: 'a', status: 'active' },
      { id: 'b', status: 'paused' },
      { id: 'c', status: 'uninstalled' },
    ])

    const report = await collectDiagnosticReport()

    expect(listApps).toHaveBeenCalledWith({ type: 'mcp' })
    expect(report.config.mcpServerCount).toBe(2)
  })
})
