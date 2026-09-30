/**
 * The AI browser context each digital-human chat drives.
 *
 * A chat's pages are hosted on the hidden offscreen window and belong to the
 * chat, not the user (see services/ai-browser DESIGN). What matters here is how
 * long they live:
 *
 *  - Native chats (the default session and the user's own local sessions) are
 *    RESIDENT: the context and its tabs outlive the turn so the next message
 *    continues on the same page and the user can open the live view between
 *    turns. Resident is not forever — idle contexts are reaped after
 *    {@link RESIDENT_BROWSER_IDLE_MS}, and at most
 *    {@link MAX_RESIDENT_BROWSER_CONTEXTS} contexts may hold pages at once
 *    (least recently used idle one goes first), because every page is a
 *    Chromium renderer and local sessions are unbounded.
 *  - IM, HTTP and team sessions are PER-TURN: nobody can watch them, and they
 *    can be minted without limit, so the context ends with the turn.
 *
 * A context is never reaped mid-turn, while a turn is starting, or while the
 * user is watching one of its tabs. "Mid-turn" is the live-turn module's answer;
 * a starting turn is trusted only for {@link TURN_TRUST_MS}, so a turn that
 * failed before it could report back cannot pin a context forever.
 */

import { createScopedBrowserContext, type BrowserContext } from '../../services/ai-browser'
import { getAppManager } from '../manager'
import { isAppChatConversationGenerating } from './app-chat-live-turn'
import { resolvePermission } from '../../../shared/apps/app-types'
import { parseNativeChatKey } from '../../../shared/apps/im-keys'

const LOG_TAG = '[AppChatBrowser]'

export const RESIDENT_BROWSER_IDLE_MS = 30 * 60_000
export const MAX_RESIDENT_BROWSER_CONTEXTS = 6
/**
 * How long a turn that acquired a context and has not ended is trusted without
 * the live-turn module confirming it runs. It covers the session build between
 * acquiring and the turn registering (a cold engine start can take well over a
 * minute on a loaded machine); past it, a turn that never reported back cannot
 * pin its context, and a per-turn context is treated as orphaned.
 */
export const TURN_TRUST_MS = 5 * 60_000
const SWEEP_INTERVAL_MS = 60_000
const STATE_LOG_EVERY_SWEEPS = 5

interface Entry {
  ctx: BrowserContext
  appId: string
  resident: boolean
  /** Last turn start/end; idle time is measured from here. */
  lastUsedAt: number
  /** Turns between acquire and end: overlapping turns of one chat share the context. */
  turns: number
}

const entries = new Map<string, Entry>()
let sweeper: ReturnType<typeof setInterval> | null = null
let sweepsSinceStateLog = 0

/** Whether a chat keeps its browser context between turns. */
export function isResidentChatKey(conversationId: string, appId: string): boolean {
  return parseNativeChatKey(conversationId)?.appId === appId
}

/**
 * Get (or create) the context for a chat at the start of a turn. Pair with
 * {@link endChatBrowserTurn}.
 */
export function acquireChatBrowserContext(conversationId: string, appId: string, spaceId: string): BrowserContext {
  const existing = entries.get(conversationId)
  if (existing) {
    existing.lastUsedAt = Date.now()
    existing.turns++
    evictOverCap(conversationId)
    return existing.ctx
  }

  const resident = isResidentChatKey(conversationId, appId)
  evictOverCap(conversationId)
  const ctx = createScopedBrowserContext({ conversationId, spaceId })
  entries.set(conversationId, { ctx, appId, resident, lastUsedAt: Date.now(), turns: 1 })
  ensureSweeper()
  console.log(`${LOG_TAG}[${appId}] Context created: ${conversationId} (${resident ? 'resident' : 'per-turn'})`)
  return ctx
}

/** A chat's turn is over: per-turn contexts end now, resident ones start idling. */
export function endChatBrowserTurn(conversationId: string): void {
  const entry = entries.get(conversationId)
  if (!entry) return
  entry.turns = Math.max(0, entry.turns - 1)
  entry.lastUsedAt = Date.now()
  // A later turn of the same chat may still be using it; the last one out closes it.
  if (!entry.resident && entry.turns === 0) destroyChatBrowserContext(conversationId, 'turn-ended')
}

/** Tear one chat's context down, closing its pages. Returns whether there was one. */
export function destroyChatBrowserContext(conversationId: string, reason: string): boolean {
  const entry = entries.get(conversationId)
  if (!entry) return false
  entries.delete(conversationId)
  const views = entry.ctx.ownedViewCount
  try {
    entry.ctx.destroy()
  } catch (error) {
    console.error(`${LOG_TAG}[${entry.appId}] Context destroy failed: ${conversationId}`, error)
  }
  console.log(`${LOG_TAG}[${entry.appId}] Context destroyed: ${conversationId} (reason=${reason}, views=${views})`)
  if (entries.size === 0) stopSweeper()
  return true
}

