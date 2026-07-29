/**
 * Unit Tests: services/agent — CC MCP auth-state reconciliation
 *
 * Covers the two properties the module's safety rests on:
 * - only token-less records are removed, so a genuinely authorized server and
 *   unrelated credentials (claudeAiOauth) always survive
 * - the entry key matches the digest CC derives, since a mismatch silently
 *   turns every cleanup into a no-op
 *
 * Runs against the plaintext store, which is the real store on Windows/Linux
 * and the fallback on macOS.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let configDir = ''

vi.mock('../../../src/main/foundation/config.service', () => ({
  resolveClaudeConfigDir: vi.fn(() => configDir)
}))

import { purgeStaleMcpOAuth } from '../../../src/main/services/agent/mcp-auth-state'

const CREDENTIALS = '.credentials.json'

/** The key CC derives for a server, reproduced independently of the module. */
function ccEntryKey(
  name: string,
  config: { type: string; url: string; headers?: Record<string, string> }
): string {
  const payload = JSON.stringify({
    type: config.type,
    url: config.url,
    headers: config.headers ?? {}
  })
  return `${name}|${createHash('sha256').update(payload).digest('hex').slice(0, 16)}`
}

function writeBlob(blob: unknown): void {
  writeFileSync(join(configDir, CREDENTIALS), JSON.stringify(blob), 'utf-8')
}

function readBlob(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configDir, CREDENTIALS), 'utf-8'))
}

const STALE = { serverName: 'x', accessToken: '', expiresAt: 0, discoveryState: { authorizationServerUrl: 'http://x/' } }

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'halo-mcp-auth-'))
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('purgeStaleMcpOAuth', () => {
  const server = { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { 'Api-Key': 'k' } }

  it('removes a token-less record for a configured server', async () => {
    const key = ccEntryKey('pace', server)
    writeBlob({ mcpOAuth: { [key]: STALE } })

    const removed = await purgeStaleMcpOAuth({ pace: server }, 'test')

    expect(removed).toBe(1)
    expect(readBlob().mcpOAuth).toEqual({})
  })

  it('keeps records that hold an access token', async () => {
    const key = ccEntryKey('pace', server)
    writeBlob({ mcpOAuth: { [key]: { ...STALE, accessToken: 'real-token' } } })

    expect(await purgeStaleMcpOAuth({ pace: server }, 'test')).toBe(0)
    expect(readBlob().mcpOAuth).toHaveProperty(key)
  })

  it('keeps records that hold only a refresh token', async () => {
    const key = ccEntryKey('pace', server)
    writeBlob({ mcpOAuth: { [key]: { ...STALE, refreshToken: 'r' } } })

    expect(await purgeStaleMcpOAuth({ pace: server }, 'test')).toBe(0)
    expect(readBlob().mcpOAuth).toHaveProperty(key)
  })

  it('preserves unrelated credentials in the same blob', async () => {
    const key = ccEntryKey('pace', server)
    const claudeAiOauth = { accessToken: 'sk-real', refreshToken: 'sk-refresh' }
    writeBlob({ claudeAiOauth, mcpOAuth: { [key]: STALE } })

    await purgeStaleMcpOAuth({ pace: server }, 'test')

    expect(readBlob().claudeAiOauth).toEqual(claudeAiOauth)
  })

  it('leaves records belonging to other servers untouched', async () => {
    const mine = ccEntryKey('pace', server)
    const other = ccEntryKey('dpms', { type: 'sse', url: 'http://127.0.0.1:9/sse' })
    writeBlob({ mcpOAuth: { [mine]: STALE, [other]: STALE } })

    expect(await purgeStaleMcpOAuth({ pace: server }, 'test')).toBe(1)
    expect(readBlob().mcpOAuth).toEqual({ [other]: STALE })
  })

  it('is a no-op when the header set no longer matches the stored key', async () => {
    writeBlob({ mcpOAuth: { [ccEntryKey('pace', server)]: STALE } })

    const rotated = { ...server, headers: { 'Api-Key': 'rotated' } }
    expect(await purgeStaleMcpOAuth({ pace: rotated }, 'test')).toBe(0)
  })

  it('ignores stdio servers, which CC never routes through OAuth', async () => {
    writeBlob({ mcpOAuth: { [ccEntryKey('pace', server)]: STALE } })

    expect(await purgeStaleMcpOAuth({ local: { command: 'node', args: ['x.js'] } }, 'test')).toBe(0)
  })

  it('does not touch the store when there is nothing to remove', async () => {
    writeBlob({ claudeAiOauth: { accessToken: 'sk-real' } })
    const before = statSync(join(configDir, CREDENTIALS)).mtimeMs

    expect(await purgeStaleMcpOAuth({ pace: server }, 'test')).toBe(0)
    expect(statSync(join(configDir, CREDENTIALS)).mtimeMs).toBe(before)
  })

  it('tolerates an absent or unreadable store', async () => {
    expect(await purgeStaleMcpOAuth({ pace: server }, 'test')).toBe(0)

    writeFileSync(join(configDir, CREDENTIALS), 'not json', 'utf-8')
    expect(await purgeStaleMcpOAuth({ pace: server }, 'test')).toBe(0)
  })

  it('accepts an empty or absent server set', async () => {
    expect(await purgeStaleMcpOAuth({}, 'test')).toBe(0)
    expect(await purgeStaleMcpOAuth(null, 'test')).toBe(0)
    expect(await purgeStaleMcpOAuth(undefined, 'test')).toBe(0)
  })

  it('writes the store back with owner-only permissions', async () => {
    writeBlob({ mcpOAuth: { [ccEntryKey('pace', server)]: STALE } })

    await purgeStaleMcpOAuth({ pace: server }, 'test')

    expect(statSync(join(configDir, CREDENTIALS)).mode & 0o777).toBe(0o600)
  })
})
