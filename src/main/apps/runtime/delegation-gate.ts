/**
 * The per-call gate on a borrowed turn — the one place a tool call is refused,
 * and the one place the owner's record of it is written.
 *
 * Session-level options settle what EXISTS for a caller, once, when the engine
 * session is built. This settles whether a particular call goes ahead, read from
 * what the turn running RIGHT NOW registered — because a session outlives its
 * turn and its driver changes (the owner types into a conversation a teammate
 * woke), so a decision baked in at creation is about the wrong caller.
 *
 * It defaults to refusing. The engine calls it only for a call its own rules did
 * not auto-allow, and under a policy "not listed" is the whole answer.
 */

import { randomUUID } from 'node:crypto'
import {
  allowsBuiltinAtCallTime,
  resolveBashAccess,
} from '../../../shared/apps/capability-policy'
import type { CapabilityMode, CapabilityPolicy } from '../../../shared/apps/capability-policy'
import { TEAM_AUDIT_DETAIL_MAX } from '../../../shared/apps/team-types'
import type { TeamToolAudit } from '../../../shared/apps/team-types'

const LOG_TAG = '[DelegationGate]'

/** Where a recorded call goes. Absent for a scenario with no record of its own. */
export type ToolAuditSink = (entry: TeamToolAudit) => void

/** What is in force for the turn a conversation is running right now. */
export interface ActiveDelegation {
  policy: CapabilityPolicy | undefined
  mode: CapabilityMode
  /** Identifies the turn in the owner's record. */
  audit?: {
    teamId: string
    epochId: string
    appId: string
    actorAppId: string | null
    external: boolean
    sink: ToolAuditSink
  }
}

/**
 * Keyed by conversation because that is what an engine session is keyed by, so
 * a gate installed on a session always reads what the turn on that session
 * registered.
 *
 * An entry is replaced by each turn and outlives it, rather than being cleared
 * at turn end: a turn can leave work running behind it (a background task, a
 * subagent still reporting), and those tool calls arrive after the turn that
 * asked for them is over. Clearing would hand exactly those calls back the full
 * run of the machine. The entry is dropped when the conversation itself goes.
 */
const active = new Map<string, ActiveDelegation>()

/**
 * Put a turn's terms in force, replacing whatever the last turn left.
 *
 * EVERY turn on a gated session registers, including one under no restriction
 * at all — that is what stops an owner's own turn inheriting the restriction a
 * teammate's turn left behind on the same conversation.
 */
export function beginDelegatedTurn(conversationId: string, delegation: ActiveDelegation): void {
  active.set(conversationId, delegation)
}

/** The conversation is gone; so are its terms. */
export function clearDelegation(conversationId: string): void {
  active.delete(conversationId)
}

// ── The gate ──

export interface ToolDecision {
  allow: boolean
  /** Told to the model, so it reads as a closed door rather than a failure. */
  reason?: string
}

/**
 * Decide one tool call for a conversation. Installed on every digital-human
 * session and inert while nothing is registered, so a session reused across a
 * borrowed turn and an owner's turn answers correctly for each.
 */
export function decideDelegatedTool(
  conversationId: string,
  toolName: string,
  input: Record<string, unknown>
): ToolDecision {
  const delegation = active.get(conversationId)
  if (!delegation) return { allow: true }

  const decision = judge(delegation, toolName)
  if (!decision.allow) {
    record(delegation, toolName, input, 'denied', decision.reason ?? null)
    console.warn(`${LOG_TAG} refused ${toolName} on ${conversationId}: ${decision.reason}`)
  }
  return decision
}

/**
 * Note a tool call that went ahead.
 *
 * Fed from the engine's post-tool hook rather than from the gate above: the gate
 * is reached only by calls the engine's own rules did not already clear, so a
 * record written there would hold the refusals and almost nothing else — while
 * the owner's actual question is what another person's digital human had their
 * computer do, which is mostly calls that succeeded.
 */
