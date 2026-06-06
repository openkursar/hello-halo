/**
 * Security Policy Unit Tests
 *
 * Covers the centralized security-policy module: detection helpers,
 * sync/async rejection helpers, and the default-permissive behavior that
 * keeps open-source builds unaffected.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the product config loader so each test controls the security block.
vi.mock('../../../src/main/foundation/product-config', () => ({
  loadProductConfig: vi.fn(),
}))

import { loadProductConfig } from '../../../src/main/foundation/product-config'
import {
  isRemoteMcpSafe,
  isCredentialAtRestSafe,
  getSecurityPolicy,
  isMcpAppSpec,
  patchTouchesMcp,
  configTouchesMcp,
  yamlIsMcpSpec,
  rejectIfRemoteMcpForbidden,
  rejectIfRemoteMcpForbiddenAsync,
  MCP_REMOTE_INSTALL_FORBIDDEN,
  getMcpCommandBlacklist,
  isMcpCommandBlocked,
  MCP_COMMAND_BLOCKED,
  MCP_COMMAND_BLOCKED_MESSAGE,
} from '../../../src/main/services/security-policy'

type MockedLoader = ReturnType<typeof vi.fn>

function setProductConfig(security?: Record<string, unknown>): void {
  ;(loadProductConfig as unknown as MockedLoader).mockReturnValue({
    name: 'test',
    version: '0.0.0',
    authProviders: [],
    ...(security !== undefined ? { security } : {}),
  })
}

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn()
  const status = vi.fn(() => ({ json }))
  return { status: status as unknown as ReturnType<typeof vi.fn>, json }
}

describe('security-policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // --------------------------------------------------------------------------
  // Policy accessors — default permissive behavior
  // --------------------------------------------------------------------------

  describe('getSecurityPolicy / isRemoteMcpSafe', () => {
    it('returns empty policy when product.json omits security (open-source default)', () => {
      setProductConfig(undefined)
      expect(getSecurityPolicy()).toEqual({})
      expect(isRemoteMcpSafe()).toBe(false)
    })

    it('returns false when remoteMcpSafe is explicitly false', () => {
      setProductConfig({ remoteMcpSafe: false })
      expect(isRemoteMcpSafe()).toBe(false)
    })

    it('returns true only when remoteMcpSafe === true (enterprise opt-in)', () => {
      setProductConfig({ remoteMcpSafe: true })
      expect(isRemoteMcpSafe()).toBe(true)
    })

    it('ignores non-boolean truthy values to avoid accidental enablement', () => {
      setProductConfig({ remoteMcpSafe: 1 as unknown as boolean })
      expect(isRemoteMcpSafe()).toBe(false)
    })
  })

  describe('isCredentialAtRestSafe', () => {
    it('returns false when product.json omits security (open-source default)', () => {
      setProductConfig(undefined)
      expect(isCredentialAtRestSafe()).toBe(false)
    })

    it('returns false when credentialAtRestSafe is explicitly false', () => {
      setProductConfig({ credentialAtRestSafe: false })
      expect(isCredentialAtRestSafe()).toBe(false)
    })

    it('returns true only when credentialAtRestSafe === true (enterprise opt-in)', () => {
      setProductConfig({ credentialAtRestSafe: true })
      expect(isCredentialAtRestSafe()).toBe(true)
    })

    it('ignores non-boolean truthy values to avoid accidental enablement', () => {
      setProductConfig({ credentialAtRestSafe: 1 as unknown as boolean })
      expect(isCredentialAtRestSafe()).toBe(false)
    })

    it('is independent from other policy flags (orthogonal surfaces)', () => {
      setProductConfig({ remoteMcpSafe: true })
      expect(isCredentialAtRestSafe()).toBe(false)
      setProductConfig({ credentialAtRestSafe: true })
      expect(isRemoteMcpSafe()).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // Detection helpers
  // --------------------------------------------------------------------------

  describe('isMcpAppSpec', () => {
    it('matches spec where type === "mcp"', () => {
      expect(isMcpAppSpec({ type: 'mcp', name: 'x', mcp_server: { command: 'cmd' } })).toBe(true)
    })
    it('rejects automation/skill/extension specs', () => {
      expect(isMcpAppSpec({ type: 'automation' })).toBe(false)
      expect(isMcpAppSpec({ type: 'skill' })).toBe(false)
      expect(isMcpAppSpec({ type: 'extension' })).toBe(false)
    })
    it('rejects malformed inputs without throwing', () => {
      expect(isMcpAppSpec(null)).toBe(false)
      expect(isMcpAppSpec(undefined)).toBe(false)
      expect(isMcpAppSpec('mcp')).toBe(false)
      expect(isMcpAppSpec(42)).toBe(false)
      expect(isMcpAppSpec({})).toBe(false)
    })
  })

  describe('patchTouchesMcp', () => {
    it('matches a patch that sets type to mcp', () => {
      expect(patchTouchesMcp({ type: 'mcp' })).toBe(true)
    })
    it('matches a patch that includes mcp_server (even with null value, to catch deletions)', () => {
      expect(patchTouchesMcp({ mcp_server: { command: 'evil' } })).toBe(true)
      expect(patchTouchesMcp({ mcp_server: null })).toBe(true)
    })
    it('ignores patches that touch unrelated fields', () => {
      expect(patchTouchesMcp({ name: 'renamed' })).toBe(false)
      expect(patchTouchesMcp({ description: '...' })).toBe(false)
    })
    it('rejects malformed inputs without throwing', () => {
      expect(patchTouchesMcp(null)).toBe(false)
      expect(patchTouchesMcp('mcp_server')).toBe(false)
    })
  })

  describe('configTouchesMcp', () => {
    it('matches a config body that updates mcpServers map', () => {
      expect(configTouchesMcp({ mcpServers: { foo: { command: 'cmd' } } })).toBe(true)
      expect(configTouchesMcp({ mcpServers: {} })).toBe(true)
    })
    it('ignores unrelated config updates', () => {
      expect(configTouchesMcp({ remoteAccess: { enabled: true } })).toBe(false)
      expect(configTouchesMcp({})).toBe(false)
    })
  })

  describe('yamlIsMcpSpec', () => {
    it('detects MCP type in YAML', () => {
      expect(yamlIsMcpSpec('type: mcp\nname: foo\nmcp_server:\n  command: cmd')).toBe(true)
    })
    it('returns false for non-MCP YAML', () => {
      expect(yamlIsMcpSpec('type: automation\nname: foo')).toBe(false)
    })
    it('returns false for malformed YAML (controller surfaces the real error)', () => {
      expect(yamlIsMcpSpec(':::not-yaml:::\n  - [')).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // Sync rejection helper
  // --------------------------------------------------------------------------

  describe('rejectIfRemoteMcpForbidden', () => {
    it('returns false and never calls the predicate when policy is off', () => {
      setProductConfig(undefined)
      const res = makeRes()
      const predicate = vi.fn(() => true)
      const blocked = rejectIfRemoteMcpForbidden(res as never, predicate, 'TEST')
      expect(blocked).toBe(false)
      expect(predicate).not.toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('returns false when policy is on but payload does not touch MCP', () => {
      setProductConfig({ remoteMcpSafe: true })
      const res = makeRes()
      const blocked = rejectIfRemoteMcpForbidden(res as never, () => false, 'TEST')
      expect(blocked).toBe(false)
      expect(res.status).not.toHaveBeenCalled()
    })

    it('returns true and writes 403 with stable error code when blocked', () => {
      setProductConfig({ remoteMcpSafe: true })
      const res = makeRes()
      const blocked = rejectIfRemoteMcpForbidden(res as never, () => true, 'POST /api/apps/install')
      expect(blocked).toBe(true)
      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          code: MCP_REMOTE_INSTALL_FORBIDDEN,
        }),
      )
    })
  })

  // --------------------------------------------------------------------------
  // Async rejection helper (used by store install paths)
  // --------------------------------------------------------------------------

  describe('rejectIfRemoteMcpForbiddenAsync', () => {
    it('skips the async predicate when policy is off (zero-cost on open-source)', async () => {
      setProductConfig(undefined)
      const res = makeRes()
      const predicate = vi.fn(async () => true)
      const blocked = await rejectIfRemoteMcpForbiddenAsync(res as never, predicate, 'TEST')
      expect(blocked).toBe(false)
      expect(predicate).not.toHaveBeenCalled()
    })

    it('awaits the predicate and blocks when it resolves true', async () => {
      setProductConfig({ remoteMcpSafe: true })
      const res = makeRes()
      const blocked = await rejectIfRemoteMcpForbiddenAsync(
        res as never,
        async () => true,
        'POST /api/store/install',
      )
      expect(blocked).toBe(true)
      expect(res.status).toHaveBeenCalledWith(403)
    })

    it('lets the request proceed when the predicate resolves false', async () => {
      setProductConfig({ remoteMcpSafe: true })
      const res = makeRes()
      const blocked = await rejectIfRemoteMcpForbiddenAsync(
        res as never,
        async () => false,
        'POST /api/store/install',
      )
      expect(blocked).toBe(false)
      expect(res.status).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // MCP command blacklist
  // --------------------------------------------------------------------------

  describe('getMcpCommandBlacklist', () => {
    it('returns an empty array when product.json omits security (open-source default)', () => {
      setProductConfig(undefined)
      expect(getMcpCommandBlacklist()).toEqual([])
    })

    it('returns an empty array when mcpCommandBlacklist is absent', () => {
      setProductConfig({ remoteMcpSafe: true })
      expect(getMcpCommandBlacklist()).toEqual([])
    })

    it('returns an empty array when mcpCommandBlacklist is malformed (not an array)', () => {
      setProductConfig({ mcpCommandBlacklist: 'rm' as unknown as string[] })
      expect(getMcpCommandBlacklist()).toEqual([])
    })

    it('returns the configured list verbatim when present', () => {
      setProductConfig({ mcpCommandBlacklist: ['rm', 'sudo', 'cmd'] })
      expect(getMcpCommandBlacklist()).toEqual(['rm', 'sudo', 'cmd'])
    })
  })

  describe('isMcpCommandBlocked', () => {
    it('returns false when blacklist is empty (open-source default)', () => {
      setProductConfig(undefined)
      expect(isMcpCommandBlocked('rm')).toBe(false)
      expect(isMcpCommandBlocked('cmd.exe')).toBe(false)
    })

    it('matches by bare basename', () => {
      setProductConfig({ mcpCommandBlacklist: ['rm', 'sudo'] })
      expect(isMcpCommandBlocked('rm')).toBe(true)
      expect(isMcpCommandBlocked('sudo')).toBe(true)
      expect(isMcpCommandBlocked('ls')).toBe(false)
    })

    it('strips POSIX path prefix before matching (/usr/bin/rm)', () => {
      setProductConfig({ mcpCommandBlacklist: ['rm'] })
      expect(isMcpCommandBlocked('/usr/bin/rm')).toBe(true)
      expect(isMcpCommandBlocked('/bin/rm')).toBe(true)
      expect(isMcpCommandBlocked('/opt/local/bin/rm')).toBe(true)
    })

    it('strips Windows path prefix before matching', () => {
      setProductConfig({ mcpCommandBlacklist: ['cmd'] })
      expect(isMcpCommandBlocked('C:\\Windows\\System32\\cmd.exe')).toBe(true)
      expect(isMcpCommandBlocked('C:\\Windows\\System32\\CMD.EXE')).toBe(true)
    })

    it('strips Windows executable suffixes before matching (case-insensitive)', () => {
      // Single blacklist token `powershell` must match every common
      // Windows executable-entry extension so an admin doesn't have to
      // enumerate `.exe / .bat / .cmd / .ps1 / .com`.
      setProductConfig({ mcpCommandBlacklist: ['powershell'] })
      expect(isMcpCommandBlocked('powershell.exe')).toBe(true)
      expect(isMcpCommandBlocked('PowerShell.EXE')).toBe(true)
      expect(isMcpCommandBlocked('powershell.bat')).toBe(true)
      expect(isMcpCommandBlocked('powershell.cmd')).toBe(true)
      expect(isMcpCommandBlocked('powershell.ps1')).toBe(true)
      expect(isMcpCommandBlocked('powershell.COM')).toBe(true)
      expect(isMcpCommandBlocked('powershell')).toBe(true)
    })

    it('does not strip unrelated suffixes (e.g. .sh, .py)', () => {
      // Unix shebang entries and language launchers are NOT stripped —
      // those program names are typically the literal blacklist entry.
      setProductConfig({ mcpCommandBlacklist: ['attack'] })
      expect(isMcpCommandBlocked('attack.sh')).toBe(false)
      expect(isMcpCommandBlocked('attack.py')).toBe(false)
      // To block these, admin lists the full filename:
      setProductConfig({ mcpCommandBlacklist: ['attack.sh'] })
      expect(isMcpCommandBlocked('attack.sh')).toBe(true)
    })

    it('is case-insensitive on both sides of the comparison', () => {
      setProductConfig({ mcpCommandBlacklist: ['RM', 'Sudo'] })
      expect(isMcpCommandBlocked('rm')).toBe(true)
      expect(isMcpCommandBlocked('SUDO')).toBe(true)
      expect(isMcpCommandBlocked('SuDo')).toBe(true)
    })

    it('does not match substrings (rm-rf would not match rm)', () => {
      setProductConfig({ mcpCommandBlacklist: ['rm'] })
      expect(isMcpCommandBlocked('rm-rf')).toBe(false)
      expect(isMcpCommandBlocked('rmdir')).toBe(false)
      expect(isMcpCommandBlocked('arm')).toBe(false)
    })

    it('returns false for empty/non-string inputs without throwing', () => {
      setProductConfig({ mcpCommandBlacklist: ['rm'] })
      expect(isMcpCommandBlocked('')).toBe(false)
      expect(isMcpCommandBlocked(undefined as unknown as string)).toBe(false)
      expect(isMcpCommandBlocked(null as unknown as string)).toBe(false)
      expect(isMcpCommandBlocked(42 as unknown as string)).toBe(false)
    })

    it('returns false when the path resolves to an empty basename', () => {
      setProductConfig({ mcpCommandBlacklist: ['rm'] })
      // Trailing slash → basename is empty after split-pop
      expect(isMcpCommandBlocked('/usr/bin/')).toBe(false)
    })

    it('ignores non-string entries in the blacklist (defensive)', () => {
      setProductConfig({ mcpCommandBlacklist: ['rm', 42 as unknown as string, null as unknown as string, 'sudo'] })
      expect(isMcpCommandBlocked('rm')).toBe(true)
      expect(isMcpCommandBlocked('sudo')).toBe(true)
    })

    it('exposes the stable error code and message constants', () => {
      // These constants are part of the public contract — clients match
      // on code, transport layers render the message.
      expect(MCP_COMMAND_BLOCKED).toBe('MCP_COMMAND_BLOCKED')
      expect(typeof MCP_COMMAND_BLOCKED_MESSAGE).toBe('string')
      expect(MCP_COMMAND_BLOCKED_MESSAGE.length).toBeGreaterThan(0)
    })
  })
})
