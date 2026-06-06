/**
 * Security Policy — centralized, build-time-gated security toggles sourced
 * from product.json.
 *
 * Naming convention: every flag is `<surface>Safe: boolean`.
 *   - `true`  → safe mode ON, restrictions enforced
 *   - omitted / `false` → permissive default (open-source friendly)
 *
 * The flags exist so an enterprise product.json variant can harden specific
 * attack surfaces without forking the codebase. Open-source builds that omit
 * the `security` block keep every default behavior intact.
 *
 * Adding a new policy flag:
 *   1. Extend `SecurityPolicy` below
 *   2. Add a matching property under `security` in product.schema.json
 *   3. Export a typed predicate (e.g. `isXxxSafe()`)
 *   4. Wire the predicate at the protected surface, ideally via a small
 *      `rejectIfXxxForbidden()` helper that owns the response shape so
 *      consumers stay one-liners.
 */
import type { Response } from 'express'
import { parse as parseYaml } from 'yaml'

import { loadProductConfig } from '../foundation/product-config'

// `credentialAtRestSafe` is consumed by the foundation-tier at-rest crypto
// primitive (`crypto-envelope.ts`), so its predicate lives in foundation.
// Re-exported here to keep this module's documented policy surface complete.
export { isCredentialAtRestSafe } from '../foundation/credential-safety'

// ============================================================================
// Policy shape
// ============================================================================

export interface SecurityPolicy {
  /**
   * When true, every remote HTTP entry point that could land an MCP server
   * configuration returns 403. Covers:
   *   - POST /api/apps/install (AppSpec where type === 'mcp')
   *   - POST /api/apps/import-spec (YAML AppSpec where type === 'mcp')
   *   - PATCH /api/apps/:appId/spec (patch touches mcp_server OR target
   *     app is already type === 'mcp')
   *   - POST /api/config (body touches mcpServers map)
   *   - POST /api/store/install + POST /api/store/apps/:slug/install
   *     (resolved store spec is type === 'mcp')
   *
   * Local IPC install paths are unaffected — users can still add MCP
   * servers from the desktop UI where they can review the command before
   * it lands.
   *
   * Rationale: stdio MCP servers spawn arbitrary native processes with
   * the user's privileges. A remote caller cannot review the command and
   * cannot be shown a confirmation dialog, so the only safe posture for
   * a managed enterprise deployment is to require a local-UI install.
   */
  remoteMcpSafe?: boolean

  /**
   * Encrypts the persisted remote-access credential at rest with
   * SM4-CBC + HMAC-SM3 (encrypt-then-MAC; GM/T 0002 + GM/T 0091) under a
   * machine-bound KEK. Off by default — open-source builds store the
   * credential as plain text exactly as before. The plaintext is held in
   * memory in both modes so the UI can keep displaying the current PIN
   * and validation runs `crypto.timingSafeEqual` against the in-memory
   * value.
   */
  credentialAtRestSafe?: boolean

  /**
   * When true, the Cloudflare Quick Tunnel feature is disabled at every
   * layer:
   *   - Service: `startTunnel()` short-circuits and never spawns
   *     `cloudflared`.
   *   - IPC: `remote:tunnel:enable` / `remote:tunnel:disable` reject
   *     before touching the service.
   *   - UI: the "Internet Access" subsection in Remote Access settings
   *     and the Cloudflared row in System Diagnostics do not render.
   *
   * Rationale: a managed enterprise deployment may forbid outbound HTTPS
   * tunnels that expose the workstation's HTTP server to the public
   * internet without going through the corporate proxy / IdP.
   *
   * Consumers live under `src/main/services/tunnel.service.ts`,
   * `src/main/services/remote.service.ts`, `src/main/ipc/remote.ts`, and
   * the renderer hook `useSecurityPolicy`.
   */
  tunnelSafe?: boolean

  /**
   * Command-level blacklist for stdio-transport MCP servers. Each entry is
   * matched against the `mcp_server.command` basename with case-insensitive
   * comparison after stripping the dirname and any executable suffix in
   * `.exe`, `.com`, `.bat`, `.cmd`, `.ps1` — so a single entry `cmd` blocks
   * `cmd.exe`, `cmd.bat`, and `cmd.cmd` alike. A match rejects the install
   * (`AppManager.install()` throws `McpCommandBlockedError`) and is skipped
   * at runtime (`getDbMcpServers()` drops the entry before it reaches the
   * SDK).
   *
   * Only stdio MCP servers are affected — sse / streamable-http transports
   * have no `command` field and connect to remote URLs, so they fall under
   * other policies (e.g. browser allowlist / `remoteMcpSafe`).
   *
   * Rationale: stdio MCP servers spawn native processes with the user's
   * privileges. A managed enterprise deployment can pre-declare which
   * program names are categorically forbidden (shells, package managers,
   * destructive disk tools, attack frameworks, etc.) without depending on
   * users to review every install dialog.
   *
   * Open-source default: omitted/empty → no enforcement at any layer.
   * Every consumer short-circuits on `length === 0`, so omitted-policy
   * builds pay no measurable cost.
   */
  mcpCommandBlacklist?: string[]
}