export function recordExecutedTool(
  conversationId: string,
  toolName: string,
  input: Record<string, unknown>
): void {
  const delegation = active.get(conversationId)
  if (!delegation) return
  record(delegation, toolName, input, 'allowed', null)
}

/**
 * An MCP tool's server decided its fate before the model ever saw it — an
 * uninjected server has no tools to call — so reaching here means it was
 * granted. Built-ins are re-asked because the pool they were removed from was
 * fixed at session creation.
 */
function judge(delegation: ActiveDelegation, toolName: string): ToolDecision {
  if (toolName.startsWith('mcp__')) return { allow: true }

  const { policy, mode } = delegation
  if (toolName === 'Bash') {
    const bash = resolveBashAccess(policy, mode)
    if (bash.scope === 'none') {
      return { allow: false, reason: 'Running commands on this computer was not granted for this request.' }
    }
    if (bash.scope === 'full') return { allow: true }
    // Under a whitelist, arriving here IS the refusal: the engine matched the
    // command against every rule — splitting it on each shell separator — and
    // did not clear it.
    return {
      allow: false,
      reason:
        'This command is outside what its owner allowed for this request. ' +
        'Only specific commands are permitted here; ask them to widen it if this one is needed.',
    }
  }

  if (allowsBuiltinAtCallTime(policy, toolName, mode)) return { allow: true }
  return { allow: false, reason: `"${toolName}" was not granted for this request.` }
}

function record(
  delegation: ActiveDelegation,
  toolName: string,
  input: Record<string, unknown>,
  decision: TeamToolAudit['decision'],
  reason: string | null
): void {
  const audit = delegation.audit
  if (!audit) return
  try {
    audit.sink({
      id: randomUUID(),
      teamId: audit.teamId,
      epochId: audit.epochId,
      appId: audit.appId,
      actorAppId: audit.actorAppId,
      external: audit.external,
      toolName,
      detail: summarizeToolInput(toolName, input),
      decision,
      reason,
      createdAt: Date.now(),
    })
  } catch (error) {
    // The record is what the owner reviews afterwards; losing a row must never
    // take the turn down with it, but a silently empty log would be read as
    // "nothing happened".
    console.error(`${LOG_TAG} could not record ${decision} ${toolName}:`, (error as Error).message)
  }
}

/**
 * The engine hooks a borrowed turn runs with: one post-tool callback that files
 * what went ahead. It decides nothing — refusing is the gate's job, and a hook
 * that could also refuse would give the same question two answers.
 *
 * Shaped as the SDK's hook map so the caller only has to hand it to the session.
 */
export function createDelegationAuditHooks(conversationId: string): Record<string, unknown> {
  return {
    PostToolUse: [
      {
        hooks: [
          async (hookInput: unknown) => {
            const event = hookInput as { tool_name?: string; tool_input?: unknown }
            if (!event?.tool_name) return {}
            const input =
              event.tool_input && typeof event.tool_input === 'object'
                ? (event.tool_input as Record<string, unknown>)
                : {}
            recordExecutedTool(conversationId, event.tool_name, input)
            return {}
          },
        ],
      },
    ],
  }
}

// ── Reading a tool call back to a person ──

/**
 * The fields worth naming per tool, in preference order. A tool input can carry
 * a whole file, so the record holds what the call was AIMED at — the command,
 * the path, the address — and never the payload.
 */
const DETAIL_FIELDS: readonly string[] = [
  'command',
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'url',
  'query',
  'prompt',
  'description',
]

export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  for (const field of DETAIL_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.trim()) return oneLine(value)
  }
  // Nothing recognized: name the shape rather than dumping it, so an unfamiliar
  // tool still produces a readable row.
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  return oneLine(`${toolName}(${keys.slice(0, 4).join(', ')})`)
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > TEAM_AUDIT_DETAIL_MAX
    ? `${collapsed.slice(0, TEAM_AUDIT_DETAIL_MAX - 1)}…`
    : collapsed
}
