/**
 * Home-shell telemetry emitter.
 *
 * Every home, navigation and landing-page event goes through here so the
 * common `shell` property is never forgotten and the contract in
 * `shared/analytics/home-telemetry` is enforced at compile time. Holds the
 * small amount of cross-component state telemetry needs: exposure dedupe,
 * the pending "where did this intent come from" tag, and in-flight turns
 * awaiting their outcome. Never throws and never blocks a user path.
 */

import { api } from '../api'
import { isCapacitor, isElectron } from '../api/transport'
import { MOBILE_BREAKPOINT } from '../hooks/useIsMobile'
import type { HomeEntry, HomeEventName, HomeEventProps } from '../../shared/analytics/home-telemetry'

export type HomeShell = 'wide' | 'narrow'
export type TurnRecipient = 'halo' | 'digital_human'
export type TurnOutcome = 'ok' | 'error' | 'stopped'

/** An intent older than this is not credited to the action that lands later. */
const ENTRY_TTL_MS = 30_000
/** A home render later than this after the navigation is not a navigation cost. */
const HOT_PAINT_WINDOW_MS = 10_000
/** Turns that never report back (app closed mid-turn) must not accumulate. */
const MAX_PENDING_TURNS = 50
/** How long a completed turn waits for a trailing interruption before it counts as a success. */
const COMPLETION_GRACE_MS = 3_000

/** Same rule as `useIsNarrowShell`, readable outside React. */
export function currentShell(): HomeShell {
  if (isCapacitor()) return 'narrow'
  if (isElectron()) return 'wide'
  return typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT ? 'narrow' : 'wide'
}

export function trackHome<E extends HomeEventName>(event: E, props?: HomeEventProps<E>): void {
  try {
    api.trackEvent(event, { ...props, shell: currentShell() })
  } catch {
    // Telemetry must never break the caller.
  }
}

const exposed = new Set<string>()

/** Emits once per home visit for a given key; `resetHomeExposure` starts a new visit. */
export function trackHomeOnce<E extends HomeEventName>(key: string, event: E, props?: HomeEventProps<E>): void {
  if (exposed.has(key)) return
  exposed.add(key)
  trackHome(event, props)
}

export function resetHomeExposure(): void {
  exposed.clear()
}

const lastEmitAt = new Map<string, number>()

export function trackHomeThrottled<E extends HomeEventName>(
  key: string,
  windowMs: number,
  event: E,
  props?: HomeEventProps<E>,
): void {
  const now = Date.now()
  const last = lastEmitAt.get(key)
  if (last !== undefined && now - last < windowMs) return
  lastEmitAt.set(key, now)
  trackHome(event, props)
}

// ── Intent attribution ────────────────────────────────────────────────

let pendingEntry: { entry: HomeEntry; at: number } | null = null

export function markEntry(entry: HomeEntry): void {
  pendingEntry = { entry, at: Date.now() }
}

export function peekEntry(): HomeEntry {
  if (!pendingEntry || Date.now() - pendingEntry.at > ENTRY_TTL_MS) return 'direct'
  return pendingEntry.entry
}

/** Reads and clears the pending intent, so it is credited to one landing only. */
export function takeEntry(): HomeEntry {
  const entry = peekEntry()
  pendingEntry = null
  return entry
}

// ── Navigation ────────────────────────────────────────────────────────

let currentView = ''
let homeNavStartedAt: number | null = null
let coldPaintReported = false

/** Kept current by the app-level view tracker so emitters need no store access. */
export function setCurrentView(view: string): void {
  currentView = view
}

export function getCurrentView(): string {
  return currentView
}

export type NavSurface =
  | 'rail' | 'sheet' | 'header' | 'task_panel' | 'rail_tab' | 'conversation_list' | 'deeplink'
  | 'composer' | 'notification' | 'search'

/** Records a user-initiated navigation and the intent it carries to the next page. */
export function trackNavigate(to: string, surface: NavSurface, entry: HomeEntry): void {
  if (to === currentView) return
  markEntry(entry)
  if (to === 'space') homeNavStartedAt = Date.now()
  trackHome('nav.navigate', { to, from: currentView, surface })
}

/**
 * Time until the home shell rendered: since process start on the first render,
 * since the navigation that led here afterwards. Null when neither applies.
 */