/** Tear down every context an app owns (uninstall, space removal). */
export function destroyChatBrowserContextsForApp(appId: string, reason: string): number {
  let destroyed = 0
  for (const [conversationId, entry] of [...entries]) {
    if (entry.appId === appId && destroyChatBrowserContext(conversationId, reason)) destroyed++
  }
  return destroyed
}

/** Tear down everything (app shutdown). */
export function destroyAllChatBrowserContexts(reason: string): number {
  let destroyed = 0
  for (const conversationId of [...entries.keys()]) {
    if (destroyChatBrowserContext(conversationId, reason)) destroyed++
  }
  return destroyed
}

/** Counts for tests and diagnostics. */
export function getChatBrowserStats(): { contexts: number; resident: number; busy: number; views: number } {
  let resident = 0
  let busy = 0
  let views = 0
  for (const [conversationId, entry] of entries) {
    if (entry.resident) resident++
    if (isAppChatConversationGenerating(conversationId)) busy++
    views += entry.ctx.ownedViewCount
  }
  return { contexts: entries.size, resident, busy, views }
}

/** Whether a chat currently has a context (tests and diagnostics). */
export function hasChatBrowserContext(conversationId: string): boolean {
  return entries.has(conversationId)
}

/**
 * Whether a context may be reaped: no turn starting (acquired, not ended, still
 * within {@link TURN_TRUST_MS}) or running, and nobody watching its tabs.
 */
function isReapable(conversationId: string, entry: Entry, now = Date.now()): boolean {
  const turnStarting = entry.turns > 0 && now - entry.lastUsedAt < TURN_TRUST_MS
  return !turnStarting && !isAppChatConversationGenerating(conversationId) && !entry.ctx.hasRevealedView()
}

function evictOverCap(exceptConversationId: string): void {
  const holders = [...entries].filter(([id, e]) => id !== exceptConversationId && e.ctx.ownedViewCount > 0)
  let excess = holders.length - (MAX_RESIDENT_BROWSER_CONTEXTS - 1)
  if (excess <= 0) return
  const candidates = holders
    .filter(([id, e]) => isReapable(id, e))
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
  for (const [id] of candidates) {
    if (excess <= 0) break
    destroyChatBrowserContext(id, 'over-capacity')
    excess--
  }
  if (excess > 0) {
    console.warn(`${LOG_TAG} Over capacity by ${excess}: every other context is busy or being watched`)
  }
}

/** Reap contexts that are idle past the limit or belong to a removed app. Runs on a timer; exported for tests. */
export function sweepChatBrowserContexts(now = Date.now()): void {
  const manager = getAppManager()
  for (const [conversationId, entry] of [...entries]) {
    if (isAppChatConversationGenerating(conversationId)) continue
    // A removed app never announces itself here (deleting a space drops its
    // apps without an uninstall event), so notice it on the sweep.
    const app = manager?.getApp(entry.appId)
    if (manager && (!app || app.status === 'uninstalled')) {
      destroyChatBrowserContext(conversationId, 'app-removed')
      continue
    }
    // Revoking the permission must not leave the pages open until the next turn.
    if (app && !resolvePermission(app, 'ai-browser') && isReapable(conversationId, entry, now)) {
      destroyChatBrowserContext(conversationId, 'ai-browser-disabled')
      continue
    }
    const idleMs = now - entry.lastUsedAt
    if (entry.resident && idleMs >= RESIDENT_BROWSER_IDLE_MS && isReapable(conversationId, entry, now)) {
      destroyChatBrowserContext(conversationId, 'idle')
    } else if (!entry.resident && idleMs >= TURN_TRUST_MS) {
      destroyChatBrowserContext(conversationId, 'orphaned')
    }
  }

  if (entries.size > 0 && ++sweepsSinceStateLog >= STATE_LOG_EVERY_SWEEPS) {
    sweepsSinceStateLog = 0
    const s = getChatBrowserStats()
    console.log(`${LOG_TAG} State: contexts=${s.contexts} resident=${s.resident} busy=${s.busy} views=${s.views}`)
  }
}

function ensureSweeper(): void {
  if (sweeper) return
  sweeper = setInterval(() => sweepChatBrowserContexts(), SWEEP_INTERVAL_MS)
  // Never keep the process alive just to reap browser pages.
  sweeper.unref?.()
}

function stopSweeper(): void {
  if (!sweeper) return
  clearInterval(sweeper)
  sweeper = null
  sweepsSinceStateLog = 0
}

