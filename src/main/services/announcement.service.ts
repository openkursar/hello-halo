/**
 * Announcement Service
 *
 * Polls a static JSON feed (`product.json > announcementsUrl`) and surfaces new
 * entries as in-app toasts. This is the only path that can reach users who are
 * already on the latest build — update release notes ride a version bump, so
 * they can never carry a message meant for everyone.
 *
 * Design:
 *   - One singleton interval (default 6h), started from extended bootstrap.
 *   - Dedup state lives here, not in the renderer: the main process is the
 *     source of truth, and a renderer-side record would be lost on remote and
 *     mobile clients that share the same feed.
 *   - Entries are filtered by schedule window and version range before display,
 *     so a feed can target "everyone still on an old build" without a server.
 *
 * Why this module owns its loop rather than platform/scheduler: the scheduler
 * surfaces user-defined automation jobs, and a maintenance poll does not belong
 * in that list. Same rationale as `store/upgrade.service.ts`.
 *
 * Trust boundary: feed content is server-authored and, on internal
 * deployments, travels over plain HTTP. Everything below treats it as
 * untrusted input — entries are shape-checked, action URLs are protocol-
 * filtered, and the body is rendered by the restricted `RichText` renderer,
 * which never executes embedded HTML.
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getAnnouncementsUrl } from '../foundation/product-config'
import { proxyFetch } from './proxy-fetch'
import { pushToast } from './notification.service'
import type { Announcement } from '../../shared/types/announcement'

// ============================================================================
// Constants
// ============================================================================

/** Default poll interval: 6 hours. */
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Delay before the first poll.
 *
 * Short on purpose: the feed is a few-KB conditional GET, too small to matter
 * against cold start, and holding a maintenance notice back a full minute buys
 * nothing. The heavy startup work — catalog sync and the installed-app upgrade
 * check — keeps its own longer deferral.
 */
const FIRST_CHECK_DELAY_MS = 5_000

/** A stalled feed host must not hold a socket open indefinitely. */
const FETCH_TIMEOUT_MS = 10_000

/**
 * Upper bound on remembered ids.
 *
 * Retired announcements are dropped from the feed but their ids must stay
 * remembered long enough that a slow client does not re-show them. Trimming
 * oldest-first keeps the file bounded without a expiry-tracking scheme.
 */
const MAX_REMEMBERED_IDS = 500

/** Refuse absurdly large feeds rather than parsing them into memory. */
const MAX_FEED_BYTES = 512 * 1024

const STATE_FILE = 'announcements-state.json'

const SAFE_ACTION_PROTOCOLS = new Set(['http:', 'https:'])

// ============================================================================
// State
// ============================================================================

let timer: ReturnType<typeof setInterval> | null = null
let firstRunTimer: ReturnType<typeof setTimeout> | null = null
let runningTick = false

/**
 * ETag of the last successful fetch — deliberately in-memory only.
 *
 * Persisting it would let a 304 suppress an entry that was fetched but never
 * delivered (window closed, crash) on the next launch. Re-downloading a small
 * static file once per process is the cheaper mistake.
 */
let lastEtag: string | null = null

interface PersistedState {
  /** Ids already shown, oldest first. */
  shown: string[]
}

let state: PersistedState | null = null

function getStatePath(): string {
  return join(app.getPath('userData'), STATE_FILE)
}

function loadState(): PersistedState {
  if (state) return state

  try {
    const path = getStatePath()
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PersistedState>
      state = { shown: Array.isArray(parsed.shown) ? parsed.shown.filter(id => typeof id === 'string') : [] }
      return state
    }
  } catch (error) {
    console.warn('[Announcement] Could not read state, starting fresh:', error)
  }

  state = { shown: [] }
  return state
}

function saveState(): void {
  if (!state) return
  try {
    const path = getStatePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state), 'utf-8')
  } catch (error) {
    // Losing the record only means an announcement may repeat once — never
    // worth failing the tick over.
    console.error('[Announcement] Failed to persist state:', error)
  }
}

// ============================================================================
// Filtering
// ============================================================================

/**
 * Compare two version strings by their numeric release components.
 *
 * Pre-release suffixes are ignored: an `-rc` build is targeted by the same
 * range as the release it precedes, which is what a feed author expects when
 * they write `maxVersion: "2.1.13"`.
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split('-')[0].split('.').map(part => parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)

  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/** Parse an ISO timestamp, treating anything unparseable as absent. */
function parseTime(value: string | undefined): number | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

/** Structural check — a malformed entry must not take down the whole feed. */
function isWellFormed(entry: unknown): entry is Announcement {
  if (!entry || typeof entry !== 'object') return false
  const candidate = entry as Partial<Announcement>
  return typeof candidate.id === 'string' && candidate.id.length > 0
    && typeof candidate.title === 'string' && candidate.title.length > 0
}

function isDue(entry: Announcement, now: number, currentVersion: string): boolean {
  const startsAt = parseTime(entry.startsAt)
  if (startsAt !== null && now < startsAt) return false

  const expiresAt = parseTime(entry.expiresAt)
  if (expiresAt !== null && now > expiresAt) return false

  if (entry.minVersion && compareVersions(currentVersion, entry.minVersion) < 0) return false
  if (entry.maxVersion && compareVersions(currentVersion, entry.maxVersion) > 0) return false

  return true
}

