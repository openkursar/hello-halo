/**
 * apps/runtime -- Live Instances of a Digital Human
 *
 * A digital human is a role; each execution of it is an instance. All instances
 * of one role share a single `memory.md`, written in the first person, so a line
 * like "I am leading the migration" tells a NEW instance nothing about who wrote
 * it. This module supplies the vocabulary that makes the difference visible: who
 * this execution is, and who else is executing at the same moment.
 *
 * The list is DERIVED, never registered. Membership comes from the same state
 * that stop-generation and mid-turn injection already read — the run registry,
 * the app-chat round sinks, the agent session consumers. A ghost entry is
 * therefore not a bug to guard against but a shape that cannot occur: an
 * instance is listed only while the thing that would answer a stop request for
 * it still exists. Nothing here is written on turn start that could outlive the
 * turn, and nothing needs cleaning up on crash.
 *
 * `turnStarts` is the one piece of local state, and it is an annotation, not a
 * membership: it can only ever attach a start time to an id the derived
 * enumeration already produced, and stale keys are pruned against that
 * enumeration on every read.
 *
 * Local instances only. A federated office replicates the board, the roster and
 * epoch lifecycle — it does not replicate memory (each node's digital human
 * keeps its own `memory.md`). A teammate's turn running on another machine
 * therefore cannot have written the memory this instance is reading, and
 * listing it would suggest a shared state that does not exist.
 */

import { getConversationsWithActiveRound } from './app-chat-sink'
import { getRunningConsumerIds } from '../../services/agent/session-manager'
import { listActiveRuns } from './active-runs'
import { getImSessionRegistry } from './im-session-registry'
import { getActiveTeamRuntime } from './team'
import { getAppChatConversationId, parseAppChatKey, parseTeamSessionKey } from '../../../shared/apps/im-keys'
import { classifySessionSource, getImSessionDisplayName } from '../../../shared/types/im-channel'
import type { TriggerType } from './types'

/** Which surface an execution came in through. */
export type LiveInstanceKind = 'run' | 'chat' | 'im' | 'team'

/** One execution of a digital human, as another execution should see it. */
export interface LiveInstance {
  /** Short stable id, unique among this app's concurrent instances. */
  id: string
  kind: LiveInstanceKind
  /** Where it came from, in the words a person would use: `schedule`, `chat`, an IM chat's name, `team:Ops`. */
  origin: string
  /** Epoch ms. 0 when the start was never observed (an id seen for the first time mid-turn). */
  startedAt: number
}

/**
 * How long an instance must have been live before it is worth mentioning. Below
 * this, the reader is more likely to be looking at itself under a second name,
 * or at a turn that will be over before the sentence is read.
 *
 * It gates on age, so it cannot gate an instance whose start was never observed.
 * Those are shown: the enumeration is what proves one is running, and a start
 * time is only how it is described.
 */
const MIN_VISIBLE_MS = 5_000

/** Sanitized origin length — long enough to recognise an IM group, short enough to stay a tag. */
const MAX_ORIGIN_LEN = 24

// ── Turn start times ────────────────────────────────────────────────────────

/** conversationId -> first observed start. Annotation only; see the module header. */
const turnStarts = new Map<string, number>()

/**
 * A chat/IM/team turn began. Called from the one point every app-chat turn
 * passes through; a missed call costs the entry its start time, never its
 * presence.
 */
export function noteInstanceTurnStarted(conversationId: string): void {
  if (!turnStarts.has(conversationId)) turnStarts.set(conversationId, Date.now())
}

/** The turn ended. Idempotent; the derived list would drop it either way. */
export function noteInstanceTurnEnded(conversationId: string): void {
  turnStarts.delete(conversationId)
}

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * Every conversation of this app that currently exists in memory: one that has
 * a message awaiting an answer, and one whose consumer is alive. Covers the
 * native default, native local, IM, HTTP and team sessions; cross-app keys never
 * match the prefix.
 *
 * Shared by stop-generation, the generating check and the live-instance list, so
 * "what is running" has one answer everywhere.
 */
export function collectAppConversationIds(appId: string): string[] {
  const prefix = getAppChatConversationId(appId)
  const ids = new Set<string>()
  for (const id of getConversationsWithActiveRound()) {
    if (id === prefix || id.startsWith(prefix + ':')) ids.add(id)
  }
  for (const id of getRunningConsumerIds()) {
    if (id === prefix || id.startsWith(prefix + ':')) ids.add(id)
  }
  return Array.from(ids)
}

