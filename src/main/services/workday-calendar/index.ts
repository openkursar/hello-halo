/**
 * The mainland China working-day calendar behind "working days only" schedules.
 *
 * Downloaded from the build's calendar address (`product.json`
 * `workdayCalendarUrl`) through the user's proxy settings, at most once a day
 * and with a conditional request, and kept on this machine; each day is then
 * decided locally from that copy. Nothing is downloaded until a digital human
 * uses the option.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getHaloDir } from '../../foundation/config.service'
import { getWorkdayCalendarUrl } from '../../foundation/product-config'
import { proxyFetch } from '../proxy-fetch'
import { parseHolidayCalendar, workdayStatus, type WorkdayCalendarData, type WorkdayStatus } from './parse'

export type { WorkdayStatus } from './parse'

const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000
/** A schedule due every minute must not mean a download attempt every minute while offline. */
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000
/** How long a run waits for the very first download before deciding without it. */
const FIRST_DOWNLOAD_WAIT_MS = 15_000
/**
 * A request a proxy or middlebox leaves hanging must end: until it does no
 * other download is attempted, so the copy would never refresh again.
 */
const DOWNLOAD_TIMEOUT_MS = 30_000
/** The public calendar is under 100 KB; a mistyped address must not pull a large file into memory. */
const MAX_CALENDAR_BYTES = 2 * 1024 * 1024

interface StoredCalendar extends WorkdayCalendarData {
  url: string
  etag?: string
  fetchedAt: number
}

/** Undefined until the copy on disk has been read. */
let stored: StoredCalendar | null | undefined
let refreshing: Promise<void> | null = null
let failedAt = 0

function storePath(): string {
  return join(getHaloDir(), 'workday-calendar.json')
}

function isStoredCalendar(value: unknown): value is StoredCalendar {
  const calendar = value as Partial<StoredCalendar> | null
  return !!calendar && typeof calendar.url === 'string' && typeof calendar.fetchedAt === 'number'
    && Array.isArray(calendar.holidays) && Array.isArray(calendar.workdays)
}

function load(): StoredCalendar | null {
  if (stored !== undefined) return stored
  try {
    const parsed: unknown = existsSync(storePath()) ? JSON.parse(readFileSync(storePath(), 'utf8')) : null
    if (parsed !== null && !isStoredCalendar(parsed)) console.warn('[WorkdayCalendar] The copy on this machine has an unknown shape; downloading again')
    stored = isStoredCalendar(parsed) ? parsed : null
  } catch (error) {
    console.warn('[WorkdayCalendar] The copy on this machine is unreadable; downloading again', error)
    stored = null
  }
  return stored
}

function save(calendar: StoredCalendar): void {
  stored = calendar
  try {
    const path = storePath()
    writeFileSync(`${path}.tmp`, JSON.stringify(calendar))
    renameSync(`${path}.tmp`, path)
  } catch (error) {
    console.warn('[WorkdayCalendar] Could not keep the calendar on this machine', error)
  }
}

async function download(url: string, etag: string | undefined): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await proxyFetch(url, {
      ...(etag ? { headers: { 'If-None-Match': etag } } : {}),
      signal: controller.signal,
    })
    const current = load()
    if (response.status === 304 && current) {
      save({ ...current, fetchedAt: Date.now() })
      return
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const size = Number(response.headers.get('content-length') ?? 0)
    if (size > MAX_CALENDAR_BYTES) throw new Error(`the calendar is too large (${size} bytes)`)
    const text = await response.text()
    if (text.length > MAX_CALENDAR_BYTES) throw new Error(`the calendar is too large (${text.length} characters)`)
    const data = parseHolidayCalendar(text)
    // A feed with no marked day at all has most likely changed format: keeping
    // the last good copy beats answering every day from nothing.
    if (data.holidays.length === 0 && data.workdays.length === 0) {
      throw new Error('the calendar lists no holiday or make-up workday; its format may have changed')
    }
    save({ url, etag: response.headers.get('etag') ?? undefined, fetchedAt: Date.now(), ...data })
    console.log(`[WorkdayCalendar] Updated: holidays=${data.holidays.length} makeUpWorkdays=${data.workdays.length}`)
  } catch (error) {
    failedAt = Date.now()
    console.warn('[WorkdayCalendar] Download failed; the copy on this machine is kept', { url, error })
  } finally {
    clearTimeout(timeout)
  }
}

/** Download the calendar again when the copy is a day old or came from another address. */
export function refreshWorkdayCalendar(): Promise<void> {
  const url = getWorkdayCalendarUrl()
  if (!url) return Promise.resolve()
  const current = load()
  const sameSource = current?.url === url
  if (current && sameSource && Date.now() - current.fetchedAt < REFRESH_AFTER_MS) return Promise.resolve()
  if (!refreshing && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return Promise.resolve()
  refreshing ??= download(url, sameSource ? current?.etag : undefined).finally(() => { refreshing = null })
  return refreshing
}

/**
 * Whether `date` is a working day. A day-old copy is refreshed in the
 * background and still answers; only with no copy at all does this wait for
 * the first download (bounded), so a schedule enabled just now is not reported
 * as uncovered.
 */
export async function workdayStatusOn(date: Date): Promise<WorkdayStatus> {
  const url = getWorkdayCalendarUrl()
  if (!url) return 'not_covered'
  const pending = refreshWorkdayCalendar()
  if (load()?.url !== url) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, FIRST_DOWNLOAD_WAIT_MS) })])
    clearTimeout(timer)
  }
  const copy = load()
  return workdayStatus(copy?.url === url ? copy : null, date)
}
