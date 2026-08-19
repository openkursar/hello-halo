/**
 * Unit tests for resolveClaudeConfigDir (foundation/config.service).
 *
 * The critical contract: callers may omit mode/customDir and both fall back to
 * the persisted config. The customDir fallback previously did not exist, which
 * made single-argument callers (skill discovery, automation runs) resolve the
 * wrong directory in 'custom' mode while the SDK resolved the right one.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { join } from 'path'
import { homedir } from 'os'
import {
  resolveClaudeConfigDir,
  saveConfig,
  getConfig,
} from '../../../src/main/foundation/config.service'

function setAgentConfig(agent: Record<string, unknown>): void {
  saveConfig({ agent: { ...getConfig().agent, ...agent } })
}

describe('resolveClaudeConfigDir', () => {
  beforeEach(() => {
    setAgentConfig({ configDirMode: undefined, customConfigDir: undefined })
  })

  it("defaults to the halo-managed dir when nothing is configured", () => {
    expect(resolveClaudeConfigDir()).toMatch(/claude-config$/)
  })

  it("'cc' mode resolves to ~/.claude", () => {
    expect(resolveClaudeConfigDir('cc')).toBe(join(homedir(), '.claude'))
  })

  it("'custom' mode uses an explicitly passed customDir", () => {
    expect(resolveClaudeConfigDir('custom', '/tmp/my-config')).toBe('/tmp/my-config')
  })

  it("'custom' mode falls back to the persisted customConfigDir when the argument is omitted", () => {
    setAgentConfig({ configDirMode: 'custom', customConfigDir: '/tmp/persisted-config' })
    // Single-argument call sites (skill discovery, automation runs) must
    // resolve the same dir as the SDK, which passes customDir explicitly.
    expect(resolveClaudeConfigDir('custom')).toBe('/tmp/persisted-config')
    expect(resolveClaudeConfigDir(getConfig().agent?.configDirMode)).toBe('/tmp/persisted-config')
  })

  it("'custom' mode without any customDir falls back to the halo-managed dir", () => {
    setAgentConfig({ configDirMode: 'custom', customConfigDir: undefined })
    expect(resolveClaudeConfigDir('custom')).toMatch(/claude-config$/)
  })

  it('omitted mode falls back to the persisted configDirMode', () => {
    setAgentConfig({ configDirMode: 'cc' })
    expect(resolveClaudeConfigDir()).toBe(join(homedir(), '.claude'))
  })
})
