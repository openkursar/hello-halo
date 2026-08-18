/**
 * Capability policy — the single contract for "which tools may an agent turn use"
 * when the turn is driven by someone other than the app's owner.
 *
 * Two scenarios share this shape, and must keep sharing it:
 *   - an IM guest talking to a digital human (`GuestPolicy`),
 *   - a teammate waking a digital human inside a team (`TeamDelegatedPolicy`).
 *
 * Renderer-safe: pure data + pure functions, no Node/Electron imports. The
 * renderer drives its switches from the same tables the main process enforces
 * with, so the UI can never offer a switch that does nothing.
 */

// ── Policy shape ──

/**
 * White-list model: only explicitly listed tools are allowed.
 * `allowedTools` undefined = no built-in restriction; `[]` = no built-in tools.
 *
 * At runtime the list is split by kind: built-in tool names drive the SDK's
 * `disallowedTools` (inverted whitelist), the boolean flags drive MCP-server
 * injection, and `allowedUserMcp` whitelists user-installed MCP servers.
 */
export interface CapabilityPolicy {
  /** Built-in tool names this caller may use. undefined = unrestricted. */
  allowedTools?: string[]

  // ── Halo MCP injection control ──
  allowAiBrowser?: boolean
  allowEmail?: boolean
  allowNotify?: boolean
  allowApps?: boolean
  allowFileSend?: boolean
  /** On-device OCR reads arbitrary local paths, so it is gated like the rest. */
  allowOcr?: boolean
  /**
   * Interactive terminals. A second way to run commands on the owner's machine,
   * so it belongs to the same decision as the built-in command tool — withholding
   * one while granting the other leaves the owner believing they closed a door
   * that is still open.
   */
  allowTerminal?: boolean

  /** User-installed MCP server ids (specId) this caller may use. */
  allowedUserMcp?: string[]
}

/** The boolean capability keys, so callers can iterate them exhaustively. */
export type CapabilityToggleKey =
  | 'allowAiBrowser'
  | 'allowEmail'
  | 'allowNotify'
  | 'allowApps'
  | 'allowFileSend'
  | 'allowOcr'
  | 'allowTerminal'

// ── Built-in tool universe ──

/**
 * Every SDK built-in tool name. The enforcement path inverts a whitelist against
 * this list, so a tool missing here would be silently granted. Keep it in sync
 * when upgrading the Claude Code SDK.
 *
 * The SDK `tools` option (API-level whitelist) is non-functional; `disallowedTools`
 * is the only mechanism that removes a tool from the model's pool.
 */
export const ALL_BUILTIN_TOOLS: readonly string[] = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'Skill',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
]

/** Grouping of the built-in tools a policy screen lets a user switch. */
export type CapabilityToolGroup = 'file' | 'network' | 'other' | 'advanced'

/** The built-in tools a policy screen exposes, in display order. */
export const DELEGABLE_BUILTIN_TOOLS: readonly { name: string; group: CapabilityToolGroup }[] = [
  { name: 'Read', group: 'file' },
  { name: 'Glob', group: 'file' },
  { name: 'Grep', group: 'file' },
  { name: 'WebFetch', group: 'network' },
  { name: 'WebSearch', group: 'network' },
  { name: 'Agent', group: 'other' },
  { name: 'TodoWrite', group: 'other' },
  { name: 'Bash', group: 'advanced' },
  { name: 'Write', group: 'advanced' },
  { name: 'Edit', group: 'advanced' },
  { name: 'NotebookEdit', group: 'advanced' },
]

/** Group order for rendering. Labels are supplied by the screen (they differ per scenario). */
export const CAPABILITY_TOOL_GROUPS: readonly CapabilityToolGroup[] = ['file', 'network', 'other', 'advanced']

// ── MCP server universe ──

/** Halo MCP servers always available: read-only, no side effects, no local reach. */
export const CAPABILITY_SAFE_MCP: readonly string[] = ['web-search', 'halo-memory']

/**
 * Halo MCP servers gated by a policy toggle, in display order.
 *
 * `followsBuiltin` names the built-in tool a capability inherits from when its
 * own switch was never touched — for a capability that is a second door into the
 * same room, so withholding the first door withholds both. Inheriting only ever
 * *grants*, so it applies solely where silence already means yes; where the rule
 * is "nothing unless stated", nothing is inherited either.
 */
