/**
 * The self-API credential, the manual tool and the usage guide are one
 * capability with one switch. The bug this pins shipped because they were
 * three independent decisions: the tool was always-on for space chat only,
 * the credential was hardcoded true there, and the prompt paragraph was baked
 * into the base system prompt every digital human also receives — so an
 * automation run was instructed to call a tool it did not have and could not
 * have authenticated.
 *
 * These cases assert the coupling at each of the three points rather than the
 * env-builder in isolation, which is what let the prompt half drift.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// Same transitive electron pull the other sdk-config tests mock out.
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))

import { buildSdkEnv } from '../../../../src/main/services/agent/sdk-config'
import { HALO_API_TOOLSET_ID } from '../../../../src/main/services/api-ref'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8')

describe('self-API credentials', () => {
  it('injects the base URL and token when the session gets the capability', () => {
    const env = buildSdkEnv({
      selfApi: { url: 'http://127.0.0.1:4791', token: 'self-token' },
      spaceId: 'space-a',
    } as Parameters<typeof buildSdkEnv>[0])

    expect(env.HALO_API_URL).toBe('http://127.0.0.1:4791')
    expect(env.HALO_API_TOKEN).toBe('self-token')
    expect(env.HALO_SPACE_ID).toBe('space-a')
  })

  it('sets none of the three otherwise, HALO_SPACE_ID included', () => {
    const env = buildSdkEnv({ spaceId: 'space-a' } as Parameters<typeof buildSdkEnv>[0])

    expect(env.HALO_API_URL).toBeUndefined()
    expect(env.HALO_API_TOKEN).toBeUndefined()
    // Only the manual's curl examples read it, so on its own it would describe
    // a capability the session does not have.
    expect(env.HALO_SPACE_ID).toBeUndefined()
  })
})

describe('self-API capability coupling', () => {
  it('is registered as a toolset, not as an always-on server', () => {
    expect(read('src/main/services/agent/toolsets/registry.ts')).toContain('HALO_API_TOOLSET_ID')
    // The always-on block in the broker is what made the tool present in
    // sessions whose prompt and credentials disagreed with it.
    expect(read('src/main/services/agent/toolsets/broker.ts')).not.toContain('createApiRefMcpServer')
  })

  it('never states the capability in the base system prompt', () => {
    // Both profiles reach digital humans through buildAppSystemPrompt /
    // buildIdentityFragments, so anything unconditional here is delivered to
    // sessions that do not have the tool.
    const prompt = read('src/main/services/agent/system-prompt.ts')
    expect(prompt).not.toContain('halo_api_ref')
    expect(prompt).not.toContain('HALO_API_URL')
  })

  it('gates the credential on the same switch at every chat entry point', () => {
    // quick.md hard rule 13: a turn feature must cover all three entry points.
    for (const rel of [
      'src/main/services/agent/send-message.ts',
      'src/main/services/agent/session-manager.ts',
      'src/main/apps/runtime/app-chat.ts',
      'src/main/apps/runtime/execute.ts',
    ]) {
      const source = read(rel)
      expect(source, `${rel} must pass selfApiAccess`).toContain('selfApiAccess:')
      expect(source, `${rel} must not hardcode selfApiAccess`).not.toContain('selfApiAccess: true')
    }
  })

  it('uses one identifier for the toolset, the MCP server and the permission', () => {
    expect(HALO_API_TOOLSET_ID).toBe('halo-api-ref')
    // The runtime injection sites use the literal so the builtin-mcp drift
    // guard can see them; this keeps the literal and the constant in step.
    for (const rel of ['src/main/apps/runtime/app-chat.ts', 'src/main/apps/runtime/execute.ts']) {
      expect(read(rel)).toContain(`'${HALO_API_TOOLSET_ID}': createApiRefMcpServer()`)
    }
  })

  it('withholds the capability from IM guests', () => {
    // Guests can have Bash removed, and buildGuestMcpServers drops the server
    // for them; the credential and guide must be withheld on the same branch.
    expect(read('src/main/apps/runtime/app-chat.ts')).toContain("permCtx?.isOwner !== false")
  })
})
