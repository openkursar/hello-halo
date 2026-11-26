/**
 * Installed CLI tools need nothing in a session's environment: their skills
 * name the launchers by absolute path. User sessions still get organization
 * access and, where the engine runs hooks, the organization status reminders;
 * internal tasks get neither.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const state = vi.hoisted(() => ({ configDir: '', workDir: '', hooks: true, signIn: 'active' as string }))

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
  getEngineCapabilities: () => ({ features: { hooks: state.hooks } }),
}))
vi.mock('../../../../src/main/foundation/device-identity', () => ({
  getDeviceIdentity: () => ({ deviceId: 'test-device' }),
}))
vi.mock('../../../../src/main/services/enterprise-identity', () => ({
  applyOrgSessionEnv: (env: Record<string, unknown>) => {
    if (state.signIn !== 'active') return ''
    env.EC_BROKER_COMMAND = '["broker"]'
    return 'EC_BROKER_COMMAND=["broker"]'
  },
  peekEnterpriseIdentityState: () => ({ status: state.signIn, capabilities: [], boundTools: [], signingIn: false, canUnbindDevice: false }),
}))
vi.mock('../../../../src/main/services/cli-tools', () => ({
  peekOrganizationTools: () => [],
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
  state.hooks = true
  state.signIn = 'active'
})

describe('user session options and installed CLI tools', () => {
  it.each(['anthropic', 'codex', 'halo', 'dsh'] as const)('add no tool directory to a user session on %s', async engineId => {
    const internal = await buildInternalTaskSdkOptions({ ...params(), engineId })
    const options = await buildUserSessionSdkOptions({ ...params(), engineId })
    expect(options.env.PATH).toBe(internal.env.PATH)
    expect(Object.keys(options.env).filter(key => /CLI_TOOLS/.test(key))).toEqual([])
    expect(options.env.EC_BROKER_COMMAND).toBe('["broker"]')
    expect(options.orgSessionEnv).toMatch(/^[0-9a-f]{16}$/)
  })

  it('adds the organization reminder hooks where the engine runs hooks and the build has sign-in', async () => {
    const options = await buildUserSessionSdkOptions({ ...params(), engineId: 'halo' })
    expect(options.hooks.PostToolUse).toEqual(expect.arrayContaining([expect.objectContaining({ matcher: 'Bash' })]))
    expect(options.hooks.PreCompact).toHaveLength(1)

    state.hooks = false
    expect((await buildUserSessionSdkOptions({ ...params(), engineId: 'dsh' })).hooks?.PreCompact).toBeUndefined()
    state.hooks = true
    state.signIn = 'unconfigured'
    expect((await buildUserSessionSdkOptions({ ...params(), engineId: 'halo' })).hooks?.PreCompact).toBeUndefined()
  })

  it('give an internal task neither organization access nor reminders', async () => {
    const options = await buildInternalTaskSdkOptions(params())
    expect(options.env.EC_BROKER_COMMAND).toBeUndefined()
    expect(options.hooks?.PreCompact).toBeUndefined()
  })
})