/**
 * Subset of {@link SecurityPolicy} that is safe to expose to the renderer
 * process. The renderer needs policy flags to gate UI surfaces, but it
 * MUST NOT receive anything that leaks deployment topology or secrets.
 *
 * Every field is a plain boolean and the shape is closed (no
 * passthrough). Adding a field here is an explicit decision — see
 * `getPublicSecurityPolicy()`.
 */
export interface PublicSecurityPolicy {
  tunnelSafe: boolean
}

// ============================================================================
// Policy accessors
// ============================================================================

export function getSecurityPolicy(): SecurityPolicy {
  // ProductConfig.security is typed as Record<string, unknown> to keep the
  // auth-loader free of a circular import. Re-narrow at the boundary here
  // so every consumer sees a typed SecurityPolicy.
  return (loadProductConfig().security ?? {}) as SecurityPolicy
}

export function isRemoteMcpSafe(): boolean {
  return getSecurityPolicy().remoteMcpSafe === true
}

/**
 * True only when `tunnelSafe` is explicitly set to boolean true.
 *
 * Any non-boolean truthy value is treated as false to prevent accidental
 * enablement via config typos (matches the convention used by every
 * other `<surface>Safe` predicate).
 */
export function isTunnelSafe(): boolean {
  return getSecurityPolicy().tunnelSafe === true
}

/**
 * Return the configured MCP-command blacklist, or an empty frozen array
 * when the policy is absent / malformed. Callers should treat an empty
 * result as "no enforcement" — never as "match everything".
 *
 * The returned reference is read-only at the type level. Callers MUST NOT
 * cast it back to `string[]` and mutate it — doing so would corrupt the
 * shared policy snapshot held by `loadProductConfig()`. The array is read
 * frequently (every install + every session warmup) and the policy itself
 * is immutable for the lifetime of the process, so we deliberately avoid
 * cloning on every access.
 */
export function getMcpCommandBlacklist(): readonly string[] {
  const list = getSecurityPolicy().mcpCommandBlacklist
  if (!Array.isArray(list) || list.length === 0) return EMPTY_BLACKLIST
  return list
}

/** Shared frozen empty array so the no-policy path allocates nothing. */
const EMPTY_BLACKLIST: readonly string[] = Object.freeze([])

/**
 * Set of Windows executable-entry suffixes stripped before comparison.
 * Mirrors the common executable extensions a stdio MCP server might point
 * at on Windows: native PE binaries (`.exe`, `.com`), batch wrappers
 * (`.bat`, `.cmd`), and PowerShell entry points (`.ps1`). An admin who
 * blacklists `cmd` will block `cmd.exe`, `cmd.bat`, and `cmd.cmd` alike.
 *
 * Extending this set is a security decision — every entry widens the
 * surface a single blacklist token covers. Add new suffixes only after
 * confirming they are interpreted as executable entry points by the
 * Windows process launcher, not by an explicit shell.
 */
const EXECUTABLE_SUFFIXES = /\.(?:exe|com|bat|cmd|ps1)$/i

/**
 * Returns true when `command` matches any entry in
 * `security.mcpCommandBlacklist`. The comparison strips the dirname and
 * any {@link EXECUTABLE_SUFFIXES} match, then compares case-insensitively,
 * so `/usr/bin/rm`, `C:\\Windows\\System32\\cmd.exe`, `cmd.bat`, and
 * `CMD.EXE` all collapse to the lowercase basename `cmd` before matching.
 *
 * Returns false when:
 *   - the blacklist is unset / empty (open-source default)
 *   - `command` is empty / not a string (defensive)
 *
 * Args strings are NOT inspected — the contract is "block by program
 * name". Refining further (e.g. blocking only `rm -rf /`) belongs in a
 * separate policy because shell argument parsing is too brittle to be
 * security-grade.
 */
export function isMcpCommandBlocked(command: string): boolean {
  const blacklist = getMcpCommandBlacklist()
  if (blacklist.length === 0) return false
  if (typeof command !== 'string' || command.length === 0) return false
  const basename = command.split(/[/\\]/).pop() ?? ''
  if (basename.length === 0) return false
  const normalized = basename.replace(EXECUTABLE_SUFFIXES, '').toLowerCase()
  for (const entry of blacklist) {
    if (typeof entry === 'string' && entry.toLowerCase() === normalized) {
      return true
    }
  }
  return false
}

/**
 * Build the renderer-safe slice of the security policy.
 *
 * Keep this function as the single point of truth for what the renderer
 * is allowed to see — if a new field is added to {@link SecurityPolicy}
 * but not to {@link PublicSecurityPolicy} it stays main-process only.
 */