/**
 * The other instances of this digital human executing right now, oldest first.
 *
 * Excludes `selfId` and anything younger than {@link MIN_VISIBLE_MS}. True at
 * the moment of the call and no longer — it is a description, not a lock.
 */
export function listLiveInstances(appId: string, selfId?: string): LiveInstance[] {
  const now = Date.now()
  const instances: LiveInstance[] = []

  for (const run of listActiveRuns(appId)) {
    instances.push({
      id: shortRunId(run.runId),
      kind: 'run',
      origin: runOrigin(run.triggerType),
      startedAt: run.startedAt,
    })
  }

  const conversationIds = collectAppConversationIds(appId)
  for (const conversationId of conversationIds) {
    instances.push({
      id: shortConversationId(conversationId),
      ...describeConversation(appId, conversationId),
      startedAt: turnStarts.get(conversationId) ?? 0,
    })
  }

  for (const key of turnStarts.keys()) {
    if (key.startsWith(getAppChatConversationId(appId)) && !conversationIds.includes(key)) {
      turnStarts.delete(key)
    }
  }

  return instances
    .filter((i) => i.id !== selfId && (i.startedAt === 0 || now - i.startedAt >= MIN_VISIBLE_MS))
    // Oldest first, but an unknown start goes last rather than to the front:
    // sorting it as time zero would present the one instance we can say least
    // about as the longest-running one.
    .sort((a, b) => (a.startedAt || Infinity) - (b.startedAt || Infinity))
}

/**
 * Which instance THIS execution is. Automation runs identify by run id; every
 * chat surface (native, local, HTTP, IM, team) identifies by its conversation key.
 */
export function describeSelfInstance(
  appId: string,
  source: { runId: string; triggerType: TriggerType; startedAt: number } | { conversationId: string }
): LiveInstance {
  if ('runId' in source) {
    return {
      id: shortRunId(source.runId),
      kind: 'run',
      origin: runOrigin(source.triggerType),
      startedAt: source.startedAt,
    }
  }
  return {
    id: shortConversationId(source.conversationId),
    ...describeConversation(appId, source.conversationId),
    startedAt: turnStarts.get(source.conversationId) ?? Date.now(),
  }
}

/**
 * The instance's name as it appears in memory and in the live list:
 * `origin#id4` (e.g. `schedule#a1b2`). The origin half is user-controlled — an
 * IM group name — and lands inside a markdown heading, so the characters that
 * would break one out of it are removed here rather than at each call site.
 */
export function formatInstanceTag(instance: LiveInstance): string {
  return `${sanitizeOrigin(instance.origin)}#${instance.id.slice(0, 4)}`
}

/** Human phrasing for the kind, used where the tag alone is too terse. */
export function describeInstanceKind(instance: LiveInstance): string {
  switch (instance.kind) {
    case 'run':
      return 'scheduled run'
    case 'im':
      return 'IM conversation'
    case 'team':
      return 'team session'
    case 'chat':
      return 'chat with the user'
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

function sanitizeOrigin(origin: string): string {
  const cleaned = origin.replace(/[[\]|\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return 'unknown'
  return cleaned.length > MAX_ORIGIN_LEN ? cleaned.slice(0, MAX_ORIGIN_LEN) : cleaned
}

function runOrigin(triggerType: TriggerType): string {
  switch (triggerType) {
    case 'schedule':
      return 'schedule'
    case 'event':
      return 'event'
    case 'manual':
      return 'manual'
    default:
      return 'run'
  }
}

function describeConversation(
  appId: string,
  conversationId: string
): { kind: LiveInstanceKind; origin: string } {
  const team = parseTeamSessionKey(conversationId)
  if (team) {
    const name = getActiveTeamRuntime()?.getTeamName(team.teamId)
    return { kind: 'team', origin: name ? `team:${name}` : 'team' }
  }

  const parsed = parseAppChatKey(conversationId)
  if (parsed && classifySessionSource(parsed.channel) === 'im') {
    const session = getImSessionRegistry()?.findSession(appId, parsed.channel, parsed.chatId)
    return { kind: 'im', origin: session ? getImSessionDisplayName(session) : parsed.chatId }
  }

  return { kind: 'chat', origin: 'chat' }
}

/** Matches the run tag used in the runtime logs, so a listed instance is greppable. */
function shortRunId(runId: string): string {
  return runId.replace(/-/g, '').slice(0, 8)
}

/**
 * A conversation key is structured, not random ("app-chat:{appId}:…"), so its
 * prefix identifies nothing. Digest it instead.
 */
function shortConversationId(conversationId: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < conversationId.length; i++) {
    hash ^= conversationId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
