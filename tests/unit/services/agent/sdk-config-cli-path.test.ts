/**
 * A packaged build runs the Claude Code CLI from its real file beside the
 * archive: the CLI starts programs found next to its own file (ripgrep behind
 * Grep and Glob), and no OS can execute a file inside app.asar.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { join } from 'path'

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
  getActiveEngine: () => 'anthropic',
  getEngineCapabilities: () => ({ features: { hooks: true } }),
}))

import { buildCliLoginCommand, resolveClaudeCodeCliPath } from '../../../../src/main/services/agent/sdk-config'

const CLI = join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
const ARCHIVE = join('/Applications/Halo.app/Contents/Resources', 'app.asar')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Claude Code CLI path in a packaged build', () => {
  it('is the unpacked copy beside the archive, never a path inside it', () => {
    vi.spyOn(app, 'getAppPath').mockReturnValue(ARCHIVE)

    expect(resolveClaudeCodeCliPath()).toBe(join(`${ARCHIVE}.unpacked`, CLI))
  })

  it('stays inside the app folder when the build is not archived', () => {
    const appDir = join('/opt/Halo/resources', 'app')
    vi.spyOn(app, 'getAppPath').mockReturnValue(appDir)

    expect(resolveClaudeCodeCliPath()).toBe(join(appDir, CLI))
  })

  it('gives the sign-in command the same real file', () => {
    vi.spyOn(app, 'getAppPath').mockReturnValue(ARCHIVE)

    expect(buildCliLoginCommand()).toContain(`'${join(`${ARCHIVE}.unpacked`, CLI)}' /login`)
  })
})