export const CAPABILITY_MCP_TOGGLES: readonly {
  server: string
  key: CapabilityToggleKey
  label: string
  followsBuiltin?: string
}[] = [
  { server: 'ai-browser', key: 'allowAiBrowser', label: 'AI Browser' },
  { server: 'halo-email', key: 'allowEmail', label: 'Email' },
  { server: 'halo-notify', key: 'allowNotify', label: 'Notifications' },
  { server: 'halo-apps', key: 'allowApps', label: 'Digital Humans' },
  { server: 'im-file-send', key: 'allowFileSend', label: 'File Send' },
  { server: 'ocr', key: 'allowOcr', label: 'Text Extraction (OCR)' },
  // A terminal is a second way onto the owner's machine, so it follows the
  // command tool: withholding commands withholds it too.
  { server: 'ai-terminal', key: 'allowTerminal', label: 'Terminal', followsBuiltin: 'Bash' },
]

const CAPABILITY_FOLLOWS_BUILTIN: ReadonlyMap<CapabilityToggleKey, string> = new Map(
  CAPABILITY_MCP_TOGGLES.flatMap((t) => (t.followsBuiltin ? [[t.key, t.followsBuiltin] as const] : []))
)

// ── Enforcement mode ──

/**
 * How an unstated permission is read:
 *   'strict'     — nothing is granted unless the policy says so. An IM guest is
 *                  a stranger, so silence means no.
 *   'permissive' — everything is granted unless the policy withholds it. A
 *                  teammate is invited into the team by the owner, so silence
 *                  means yes and the switches only ever take capabilities away.
 */
export type CapabilityMode = 'strict' | 'permissive'

// ── Derivations shared by enforcement and UI ──

/**
 * Built-in tool names to remove from the model's pool for this turn.
 *
 * In 'permissive' mode only the tools a policy screen actually exposes
 * ({@link DELEGABLE_BUILTIN_TOOLS}) can be withheld, so an all-on policy is
 * byte-identical to having no policy at all.
 */
export function computeDisallowedBuiltins(
  policy: CapabilityPolicy | undefined,
  mode: CapabilityMode
): string[] {
  const universe = mode === 'strict' ? ALL_BUILTIN_TOOLS : DELEGABLE_BUILTIN_TOOLS.map((t) => t.name)
  return universe.filter((name) => !allowsBuiltin(policy, name, mode))
}

/** Whether a built-in tool is granted under this policy. */
export function allowsBuiltin(
  policy: CapabilityPolicy | undefined,
  name: string,
  mode: CapabilityMode
): boolean {
  const listed = policy?.allowedTools
  if (listed === undefined) return mode === 'permissive'
  return listed.includes(name)
}

/** Whether a gated Halo capability is granted under this policy. */
export function allowsCapability(
  policy: CapabilityPolicy | undefined,
  key: CapabilityToggleKey,
  mode: CapabilityMode
): boolean {
  const value = policy?.[key]
  if (typeof value === 'boolean') return value
  // Silence means no, and stays meaning no: inheriting from another switch here
  // would hand a stranger a capability whose switch the owner was never shown.
  if (mode !== 'permissive') return false
  // Silence means yes, so the only question is whether a related switch was
  // turned OFF — see `followsBuiltin` on the toggle table.
  const follows = CAPABILITY_FOLLOWS_BUILTIN.get(key)
  return follows ? allowsBuiltin(policy, follows, mode) : true
}

/** Whether a user-installed MCP server is granted under this policy. */
export function allowsUserMcp(
  policy: CapabilityPolicy | undefined,
  specId: string,
  mode: CapabilityMode
): boolean {
  const listed = policy?.allowedUserMcp
  if (listed === undefined) return mode === 'permissive'
  return listed.includes(specId)
}

/** A policy that explicitly grants everything a policy screen can grant. */
export function fullCapabilityPolicy(): CapabilityPolicy {
  return {
    allowedTools: DELEGABLE_BUILTIN_TOOLS.map((t) => t.name),
    allowAiBrowser: true,
    allowEmail: true,
    allowNotify: true,
    allowApps: true,
    allowFileSend: true,
    allowOcr: true,
    allowTerminal: true,
  }
}
