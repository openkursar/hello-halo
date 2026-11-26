/**
 * Applying a capability policy to a digital-human turn.
 *
 * Two callers drive a digital human that is not its owner — an IM guest, and a
 * request from outside reaching a team member — and both must be held to the
 * same, single set of rules. This module is where those rules turn into SDK
 * options, so the two paths can never quietly drift apart.
 *
 * The vocabulary (which tools exist, which capabilities can be switched, what an
 * unstated permission means) lives in `shared/apps/capability-policy`, shared
 * with the screens that offer the switches.
 */

import {
  allowsBuiltin,
  allowsCapability,
  allowsUserMcp,
  buildAllowedToolRules,
  computeDisallowedBuiltins,
  isRestrictivePolicy,
  resolveBashAccess,
  CAPABILITY_MCP_TOGGLES,
  CAPABILITY_SAFE_MCP,
  DELEGABLE_BUILTIN_TOOLS,
  SKILL_TOOL,
} from '../../../shared/apps/capability-policy'
import type { CapabilityMode, CapabilityPolicy } from '../../../shared/apps/capability-policy'
import type { TeamTriggerContext } from '../../../shared/apps/team-types'
import { FILE_TOOLS, READ_FILE_TOOLS } from './turn-file-access'
import type { TurnSkillAccess } from './turn-skills'

export { computeDisallowedBuiltins }

/**
 * Whether this team turn serves someone OTHER than the owner — the only turns a
 * member's delegated policy holds. Read from this turn's own trigger: the owner,
 * their digital humans on this machine and the runtime waking one of them are
 * the owner's own, whatever came before.
 *
 * In a chat a member fronts over IM, the person's own message answers to that
 * channel's owner/guest rules instead.
 */
export function isBorrowedTeamTurn(
  trigger: Pick<TeamTriggerContext, 'kind' | 'origin'>,
  overImChannel: boolean
): boolean {
  if (!trigger.origin) return false
  return !(overImChannel && trigger.kind === 'human_message')
}

const SAFE_MCP = new Set(CAPABILITY_SAFE_MCP)
const TOGGLE_BY_SERVER = new Map(CAPABILITY_MCP_TOGGLES.map((t) => [t.server, t.key]))

/**
 * The MCP servers this turn may see. A server that is not injected does not
 * exist for the model — no refusal to argue with, no tool to talk it into.
 *
 * `alwaysKeep` covers servers that are not a capability at all but the channel
 * the turn happens on (the team's own coordination tools): withholding those
 * would not restrict the caller, it would isolate the digital human.
 */
export function filterMcpServersByPolicy(
  allMcpServers: Record<string, unknown>,
  dbMcpServers: Record<string, unknown> | null,
  policy: CapabilityPolicy | undefined,
  mode: CapabilityMode,
  alwaysKeep?: ReadonlySet<string>
): Record<string, any> {
  const result: Record<string, any> = {}

  for (const [name, server] of Object.entries(allMcpServers)) {
    if (alwaysKeep?.has(name)) {
      result[name] = server
      continue
    }
    if (dbMcpServers && name in dbMcpServers) {
      if (allowsUserMcp(policy, name, mode)) result[name] = server
      continue
    }
    if (SAFE_MCP.has(name)) {
      result[name] = server
      continue
    }
    const toggle = TOGGLE_BY_SERVER.get(name)
    if (toggle) {
      if (allowsCapability(policy, toggle, mode)) result[name] = server
      continue
    }
    // A server nobody has classified yet stays out in BOTH modes. The tables
    // above are what an owner is shown, so an unlisted server is a capability
    // they were never offered a switch for — granting it by default means every
    // new server silently widens what a caller can already do (that is how the
    // interactive terminal stayed reachable after its owner withheld commands).
    // Adding a server to `CAPABILITY_MCP_TOGGLES` is what makes it grantable.
  }

  return result
}

// ── Turning a policy into SDK options ──

export interface ApplyCapabilityPolicyInput {
  policy: CapabilityPolicy | undefined
  mode: CapabilityMode
  /** Everything the turn assembled, before the policy narrows it. */
  mcpServers: Record<string, unknown>
  /** User-installed MCP servers, so they are told apart from Halo's own. */
  dbMcpServers: Record<string, unknown> | null
  /** Servers that are the turn's channel rather than a capability. */
  alwaysKeep?: ReadonlySet<string>
  /**
   * Keep the file tools in the pool even when the policy withholds them. The
   * turn's file boundary (turn-file-access) then admits a withheld tool only
   * on memory and on files handed to the turn: a digital human cannot work
   * without its memory, whoever it is working for.
   */
  keepFileTools?: boolean
}

export interface AppliedCapabilityPolicy {
  /** False when the policy withholds nothing — the turn was left untouched. */
  enforced: boolean
  disallowedTools: string[]
  mcpServers: Record<string, any>
}

/**
 * Narrow a turn's SDK options to what the policy grants. The single place both
 * the IM-guest and the teammate path pass through.
 *
 * Three layers, because none holds alone: `disallowedTools` removes withheld
 * built-ins from the model's pool, MCP injection decides the rest (an
 * uninjected server does not exist for the turn), and `allowedTools` lists what
 * runs without asking — everything else reaches the per-call gate, which
 * refuses. That last layer is what command rules ride on, and why the engine
 * rather than Halo evaluates them.
 *
 * A policy only ever adds to `disallowedTools`: a tool the user disabled
 * globally is out of the model's pool for a guest or teammate too.
 *
 * A policy that withholds nothing returns `enforced: false` and changes no
 * option, so an unrestricted turn keeps the engine's fast path exactly as it was.
 */