export function takeHomePaintTiming(): { cold: boolean; ms: number } | null {
  if (!coldPaintReported) {
    coldPaintReported = true
    homeNavStartedAt = null
    return { cold: true, ms: performance.now() }
  }
  const startedAt = homeNavStartedAt
  homeNavStartedAt = null
  if (startedAt === null) return null
  const ms = Date.now() - startedAt
  return ms <= HOT_PAINT_WINDOW_MS ? { cold: false, ms } : null
}

// ── Composer origin ───────────────────────────────────────────────────

export type ComposerOrigin = { source: 'chip'; chip: string } | { source: 'skill_use' }

let composerOrigin: ComposerOrigin | null = null

/** Set by whatever pre-fills the composer, read once by the composer when it takes the text. */
export function setComposerOrigin(origin: ComposerOrigin): void {
  composerOrigin = origin
}

export function takeComposerOrigin(): ComposerOrigin | null {
  const origin = composerOrigin
  composerOrigin = null
  return origin
}

// ── Turn outcomes ─────────────────────────────────────────────────────

interface PendingTurn {
  sentAt: number
  recipient: TurnRecipient
  /** Set once the turn completed; the success is reported only after the grace window. */
  completion?: { endedAt: number; timer: ReturnType<typeof setTimeout> }
}

const pendingTurns = new Map<string, PendingTurn>()

function reportTurn(conversationId: string, outcome: TurnOutcome, endedAt: number): void {
  const turn = pendingTurns.get(conversationId)
  if (!turn) return
  if (turn.completion) clearTimeout(turn.completion.timer)
  pendingTurns.delete(conversationId)
  trackHome('home.composer.reply', {
    outcome,
    recipient: turn.recipient,
    latencyBucket: replyLatencyBucket(endedAt - turn.sentAt),
  })
}

export function noteTurnSent(conversationId: string, recipient: TurnRecipient): void {
  const previous = pendingTurns.get(conversationId)
  if (previous?.completion) reportTurn(conversationId, 'ok', previous.completion.endedAt)
  pendingTurns.delete(conversationId)
  pendingTurns.set(conversationId, { sentAt: Date.now(), recipient })
  if (pendingTurns.size > MAX_PENDING_TURNS) {
    const oldest = pendingTurns.keys().next().value
    if (oldest !== undefined) {
      const evicted = pendingTurns.get(oldest)
      if (evicted?.completion) clearTimeout(evicted.completion.timer)
      pendingTurns.delete(oldest)
    }
  }
}

/**
 * A stop or failure is final the moment it is known. A completion is not: an
 * interruption is reported right after the turn completes, so a completed turn
 * counts as a success only if nothing worse arrives within the grace window.
 */
export function noteTurnEnded(conversationId: string, outcome: TurnOutcome): void {
  const turn = pendingTurns.get(conversationId)
  if (!turn) return
  if (outcome !== 'ok') {
    reportTurn(conversationId, outcome, turn.completion?.endedAt ?? Date.now())
    return
  }
  if (turn.completion) return
  const endedAt = Date.now()
  turn.completion = { endedAt, timer: setTimeout(() => reportTurn(conversationId, 'ok', endedAt), COMPLETION_GRACE_MS) }
}

// ── Buckets ───────────────────────────────────────────────────────────

export function msBucket(ms: number): string {
  if (ms < 200) return '0-200'
  if (ms < 500) return '200-500'
  if (ms < 1000) return '500-1000'
  if (ms < 3000) return '1000-3000'
  return '3000+'
}

export function replyLatencyBucket(ms: number): string {
  if (ms < 3_000) return '0-3s'
  if (ms < 10_000) return '3-10s'
  if (ms < 30_000) return '10-30s'
  if (ms < 60_000) return '30-60s'
  return '60s+'
}

export function lenBucket(length: number): string {
  if (length < 20) return '0-20'
  if (length < 100) return '20-100'
  if (length < 500) return '100-500'
  return '500+'
}

export function capCount(n: number): number {
  return Math.min(n, 999)
}

/**
 * Buckets a count by ascending inclusive upper bounds; the first bound is a
 * bucket of its own. `[0, 1, 5]` yields '0', '1', '2-5', '5+'.
 */
export function countBucket(n: number, upperBounds: readonly number[]): string {
  let lower = upperBounds[0]
  for (const upper of upperBounds) {
    if (n <= upper) return lower === upper ? String(upper) : `${lower}-${upper}`
    lower = upper + 1
  }
  return `${upperBounds[upperBounds.length - 1]}+`
}
