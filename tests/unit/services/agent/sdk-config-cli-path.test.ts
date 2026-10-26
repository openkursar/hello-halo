import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ agent: {} }),
  onApiConfigChange: vi.fn(),
  onAgentConfigChange: vi.fn(),
  onNetworkConfigChange: vi.fn(),
  resolveClaudeConfigDir: () => '/halo-config',
}))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  getDefaultEngine: () => 'anthropic', resolveDefaultEngine: async () => 'anthropic',
  getEngineCapabilities: () => ({ features: { hooks: true } }),
}))

const runtime = vi.hoisted(() => ({ launch: null as any }))
vi.mock('../../../../src/main/services/cc-runtime', () => ({ resolveCcRuntimeLaunch: async () => runtime.launch }))

import { buildCliLoginCommand } from '../../../../src/main/services/agent/sdk-config'

afterEach(() => { runtime.launch = null; vi.restoreAllMocks() })

describe('selected Claude Code login', () => {
  it('offers no command without a compatible external runtime', async () => {
    expect(await buildCliLoginCommand()).toBe('')
  })
  it('launches native CC directly in Halo’s credential slot', async () => {
    runtime.launch = { command: '/Users/me/My CC/claude', argsPrefix: [], env: {}, kind: 'native' }
    const command = await buildCliLoginCommand()
    expect(command).toContain("CLAUDE_CONFIG_DIR='/halo-config'")
    expect(command).toContain("DISABLE_AUTOUPDATER='1'")
    expect(command).toContain("'/Users/me/My CC/claude' /login")
    expect(command).not.toContain('ELECTRON_RUN_AS_NODE')
  })
  it('uses the supplied JavaScript interpreter and quotes paths', async () => {
    runtime.launch = { command: '/Applications/Halo Next', argsPrefix: ["/Users/o'neil/cli.js"], env: { ELECTRON_RUN_AS_NODE: '1' }, kind: 'javascript' }
    const command = await buildCliLoginCommand()
    expect(command).toContain("ELECTRON_RUN_AS_NODE='1'")
    expect(command).toContain("'/Applications/Halo Next'")
    expect(command).toContain("'" + "/Users/o" + "'\\''" + "neil/cli.js'")
  })
})
