import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/main/foundation/config.service', () => ({
  resolveClaudeConfigDir: () => join(globalThis.__HALO_TEST_DIR__, 'cli-auth'),
}))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({ getDefaultEngine: () => 'halo' }))

import { assertDelegatedAuthReady } from '../../../../src/main/services/agent/cli-auth'

describe('session-scoped delegated authentication', () => {
  it('accepts a signed-in CC session while the application defaults to Halo', () => {
    const directory = join(globalThis.__HALO_TEST_DIR__, 'cli-auth')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'test' } }))
    expect(() => assertDelegatedAuthReady('anthropic')).not.toThrow()
    expect(() => assertDelegatedAuthReady('halo')).toThrow('this session uses "halo"')
    expect(() => assertDelegatedAuthReady('codex')).toThrow('this session uses "codex"')
  })

  it('still requires a login for an explicit CC session', () => {
    expect(() => assertDelegatedAuthReady('anthropic')).toThrow('not signed in')
  })
})