export function getPublicSecurityPolicy(): PublicSecurityPolicy {
  return {
    tunnelSafe: isTunnelSafe(),
  }
}

// ============================================================================
// MCP detection helpers
// ============================================================================

/**
 * Returns true when the value looks like an AppSpec for type=mcp.
 * Used by /api/apps/install before forwarding to the manager.
 */
export function isMcpAppSpec(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'mcp'
  )
}

/**
 * Returns true when a JSON Merge Patch body touches MCP-specific fields.
 * Used by PATCH /api/apps/:appId/spec to detect attempts to (re)write
 * mcp_server.command/args/env/cwd.
 */
export function patchTouchesMcp(patch: unknown): boolean {
  if (typeof patch !== 'object' || patch === null) return false
  const p = patch as Record<string, unknown>
  return p.type === 'mcp' || 'mcp_server' in p
}

/**
 * Returns true when a config-update body touches the legacy `mcpServers`
 * map (Cursor / Claude Desktop compatible format stored in config.json).
 * Used by POST /api/config — that endpoint can land MCP server entries
 * outside the App spec system.
 */
export function configTouchesMcp(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  return 'mcpServers' in (body as Record<string, unknown>)
}

/**
 * Best-effort YAML peek used by POST /api/apps/import-spec. Returns true
 * when the parsed document is an AppSpec for type=mcp. Returns false on
 * any parse error — let the controller surface the real INVALID_YAML
 * status, this helper exists only to short-circuit MCP installs.
 */
export function yamlIsMcpSpec(yamlContent: string): boolean {
  try {
    return isMcpAppSpec(parseYaml(yamlContent))
  } catch {
    return false
  }
}

// ============================================================================
// Enforcement helper
// ============================================================================

/** Stable error code so clients can render a localized message. */
export const MCP_REMOTE_INSTALL_FORBIDDEN = 'MCP_REMOTE_INSTALL_FORBIDDEN'

const MCP_REMOTE_INSTALL_FORBIDDEN_MESSAGE =
  'Remote MCP configuration is disabled by security policy. Install MCP servers from the local Halo app.'

function writeMcpForbiddenResponse(res: Response, surface: string): void {
  console.warn(`[SecurityPolicy] Blocked remote MCP write at ${surface} (remoteMcpSafe=true)`)
  res.status(403).json({
    success: false,
    error: MCP_REMOTE_INSTALL_FORBIDDEN_MESSAGE,
    code: MCP_REMOTE_INSTALL_FORBIDDEN,
  })
}

/**
 * Reject the request with 403 when remote-MCP-safe mode is on AND the
 * given predicate confirms the payload touches MCP. Returns true when the
 * request was rejected (caller MUST return immediately). Returns false
 * when the caller may proceed.
 *
 * The predicate is invoked lazily so that the (default) permissive build
 * pays zero cost — no peeking, no parsing — when the flag is off.
 */
export function rejectIfRemoteMcpForbidden(
  res: Response,
  touchesMcp: () => boolean,
  surface: string,
): boolean {
  if (!isRemoteMcpSafe()) return false
  if (!touchesMcp()) return false
  writeMcpForbiddenResponse(res, surface)
  return true
}

/**
 * Async variant for callers that need an awaited lookup (e.g. fetching a
 * store entry's spec) to know whether the payload touches MCP. Same lazy
 * semantics: the resolver is only called when remoteMcpSafe is on.
 */
export async function rejectIfRemoteMcpForbiddenAsync(
  res: Response,
  touchesMcp: () => Promise<boolean>,
  surface: string,
): Promise<boolean> {
  if (!isRemoteMcpSafe()) return false
  if (!(await touchesMcp())) return false
  writeMcpForbiddenResponse(res, surface)
  return true
}

// ============================================================================
// Tunnel policy
// ============================================================================

/**
 * Stable error code returned at every tunnel layer (service / IPC) when
 * the tunnel feature is disabled by `security.tunnelSafe`. Clients can
 * match on this code to render a localized hint without depending on the
 * English message string.
 */
export const TUNNEL_DISABLED_BY_POLICY = 'TUNNEL_DISABLED_BY_POLICY'

/** Human-readable message paired with {@link TUNNEL_DISABLED_BY_POLICY}. */
export const TUNNEL_DISABLED_BY_POLICY_MESSAGE =
  'Cloudflare Tunnel is disabled by security policy in this build.'

// ============================================================================
// MCP command blacklist policy
// ============================================================================

/**
 * Stable error code returned at the HTTP / IPC boundary when an MCP install
 * is rejected because its `command` matches `security.mcpCommandBlacklist`.
 * Clients can match on this code to render a localized hint without
 * depending on the English message string.
 */
export const MCP_COMMAND_BLOCKED = 'MCP_COMMAND_BLOCKED'

/** Human-readable message paired with {@link MCP_COMMAND_BLOCKED}. */
export const MCP_COMMAND_BLOCKED_MESSAGE =
  'This MCP server command is blocked by security policy.'
