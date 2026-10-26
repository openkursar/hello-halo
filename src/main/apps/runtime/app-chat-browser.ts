/**
 * The AI browser context each digital-human chat drives.
 *
 * A chat's pages belong to the chat, not the user (see services/ai-browser
 * DESIGN). What matters here is who can watch them and how long they live:
 *
 *  - Native chats (the default session and the user's own local sessions) are
 *    RESIDENT and watchable: their pages open in the main window under the
 *    chat's key (one that window cannot attach in time opens unwatchable in the
 *    hidden host instead), the tabs outlive the turn so the next message
 *    continues on the same page, and the user can open the live view between
 *    turns. Resident is not forever — idle pages are closed after
 *    {@link RESIDENT_BROWSER_IDLE_MS}, and at most
 *    {@link MAX_RESIDENT_BROWSER_CONTEXTS} chats may hold pages at once
 *    (least recently used idle one goes first), because every page is a
 *    Chromium renderer and local sessions are unbounded.
 *  - IM, HTTP and team sessions are PER-TURN and unattended, like an automation
 *    run: nobody can watch them, so their pages stay in the hidden host and the
 *    renderer never hears of them. They mostly run while nobody is at the
 *    computer, which is when the main window has failed to attach new pages.
 *    They can be minted without limit, so their pages close with the turn.
 *
 * The context itself lives as long as the ENGINE SESSION of the chat. A session
 * (one engine process, reused between messages for up to 30 minutes) is built
 * with an `ai-browser` tool server that closes over the context of the turn
 * that built it, and every later turn of that session reaches that same object.
 * A context ended for good while its session lived left the session's browser
 * refusing every call ("Browser context was released") until the session
 * idled out — a chat answering every few minutes never recovered. So a turn,
 * idling and the cap close pages only; the context is disposed when its
 * session is retired ({@link bindChatBrowserSession}), when the chat is reset
 * or its app removed, or when no session ever took it.
 *
 * Pages are never closed mid-turn, while a turn is starting, or while the user
 * is watching one of them. "Mid-turn" is the live-turn module's answer; a
 * starting turn is trusted only for {@link TURN_TRUST_MS}, so a turn that
 * failed before it could report back cannot pin pages forever.
 */

import { createScopedBrowserContext, type BrowserContext } from '../../services/ai-browser'
import type { V2SessionLease } from '../../services/agent'
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
 * pin its pages, and a context no session took is treated as orphaned.
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
  /** The engine session whose tools hold `ctx`; null before a turn bound one and after it retired. */
  session: object | null
}

const entries = new Map<string, Entry>()
let sweeper: ReturnType<typeof setInterval> | null = null
let sweepsSinceStateLog = 0

/** Whether a chat keeps its pages between turns and the user can watch them. */
export function isResidentChatKey(conversationId: string, appId: string): boolean {
  return parseNativeChatKey(conversationId)?.appId === appId
}

/**
 * Get (or create) the context for a chat at the start of a turn. Pair with
 * {@link endChatBrowserTurn}, and with {@link bindChatBrowserSession} once the
 * turn has its session.
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
  const ctx = createScopedBrowserContext(resident ? { liveView: { conversationId, spaceId } } : {})
  entries.set(conversationId, { ctx, appId, resident, lastUsedAt: Date.now(), turns: 1, session: null })
  ensureSweeper()
  console.log(`${LOG_TAG}[${appId}] Context created: ${conversationId} (${resident ? 'resident' : 'per-turn'})`)
  return ctx
}

/**
 * The turn has its engine session: the context now lives as long as that
 * session instance. A later turn on the same session binds nothing new; a
 * rebuilt session takes the context over from the one it replaced.
 *
 * When the session is retired, the context is disposed — unless a turn is in
 * flight (the one rebuilding the session, or the one the session died under),
 * which keeps the object its tools were built around and ends or re-binds it
 * itself — and unless a resident chat still holds pages: those stay for the
 * user, as after any session restart, and the next session is built around the
 * same context. What no session takes again is reclaimed by the sweep.
 */
export function bindChatBrowserSession(conversationId: string, lease: V2SessionLease): void {
  const entry = entries.get(conversationId)
  if (!entry || entry.session === lease.session) return
  const session = lease.session
  entry.session = session
  lease.onRetired(() => {
    const current = entries.get(conversationId)
    if (!current || current.session !== session) return
    current.session = null
    if (current.turns > 0 || isAppChatConversationGenerating(conversationId)) return
    if (current.resident && current.ctx.ownedViewCount > 0) return
    destroyChatBrowserContext(conversationId, 'session-retired')
  })
}

/**
 * A chat's turn is over: a per-turn chat's pages close now, a resident chat's
 * start idling. A per-turn context no session took — the turn was refused
 * while being set up, or its session was retired under it — goes with the
 * turn, as nothing can reach it any more.
 */
export function endChatBrowserTurn(conversationId: string): void {
  const entry = entries.get(conversationId)
  if (!entry) return
  entry.turns = Math.max(0, entry.turns - 1)
  entry.lastUsedAt = Date.now()
  // A later turn of the same chat may still be using them; the last one out closes them.
  if (!entry.resident && entry.turns === 0) closePagesOrDispose(conversationId, entry, 'turn-ended')
}

/**
 * Close a chat's pages, keeping the context: the session holding it serves the
 * next turn with the same object.
 */
function closePages(conversationId: string, entry: Entry, reason: string): void {
  const views = entry.ctx.ownedViewCount
  if (views === 0) return
  try {
    entry.ctx.closePages()
  } catch (error) {
    console.error(`${LOG_TAG}[${entry.appId}] Closing pages failed: ${conversationId}`, error)
  }
  console.log(`${LOG_TAG}[${entry.appId}] Pages closed: ${conversationId} (reason=${reason}, views=${views})`)
}

/** Close a chat's pages, or dispose the context when no session holds it. */
function closePagesOrDispose(conversationId: string, entry: Entry, reason: string): void {
  if (entry.session) closePages(conversationId, entry, reason)
  else destroyChatBrowserContext(conversationId, reason)
}

/** Tear one chat's context down for good, closing its pages. Returns whether there was one. */
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
 * Whether a chat's pages may be closed: no turn starting (acquired, not ended,
 * still within {@link TURN_TRUST_MS}) or running, and nobody watching its tabs.
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
  for (const [id, entry] of candidates) {
    if (excess <= 0) break
    closePages(id, entry, 'over-capacity')
    excess--
  }
  if (excess > 0) {
    console.warn(`${LOG_TAG} Over capacity by ${excess}: every other chat is busy or being watched`)
  }
}

/**
 * Close pages left idle past their limit and dispose contexts nothing holds
 * any more or that belong to a removed app. Runs on a timer; exported for tests.
 */
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
      closePagesOrDispose(conversationId, entry, 'ai-browser-disabled')
      continue
    }
    const idleMs = now - entry.lastUsedAt
    if (entry.resident) {
      if (idleMs >= RESIDENT_BROWSER_IDLE_MS && isReapable(conversationId, entry, now)) closePagesOrDispose(conversationId, entry, 'idle')
    } else if (idleMs >= TURN_TRUST_MS) {
      // Its turn ended long ago, or never reported back and is no longer
      // trusted. A session holding it keeps it, pages closed, until retired.
      entry.turns = 0
      closePagesOrDispose(conversationId, entry, 'orphaned')
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
