/**
 * The mainland China working-day calendar behind "working days only" schedules.
 *
 * Downloaded from the build's calendar address (`product.json`
 * `workdayCalendarUrl`) through the user's proxy settings, at most once a day
 * and with a conditional request, and kept on this machine; each day is then
 * decided locally from that copy. Nothing is downloaded until a digital human
 * uses the option.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
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

function load(): StoredCalendar | null {
  if (stored !== undefined) return stored
  try {
    stored = existsSync(storePath()) ? JSON.parse(readFileSync(storePath(), 'utf8')) as StoredCalendar : null
  } catch (error) {
    console.warn('[WorkdayCalendar] The copy on this machine is unreadable; downloading again', error)
    stored = null
  }
  return stored
}

function save(calendar: StoredCalendar): void {
  stored = calendar
  try {
    writeFileSync(storePath(), JSON.stringify(calendar))
  } catch (error) {
    console.warn('[WorkdayCalendar] Could not keep the calendar on this machine', error)
  }
}

async function download(url: string, etag: string | undefined): Promise<void> {
  try {
    const response = await proxyFetch(url, etag ? { headers: { 'If-None-Match': etag } } : undefined)
    const current = load()
    if (response.status === 304 && current) {
      save({ ...current, fetchedAt: Date.now() })
      return
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = parseHolidayCalendar(await response.text())
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
