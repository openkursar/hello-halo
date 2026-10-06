/**
 * The working-day calendar on this machine: downloaded once, kept across
 * restarts, checked again at most once a day, and never replaced by a failed
 * or unrecognisable download. Without a calendar no day counts as a workday.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const CALENDAR_URL = 'https://calendar.example/cn.ics'
const HOUR = 60 * 60 * 1000
const T0 = new Date(2026, 9, 6, 8, 0).getTime()

const env = vi.hoisted(() => ({ dir: '', url: undefined as string | undefined }))
const proxyFetch = vi.hoisted(() => vi.fn())

vi.mock('../../../../src/main/foundation/config.service', () => ({ getHaloDir: () => env.dir }))
vi.mock('../../../../src/main/foundation/product-config', () => ({ getWorkdayCalendarUrl: () => env.url }))
vi.mock('../../../../src/main/services/proxy-fetch', () => ({ proxyFetch: (...args: unknown[]) => proxyFetch(...args) }))

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261001',
  'DTEND;VALUE=DATE:20261008',
  'X-APPLE-SPECIAL-DAY:WORK-HOLIDAY',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261010',
  'X-APPLE-SPECIAL-DAY:ALTERNATE-WORKDAY',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

function calendarResponse(body: string, etag = '"v1"') {
  return { ok: true, status: 200, headers: { get: (name: string) => name.toLowerCase() === 'etag' ? etag : null }, text: async () => body }
}

function statusResponse(status: number) {
  return { ok: false, status, headers: { get: () => null }, text: async () => '' }
}

const day = (month: number, date: number) => new Date(2026, month - 1, date, 9, 0)

/** The module as a freshly started Halo sees it: only the copy on disk survives. */
async function start() {
  vi.resetModules()
  return await import('../../../../src/main/services/workday-calendar')
}

beforeEach(() => {
  env.dir = mkdtempSync(join(tmpdir(), 'halo-workday-calendar-'))
  env.url = CALENDAR_URL
  proxyFetch.mockReset()
  vi.useFakeTimers({ now: T0, toFake: ['Date'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(env.dir, { recursive: true, force: true })
})

describe('workday calendar', () => {
  it('waits for the first download, then decides every day from the copy it keeps', async () => {
    proxyFetch.mockResolvedValue(calendarResponse(ICS))
    let calendar = await start()

    expect(await calendar.workdayStatusOn(day(10, 1))).toBe('day_off')
    expect(await calendar.workdayStatusOn(day(10, 10))).toBe('workday')
    expect(proxyFetch).toHaveBeenCalledTimes(1)

    calendar = await start()
    expect(await calendar.workdayStatusOn(day(10, 7))).toBe('day_off')
    expect(proxyFetch).toHaveBeenCalledTimes(1)
  })

  it('checks a day-old copy with its ETag and keeps it when nothing changed', async () => {
    proxyFetch.mockResolvedValueOnce(calendarResponse(ICS, '"v1"'))
    const calendar = await start()
    await calendar.workdayStatusOn(day(10, 1))

    vi.setSystemTime(T0 + 25 * HOUR)
    proxyFetch.mockResolvedValueOnce(statusResponse(304))
    expect(await calendar.workdayStatusOn(day(10, 1))).toBe('day_off')
    await calendar.refreshWorkdayCalendar()

    expect(proxyFetch).toHaveBeenLastCalledWith(CALENDAR_URL, { headers: { 'If-None-Match': '"v1"' } })
    expect(await calendar.workdayStatusOn(day(10, 10))).toBe('workday')
    expect(proxyFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the copy when a download fails, and does not try again at every due time', async () => {
    proxyFetch.mockResolvedValueOnce(calendarResponse(ICS))
    const calendar = await start()
    await calendar.workdayStatusOn(day(10, 1))

    vi.setSystemTime(T0 + 25 * HOUR)
    proxyFetch.mockResolvedValue(statusResponse(503))
    await calendar.refreshWorkdayCalendar()
    expect(await calendar.workdayStatusOn(day(10, 1))).toBe('day_off')
    expect(await calendar.workdayStatusOn(day(10, 10))).toBe('workday')
    expect(proxyFetch).toHaveBeenCalledTimes(2)

    vi.setSystemTime(T0 + 26 * HOUR)
    await calendar.refreshWorkdayCalendar()
    expect(proxyFetch).toHaveBeenCalledTimes(3)
  })

  it('does not replace the copy with a calendar that marks no day, whose format has likely changed', async () => {
    proxyFetch.mockResolvedValueOnce(calendarResponse(ICS))
    const calendar = await start()
    await calendar.workdayStatusOn(day(10, 1))

    vi.setSystemTime(T0 + 25 * HOUR)
    proxyFetch.mockResolvedValueOnce(calendarResponse('BEGIN:VCALENDAR\r\nEND:VCALENDAR', '"v2"'))
    await calendar.refreshWorkdayCalendar()

    expect(await calendar.workdayStatusOn(day(10, 1))).toBe('day_off')
  })

  it('leaves every day uncovered when no calendar can be had', async () => {
    proxyFetch.mockResolvedValue(statusResponse(503))
    const calendar = await start()

    expect(await calendar.workdayStatusOn(day(10, 12))).toBe('not_covered')
  })

  it('downloads nothing when the build provides no calendar address', async () => {
    env.url = undefined
    const calendar = await start()

    expect(await calendar.workdayStatusOn(day(10, 12))).toBe('not_covered')
    expect(proxyFetch).not.toHaveBeenCalled()
  })

  it('does not answer for a new address from the copy of the old one', async () => {
    proxyFetch.mockResolvedValueOnce(calendarResponse(ICS))
    let calendar = await start()
    await calendar.workdayStatusOn(day(10, 1))

    env.url = 'https://intranet.example/cn.ics'
    proxyFetch.mockResolvedValueOnce(statusResponse(404))
    calendar = await start()

    expect(await calendar.workdayStatusOn(day(10, 12))).toBe('not_covered')
    expect(proxyFetch).toHaveBeenLastCalledWith('https://intranet.example/cn.ics', undefined)
  })

  it('stops waiting for a first download that hangs and leaves the day uncovered', async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ now: T0, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    proxyFetch.mockReturnValue(new Promise(() => {}))
    const calendar = await start()

    const status = calendar.workdayStatusOn(day(10, 12))
    await vi.advanceTimersByTimeAsync(15_000)

    expect(await status).toBe('not_covered')
  })
})
