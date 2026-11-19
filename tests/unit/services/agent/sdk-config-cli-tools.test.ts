/**
 * Installed CLI tools reach every user session through the one builder all
 * user entries share, whatever the engine, and never an internal task.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const state = vi.hoisted(() => ({ configDir: '', workDir: '' }))
const cliTools = vi.hoisted(() => ({
  apply: vi.fn(async (env: Record<string, unknown>, _request: { entry: string; engine: string }) => {
    env.PATH = `${String(env.PATH ?? '')}:/cli/views/v/bin`
    env.HALO_CLI_TOOLS_BIN = '/cli/views/v/bin'
    return '/cli/views/v/bin'
  }),
}))

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ agent: {} }),
  onApiConfigChange: vi.fn(),
  onAgentConfigChange: vi.fn(),
  onNetworkConfigChange: vi.fn(),
  onAiSourcesConfigChange: vi.fn(),
  resolveClaudeConfigDir: () => state.configDir,
}))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  getDefaultEngine: () => 'anthropic', resolveDefaultEngine: async () => 'anthropic',
  getEngineCapabilities: () => ({ features: { hooks: true } }),
}))
vi.mock('../../../../src/main/foundation/device-identity', () => ({
  getDeviceIdentity: () => ({ deviceId: 'test-device' }),
}))
vi.mock('../../../../src/main/services/cli-tools', () => ({
  CLI_TOOLS_BIN_ENV: 'HALO_CLI_TOOLS_BIN',
  applyCliToolsEnv: cliTools.apply,
}))

import { buildInternalTaskSdkOptions, buildUserSessionSdkOptions } from '../../../../src/main/services/agent/sdk-config'

const params = () => ({
  credentials: { anthropicBaseUrl: 'https://example.invalid', anthropicApiKey: 'key', sdkModel: 'm', displayModel: 'M' },
  workDir: state.workDir,
  electronPath: '/electron',
  spaceId: 'space-1',
  conversationId: 'conv-1',
})

beforeAll(() => {
  state.configDir = mkdtempSync(join(tmpdir(), 'halo-cli-cfg-'))
  state.workDir = mkdtempSync(join(tmpdir(), 'halo-cli-work-'))
})

afterAll(() => {
  rmSync(state.configDir, { recursive: true, force: true })
  rmSync(state.workDir, { recursive: true, force: true })
})

beforeEach(() => {
  cliTools.apply.mockClear()
})

describe('installed CLI tools in session options', () => {
  it.each(['anthropic', 'codex', 'halo', 'dsh'] as const)('reach a user session on %s', async engineId => {
    const options = await buildUserSessionSdkOptions({ ...params(), engineId })
    expect(cliTools.apply).toHaveBeenCalledTimes(1)
    expect(cliTools.apply).toHaveBeenCalledWith(options.env, { entry: 'other', engine: engineId })
    expect(options.env.HALO_CLI_TOOLS_BIN).toBe('/cli/views/v/bin')
    expect(String(options.env.PATH).endsWith(':/cli/views/v/bin')).toBe(true)
  })

  it('never reach an internal task', async () => {
    const options = await buildInternalTaskSdkOptions(params())
    expect(cliTools.apply).not.toHaveBeenCalled()
    expect(options.env.HALO_CLI_TOOLS_BIN).toBeUndefined()
  })
})
