/**
 * Runtime defense-in-depth filter for `security.mcpCommandBlacklist`.
 *
 * The install-time gate in `AppManager.install()` is the primary defense,
 * but an admin can tighten the policy *after* installs already exist
 * (deployment-time update, policy bump in a new build). When that happens
 * the runtime path in `getDbMcpServers()` / `getMcpServersForRequires()`
 * must drop the now-blacklisted MCP before its config reaches the SDK,
 * so the child process is never spawned.
 *
 * These tests pin that behavior. They mock the App manager + product
 * config so the helpers can be exercised in isolation without DB / FS.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Partial-mock auth-loader: only override loadProductConfig — every other
// export (getDataFolderName, etc.) is consulted by config.service during
// module init and must keep its real implementation.
vi.mock('../../../../src/main/foundation/product-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/foundation/product-config')>()
  return {
    ...actual,
    loadProductConfig: vi.fn(() => ({ name: 'test', version: '0.0.0', authProviders: [] })),
  }
})

vi.mock('../../../../src/main/services/app-bridge', () => ({
  getAppManager: vi.fn(),
}))

import { loadProductConfig } from '../../../../src/main/foundation/product-config'
import { getAppManager } from '../../../../src/main/services/app-bridge'
import { getDbMcpServers, getMcpServersForRequires } from '../../../../src/main/services/agent/helpers'

type MockedFn = ReturnType<typeof vi.fn>

function setBlacklist(blacklist?: string[]): void {
  ;(loadProductConfig as unknown as MockedFn).mockReturnValue({
    name: 'test',
    version: '0.0.0',
    authProviders: [],
    ...(blacklist !== undefined ? { security: { mcpCommandBlacklist: blacklist } } : {}),
  })
}

interface FakeMcpApp {
  id: string
  specId: string
  spaceId: string | null
  status: 'active' | 'paused'
  spec: {
    type: 'mcp'
    mcp_server: {
      transport?: 'stdio' | 'sse' | 'streamable-http'
      command: string
      args?: string[]
    }
  }
  userConfig?: Record<string, unknown>
}

function setInstalledMcps(apps: FakeMcpApp[]): void {
  ;(getAppManager as unknown as MockedFn).mockReturnValue({
    listEffectiveMcpApps: (_spaceId: string) => apps,
    // getMcpAppByDependency() is consulted by getMcpServersForRequires —
    // resolve the test fixture by specId so the helper can build its map.
    getMcpAppByDependency: ({ id }: { id: string }) => apps.find((a) => a.specId === id) ?? null,
  })
}

function stdioMcp(specId: string, command: string, overrides?: Partial<FakeMcpApp>): FakeMcpApp {
  return {
    id: `id-${specId}`,
    specId,
    spaceId: 'space-x',
    status: 'active',
    spec: { type: 'mcp', mcp_server: { transport: 'stdio', command } },
    ...overrides,
  }
}

const SPACE = 'space-x'

describe('agent/helpers — MCP command blacklist runtime filter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setBlacklist(undefined)
  })

  // ---------------------------------------------------------------------------
  // getDbMcpServers
  // ---------------------------------------------------------------------------

  describe('getDbMcpServers', () => {
    it('returns every installed stdio MCP when no blacklist is configured', () => {
      setBlacklist(undefined)
      setInstalledMcps([
        stdioMcp('echo-mcp', 'echo'),
        stdioMcp('rm-mcp', 'rm'),
      ])
      const result = getDbMcpServers(SPACE)
      expect(result).not.toBeNull()
      expect(Object.keys(result!).sort()).toEqual(['echo-mcp', 'rm-mcp'])
    })

    it('drops stdio MCPs whose command matches the blacklist (post-install tightening)', () => {
      setBlacklist(['rm'])
      setInstalledMcps([
        stdioMcp('echo-mcp', 'echo'),
        stdioMcp('rm-mcp', 'rm'),
      ])
      const result = getDbMcpServers(SPACE)
      expect(result).not.toBeNull()
      expect(Object.keys(result!)).toEqual(['echo-mcp'])
    })

    it('applies the same basename normalization as install-time check', () => {
      setBlacklist(['cmd'])
      setInstalledMcps([
        stdioMcp('windows-cmd', 'C:\\Windows\\System32\\cmd.exe'),
        stdioMcp('windows-bat', 'C:\\tools\\cmd.bat'),
        stdioMcp('safe', '/usr/bin/echo'),
      ])
      const result = getDbMcpServers(SPACE)
      expect(result).not.toBeNull()
      expect(Object.keys(result!)).toEqual(['safe'])
    })

    it('returns null when every installed MCP is filtered out', () => {
      setBlacklist(['rm'])
      setInstalledMcps([stdioMcp('rm-mcp', 'rm')])
      expect(getDbMcpServers(SPACE)).toBeNull()
    })

    it('never filters SSE / streamable-http MCPs (no stdio command to spawn)', () => {
      // The remote transports use `command` as a URL field — they don't
      // spawn a child process, so the blacklist (a process-name policy)
      // must not touch them. The remoteMcpSafe policy is the separate gate
      // for remote MCPs.
      setBlacklist(['https'])
      setInstalledMcps([
        {
          id: 'sse-id',
          specId: 'sse-mcp',
          spaceId: SPACE,
          status: 'active',
          spec: {
            type: 'mcp',
            mcp_server: { transport: 'sse', command: 'https://example.com/sse' },
          },
        },
        {
          id: 'http-id',
          specId: 'http-mcp',
          spaceId: SPACE,
          status: 'active',
          spec: {
            type: 'mcp',
            mcp_server: { transport: 'streamable-http', command: 'https://example.com/mcp' },
          },
        },
      ])
      const result = getDbMcpServers(SPACE)
      expect(result).not.toBeNull()
      expect(Object.keys(result!).sort()).toEqual(['http-mcp', 'sse-mcp'])
    })
  })

  // ---------------------------------------------------------------------------
  // getMcpServersForRequires
  // ---------------------------------------------------------------------------

  describe('getMcpServersForRequires', () => {
    it('returns the declared stdio MCP when no blacklist is configured', () => {
      setBlacklist(undefined)
      setInstalledMcps([stdioMcp('echo-mcp', 'echo')])
      const result = getMcpServersForRequires([{ id: 'echo-mcp' }], SPACE)
      expect(Object.keys(result)).toEqual(['echo-mcp'])
    })

    it('drops a declared MCP whose command is on the blacklist', () => {
      setBlacklist(['rm'])
      setInstalledMcps([
        stdioMcp('echo-mcp', 'echo'),
        stdioMcp('rm-mcp', 'rm'),
      ])
      const result = getMcpServersForRequires(
        [{ id: 'echo-mcp' }, { id: 'rm-mcp' }],
        SPACE,
      )
      expect(Object.keys(result)).toEqual(['echo-mcp'])
    })
  })
})
