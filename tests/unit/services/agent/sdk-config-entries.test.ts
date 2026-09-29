/**
 * The two entry points that build an agent session's SDK options.
 *
 * A user session reads the user's global AI settings itself; an internal task
 * does not, so the user's tool restrictions, turn cap and prompt style never
 * leak into work they did not ask for. Which entry each call site uses is
 * pinned per site by entry-capability-matrix.test.ts; this file pins what the
 * two entries do with the settings.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const state = vi.hoisted(() => ({
  config: {} as Record<string, any>,
  haloConfigDir: '',
  ccConfigDir: '',
}))

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => state.config,
  onApiConfigChange: vi.fn(),
  onAgentConfigChange: vi.fn(),
  onNetworkConfigChange: vi.fn(),
  resolveClaudeConfigDir: () => (state.config.agent?.configDirMode === 'cc' ? state.ccConfigDir : state.haloConfigDir),
}))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))

import {
  buildUserSessionSdkOptions,
  buildInternalTaskSdkOptions,
  type ResolvedSdkCredentials,
} from '../../../../src/main/services/agent/sdk-config'
import { DEFAULT_MAX_TURNS } from '../../../../src/shared/constants/agent-limits'
import { DEFAULT_DISABLED_TOOLS, TEAM_TOOLS } from '../../../../src/shared/constants/disabled-tools'

const credentials: ResolvedSdkCredentials = {
  anthropicBaseUrl: 'https://example.invalid',
  anthropicApiKey: 'key',
  sdkModel: 'test-model',
  displayModel: 'Test Model',
}

let workDir = ''

const params = () => ({
  credentials,
  workDir,
  electronPath: '/electron',
  spaceId: 'space-1',
  conversationId: 'conv-1',
})

const DIGITAL_HUMANS_LINE = 'Halo Digital Humans: Create and manage'

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'halo-entries-work-'))
  state.haloConfigDir = mkdtempSync(join(tmpdir(), 'halo-entries-cfg-'))
  state.ccConfigDir = mkdtempSync(join(tmpdir(), 'halo-entries-cc-'))
})

afterAll(() => {
  for (const dir of [workDir, state.haloConfigDir, state.ccConfigDir]) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  state.config = { agent: {} }
})

describe('buildUserSessionSdkOptions', () => {
  it('reads the user AI settings itself', async () => {
    state.config.agent = { maxTurns: 12, disabledTools: ['Foo'], promptProfile: 'official', enableDigitalHumans: false }
    const options = await buildUserSessionSdkOptions(params())

    expect(options.maxTurns).toBe(12)
    expect(options.disallowedTools).toContain('Foo')
    expect(options.disallowedTools).not.toContain(DEFAULT_DISABLED_TOOLS[0])
    expect(options.systemPrompt).not.toContain(DIGITAL_HUMANS_LINE)
  })

  it('uses the defaults for a user who never configured anything', async () => {
    const options = await buildUserSessionSdkOptions(params())

    expect(options.maxTurns).toBe(DEFAULT_MAX_TURNS)
    for (const tool of DEFAULT_DISABLED_TOOLS) expect(options.disallowedTools).toContain(tool)
    expect(options.systemPrompt).toContain(DIGITAL_HUMANS_LINE)
  })

  it('always withholds the native team tools, whatever the user disabled', async () => {
    state.config.agent = { disabledTools: [] }
    const options = await buildUserSessionSdkOptions(params())

    for (const tool of TEAM_TOOLS) expect(options.disallowedTools).toContain(tool)
  })
})

describe('buildInternalTaskSdkOptions', () => {
  beforeEach(() => {
    state.config.agent = { maxTurns: 12, disabledTools: ['Foo'], promptProfile: 'official', enableDigitalHumans: true }
  })

  it('ignores the user\'s turn cap, disabled tools and prompt style', async () => {
    const options = await buildInternalTaskSdkOptions(params())
    const asUser = await buildUserSessionSdkOptions(params())

    expect(options.maxTurns).toBe(DEFAULT_MAX_TURNS)
    expect(options.disallowedTools).not.toContain('Foo')
    for (const tool of DEFAULT_DISABLED_TOOLS) expect(options.disallowedTools).toContain(tool)
    // The 'official' template the user picked is not the one an internal task gets.
    expect(options.systemPrompt).not.toBe(asUser.systemPrompt)
  })

  it('does not tell the model it can manage digital humans', async () => {
    const options = await buildInternalTaskSdkOptions(params())
    expect(options.systemPrompt).not.toContain(DIGITAL_HUMANS_LINE)
  })

  it('still withholds the native team tools', async () => {
    const options = await buildInternalTaskSdkOptions(params())
    for (const tool of TEAM_TOOLS) expect(options.disallowedTools).toContain(tool)
  })
})

describe('the engine config directory', () => {
  it('follows configDirMode for both entries: it holds the CLI credential slot as well as skills', async () => {
    state.config.agent = { configDirMode: 'cc' }
    expect((await buildUserSessionSdkOptions(params())).env.CLAUDE_CONFIG_DIR).toBe(state.ccConfigDir)
    expect((await buildInternalTaskSdkOptions(params())).env.CLAUDE_CONFIG_DIR).toBe(state.ccConfigDir)

    state.config.agent = { configDirMode: 'halo' }
    expect((await buildUserSessionSdkOptions(params())).env.CLAUDE_CONFIG_DIR).toBe(state.haloConfigDir)
    expect((await buildInternalTaskSdkOptions(params())).env.CLAUDE_CONFIG_DIR).toBe(state.haloConfigDir)
  })
})