export function applyCapabilityPolicy(
  sdkOptions: Record<string, any>,
  input: ApplyCapabilityPolicyInput
): AppliedCapabilityPolicy {
  const { policy, mode, mcpServers, dbMcpServers, alwaysKeep, keepFileTools } = input

  if (!isRestrictivePolicy(policy, mode)) {
    return { enforced: false, disallowedTools: [], mcpServers: mcpServers as Record<string, any> }
  }

  const disallowedTools = computeDisallowedBuiltins(policy, mode)
    .filter(name => !(keepFileTools && FILE_TOOLS.includes(name)))
  const filtered = filterMcpServersByPolicy(mcpServers, dbMcpServers, policy, mode, alwaysKeep)

  // Added to what the session already withholds (the user's disabled tools, the
  // native team tools): a policy narrows a turn, it never re-opens a tool.
  sdkOptions.disallowedTools = [...new Set([...(sdkOptions.disallowedTools ?? []), ...disallowedTools])]
  sdkOptions.allowedTools = buildAllowedToolRules(policy, mode)
  sdkOptions.mcpServers = filtered
  // A withheld manual must not leave an administrator credential reachable through Bash.
  if (!filtered['halo-api-ref'] && sdkOptions.env) {
    delete sdkOptions.env.HALO_API_URL
    delete sdkOptions.env.HALO_API_TOKEN
    delete sdkOptions.env.HALO_SPACE_ID
  }
  // Both must go: the flag and the mode each bypass the permission engine on
  // their own, and the engine is what evaluates the command rules.
  if (sdkOptions.extraArgs) delete sdkOptions.extraArgs['dangerously-skip-permissions']
  sdkOptions.permissionMode = 'default'

  return { enforced: true, disallowedTools, mcpServers: filtered }
}

const BUILTIN_DESCRIPTIONS: Readonly<Record<string, string>> = {
  Read: 'reading files',
  Glob: 'finding files by name',
  Grep: 'searching file contents',
  Write: 'creating files',
  Edit: 'editing files',
  NotebookEdit: 'editing notebooks',
  WebFetch: 'opening web pages',
  WebSearch: 'searching the web',
  Agent: 'sub-agents',
}

export interface WithheldInput {
  policy: CapabilityPolicy | undefined
  mode: CapabilityMode
  applied: AppliedCapabilityPolicy
  /** The servers the turn had before the policy narrowed it. */
  offered: Record<string, unknown>
  dbMcpServers: Record<string, unknown> | null
  /** The skills of the turn, when the policy grants any. */
  skills?: TurnSkillAccess
  /** The turn's file tools are held to its file boundary (turn-file-access). */
  fileBoundary: boolean
}

/**
 * What a restricted turn cannot use, one item per thing, in the words a
 * settings screen uses — so the digital human can tell whoever asked exactly
 * what is off. Read from what this turn actually lost: a capability the digital
 * human never had is not listed as switched off.
 */
export function describeWithheld(input: WithheldInput): string[] {
  const { policy, mode, applied, offered, dbMcpServers, skills, fileBoundary } = input
  const items: string[] = []

  const bash = resolveBashAccess(policy, mode)
  if (bash.scope === 'none') items.push('running commands')
  else if (bash.scope === 'listed') {
    items.push(bash.rules.length > 0
      ? `running commands other than ${bash.rules.map((rule) => `"${rule}"`).join(', ')}`
      : 'running commands')
  }
  if (bash.scope !== 'none' && applied.disallowedTools.includes('TaskOutput')) {
    items.push('reading the output of a command left running in the background (run commands in the foreground)')
  }

  const fileTools = new Set(FILE_TOOLS)
  for (const { name } of DELEGABLE_BUILTIN_TOOLS) {
    if (name === 'Bash' || allowsBuiltin(policy, name, mode)) continue
    const description = BUILTIN_DESCRIPTIONS[name] ?? name
    items.push(fileBoundary && fileTools.has(name)
      ? `${description}, except your memory${READ_FILE_TOOLS.includes(name) ? ' and the files handed to you' : ''}`
      : description)
  }
  if (fileBoundary && FILE_TOOLS.some((name) => allowsBuiltin(policy, name, mode))) {
    items.push('files outside this workspace')
  }

  if (!allowsBuiltin(policy, SKILL_TOOL, mode)) {
    items.push('skills')
  } else if (skills) {
    const usable = skills.skills.filter((skill) => skill.granted && !skill.refusal).map((skill) => skill.dirName)
    if (usable.length < skills.skills.length) {
      items.push(usable.length > 0 ? `skills other than ${[...new Set(usable)].join(', ')}` : 'skills')
    }
  }

  for (const toggle of CAPABILITY_MCP_TOGGLES) {
    if (toggle.server in offered && !(toggle.server in applied.mcpServers)) items.push(toggle.label)
  }
  for (const name of Object.keys(dbMcpServers ?? {})) {
    if (name in offered && !(name in applied.mcpServers)) items.push(`the installed tool "${name}"`)
  }
  return items
}

/** One line for the log: what this turn was narrowed to. */
export function describeAppliedPolicy(
  applied: AppliedCapabilityPolicy,
  policy: CapabilityPolicy | undefined,
  mode: CapabilityMode
): string {
  if (!applied.enforced) return 'unrestricted'
  const bash = resolveBashAccess(policy, mode)
  const commands = bash.scope === 'listed' ? `commands=${bash.rules.length} rules` : `commands=${bash.scope}`
  return (
    `mode=${mode}, ${commands}, withheld=${applied.disallowedTools.length} tools, ` +
    `mcpServers=[${Object.keys(applied.mcpServers).join(', ')}]`
  )
}