/** Strip an action whose URL is missing or uses a protocol we will not open. */
function sanitizeAction(action: Announcement['action']): Announcement['action'] {
  if (!action || typeof action.label !== 'string' || typeof action.url !== 'string') return undefined
  try {
    return SAFE_ACTION_PROTOCOLS.has(new URL(action.url).protocol) ? action : undefined
  } catch {
    return undefined
  }
}

// ============================================================================
// Fetching
// ============================================================================

async function fetchFeed(url: string): Promise<Announcement[] | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (lastEtag) headers['If-None-Match'] = lastEtag

    const response = await proxyFetch(url, { headers, signal: controller.signal })

    if (response.status === 304) {
      console.log('[Announcement] Feed unchanged (304)')
      return null
    }
    if (!response.ok) {
      console.warn(`[Announcement] Feed request failed: ${response.status} ${response.statusText}`)
      return null
    }

    const size = Number(response.headers.get('content-length') ?? 0)
    if (size > MAX_FEED_BYTES) {
      console.warn(`[Announcement] Feed too large (${size} bytes), ignoring`)
      return null
    }

    const text = await response.text()
    if (text.length > MAX_FEED_BYTES) {
      console.warn(`[Announcement] Feed body too large (${text.length} bytes), ignoring`)
      return null
    }

    const parsed = JSON.parse(text) as unknown
    // A bare array is accepted so the simplest possible feed is a JSON list.
    const entries = Array.isArray(parsed)
      ? parsed
      : (parsed as { announcements?: unknown })?.announcements

    if (!Array.isArray(entries)) {
      console.warn('[Announcement] Feed is not a list, ignoring')
      return null
    }

    lastEtag = response.headers.get('etag')
    return entries.filter(isWellFormed)
  } catch (error) {
    if (controller.signal.aborted) {
      console.warn(`[Announcement] Feed request timed out after ${FETCH_TIMEOUT_MS}ms`)
    } else {
      console.warn('[Announcement] Feed request error:', error)
    }
    return null
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Fetch the feed and display any entry that is due and not yet shown.
 *
 * Coalesces concurrent invocations so a manual trigger cannot double-fire a
 * scheduled tick. Never throws — a feed problem must not surface to the user.
 *
 * @returns How many announcements were displayed in this tick
 */
export async function checkAnnouncementsNow(): Promise<number> {
  const url = getAnnouncementsUrl()
  if (!url) return 0

  if (runningTick) {
    console.log('[Announcement] Check already in progress, skipping')
    return 0
  }
  runningTick = true

  try {
    const entries = await fetchFeed(url)
    if (!entries) return 0

    const persisted = loadState()
    const seen = new Set(persisted.shown)
    const now = Date.now()
    const currentVersion = app.getVersion()

    const due = entries.filter(entry => !seen.has(entry.id) && isDue(entry, now, currentVersion))

    if (due.length === 0) {
      console.log(`[Announcement] ${entries.length} entries, none due`)
      return 0
    }

    let displayed = 0
    for (const entry of due) {
      const delivered = pushToast({
        id: `announcement-${entry.id}`,
        title: entry.title,
        body: entry.body,
        bodyFormat: entry.bodyFormat ?? 'text',
        variant: entry.severity ?? 'default',
        // Sticky: an announcement is rare and must survive the user being away.
        // It cannot re-appear once dismissed because the id is recorded below.
        duration: 0,
        action: sanitizeAction(entry.action),
      })

      // Only a delivered announcement counts as shown. With the window closed
      // and no remote client attached the payload is dropped, and recording it
      // anyway would retire the entry without anyone ever reading it.
      if (!delivered) {
        console.log(`[Announcement] Deferred "${entry.id}" — no client received it`)
        continue
      }

      persisted.shown.push(entry.id)
      displayed++
      console.log(`[Announcement] Displayed "${entry.id}": ${entry.title}`)
    }

    if (displayed === 0) return 0

    if (persisted.shown.length > MAX_REMEMBERED_IDS) {
      persisted.shown = persisted.shown.slice(-MAX_REMEMBERED_IDS)
    }
    saveState()

    return displayed
  } catch (error) {
    console.error('[Announcement] Check failed:', error)
    return 0
  } finally {
    runningTick = false
  }
}

/**
 * Start the periodic announcement poll.
 *
 * Idempotent — calling twice replaces the existing timer. No-ops when the build
 * has no feed configured, which is the open-source default.
 */
export function startAnnouncementScheduler(opts?: { intervalMs?: number }): void {
  stopAnnouncementScheduler()

  const url = getAnnouncementsUrl()
  if (!url) {
    console.log('[Announcement] No feed configured, scheduler disabled')
    return
  }

  const intervalMs = opts?.intervalMs && opts.intervalMs > 0
    ? opts.intervalMs
    : DEFAULT_CHECK_INTERVAL_MS

  console.log(`[Announcement] Starting scheduler (interval=${intervalMs}ms, first run in ${FIRST_CHECK_DELAY_MS}ms)`)

  firstRunTimer = setTimeout(() => {
    void checkAnnouncementsNow()
  }, FIRST_CHECK_DELAY_MS)

  timer = setInterval(() => {
    void checkAnnouncementsNow()
  }, intervalMs)
}

/** Stop the periodic announcement poll. */
export function stopAnnouncementScheduler(): void {
  if (firstRunTimer) {
    clearTimeout(firstRunTimer)
    firstRunTimer = null
  }
  if (timer) {
    clearInterval(timer)
    timer = null
    console.log('[Announcement] Scheduler stopped')
  }
}
