/**
 * A session cannot be spawned in a working directory that is gone; the error
 * carries which folder and which space, so the chat can offer to change it
 * instead of only reporting a failure — in its fields, not its message.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const state = vi.hoisted(() => ({ configDir: '' }))

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ agent: {} }),
  onApiConfigChange: vi.fn(),
  onAgentConfigChange: vi.fn(),
  onNetworkConfigChange: vi.fn(),
  resolveClaudeConfigDir: () => state.configDir,
}))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  getActiveEngine: () => 'anthropic',
  getEngineCapabilities: () => ({ features: { hooks: true } }),
}))

import { buildUserSessionSdkOptions } from '../../../../src/main/services/agent/sdk-config'
import { WorkingDirectoryUnavailableError } from '../../../../src/main/services/agent/working-dir'

beforeAll(() => {
  state.configDir = mkdtempSync(join(tmpdir(), 'halo-workdir-cfg-'))
})

afterAll(() => {
  rmSync(state.configDir, { recursive: true, force: true })
})

describe('spawning in a missing working directory', () => {
  it('fails with the folder and the space it belongs to', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missing = join(tmpdir(), 'halo-no-such-folder', 'project')

    const failure = await buildUserSessionSdkOptions({
      credentials: { anthropicBaseUrl: 'https://example.invalid', anthropicApiKey: 'key', sdkModel: 'm', displayModel: 'M' },
      workDir: missing,
      electronPath: '/electron',
      spaceId: 'space-1',
      conversationId: 'conv-1',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(WorkingDirectoryUnavailableError)
    expect(failure).toMatchObject({ workDir: missing, spaceId: 'space-1' })
    // Only the field carries the folder; the message may be passed on.
    expect((failure as Error).message).not.toContain('halo-no-such-folder')
  })
})
