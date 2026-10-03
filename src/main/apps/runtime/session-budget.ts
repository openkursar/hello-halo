/**
 * Session budget — how many engine sessions may stay resident at once.
 *
 * Every resident chat session (space chat, digital-human chat, IM, team member)
 * is one engine process, so this is the first resource to run out as digital
 * humans multiply. The budget is the configured maximum (Settings, default 10),
 * halved while system memory pressure is above normal. Renderer memory is not
 * counted: closing engine processes does not shrink the window. The limit is pushed down to the
 * engine, which applies it before creating any new session; automation runs,
 * whose sessions are transient, make room through `admitTransientSession()`.
 *
 * The engine never refuses a session: when every resident session is busy the
 * new one goes over budget. Evicted sessions resume from their stored session
 * id on their next turn.
 */

import { getConfig, onAgentConfigChange } from '../../foundation/config.service'
import { getSystemMemoryPressure, onSystemMemoryPressure, type MemoryPressureLevel } from '../../platform/background'
import {
  evictIdleSession,
  listResidentSessions,
  setResidentSessionLimit,
} from '../../services/agent'
import { clampMaxResidentSessions } from '../../../shared/constants/session-budget'
import { parseTeamSessionKey } from '../../../shared/apps/im-keys'

export function computeResidentSessionLimit(configured: unknown, pressure: MemoryPressureLevel): number {
  const base = clampMaxResidentSessions(configured)
  return pressure === 'normal' ? base : Math.max(1, Math.ceil(base / 2))
}

let currentLimit: number | null = null
let disposers: Array<() => void> = []

function currentComputedLimit(): number {
  return computeResidentSessionLimit(getConfig().agent?.maxResidentSessions, getSystemMemoryPressure())
}

/** Evict idle resident sessions beyond `limit`, least recently used first. */
function trimTo(limit: number, reason: string): number {
  const idle = listResidentSessions()
    .filter((s) => !s.busy)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  let excess = listResidentSessions().length - limit
  let evicted = 0
  for (const session of idle) {
    if (excess <= 0) break
    if (evictIdleSession(session.conversationId, reason)) {
      excess -= 1
      evicted += 1
    }
  }
  return evicted
}

function apply(trigger: string): void {
  const limit = currentComputedLimit()
  if (limit === currentLimit) return
  const previous = currentLimit
  currentLimit = limit
  setResidentSessionLimit(limit)
  // A lowered budget takes effect now, not only at the next session creation.
  const evicted = previous !== null && limit < previous ? trimTo(limit, `session budget lowered (${trigger})`) : 0
  console.log(`[SessionBudget] limit ${previous ?? 'unset'} -> ${limit} (${trigger}); evicted=${evicted}`)
}

export function initSessionBudget(): void {
  disposeSessionBudget()
  apply('init')
  disposers = [
    onAgentConfigChange(() => apply('config')),
    onSystemMemoryPressure((level) => apply(`system memory ${level}`)),
  ]
}

export function disposeSessionBudget(): void {
  for (const dispose of disposers) dispose()
  disposers = []
  currentLimit = null
  setResidentSessionLimit(null)
}

/**
 * Make room for a transient engine session (an automation run) that does not
 * go through resident-session creation: evict idle sessions so that, counting
 * the new one, residency stays within budget.
 */
export function admitTransientSession(label: string): void {
  if (currentLimit === null) return
  trimTo(currentLimit - 1, `transient session ${label}`)
}

export function getSessionBudgetLimit(): number | null {
  return currentLimit
}

/**
 * A sealed team epoch will not take member turns until it is reopened, so its
 * member sessions are closed now instead of idling out. Busy sessions are left
 * alone; a reopened epoch resumes each member from its stored session id.
 */
export function releaseTeamEpochSessions(teamId: string, epochId: string): number {
  let released = 0
  for (const session of listResidentSessions()) {
    const key = parseTeamSessionKey(session.conversationId)
    if (!key || key.teamId !== teamId || key.epochId !== epochId || session.busy) continue
    if (evictIdleSession(session.conversationId, 'team epoch sealed')) released += 1
  }
  if (released > 0) console.log(`[SessionBudget] Released ${released} member session(s) of sealed epoch ${teamId}/${epochId}`)
  return released
}
