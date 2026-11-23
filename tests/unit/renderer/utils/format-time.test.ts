/**
 * A list formats a time per row, so the formatters are built once and reused;
 * what a row says must not change for it — same text, same time zone.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatRunStart } from '../../../../src/renderer/utils/format-time'

const TIME = { hour: '2-digit', minute: '2-digit' } as const
const DAY = { month: '2-digit', day: '2-digit' } as const

/** How every row wrote its time before the formatters were reused. */
function written(timestamp: number, now: number, locale?: string): string {
  const date = new Date(timestamp)
  const time = date.toLocaleTimeString(locale, TIME)
  if (new Date(now).toDateString() === date.toDateString()) return time
  return `${date.toLocaleDateString(locale, DAY)} ${time}`
}

const NOW = new Date(2026, 10, 23, 21, 30).getTime()
const ZONE = process.env.TZ

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (ZONE === undefined) delete process.env.TZ
  else process.env.TZ = ZONE
})

describe('formatRunStart', () => {
  it('writes today and earlier days exactly as before, in the system language and in each app language', () => {
    const times = [
      new Date(2026, 10, 23, 9, 5).getTime(),
      new Date(2026, 10, 23, 0, 0).getTime(),
      new Date(2026, 10, 22, 23, 59).getTime(),
      new Date(2026, 0, 4, 14, 7).getTime(),
      new Date(2025, 6, 30, 6, 45).getTime(),
    ]
    for (const locale of [undefined, 'en', 'zh-CN', 'zh-TW', 'ja', 'es', 'fr', 'de']) {
      for (const timestamp of times) {
        expect(formatRunStart(timestamp, NOW, locale)).toBe(written(timestamp, NOW, locale))
      }
    }
    expect(formatRunStart(times[0], NOW, 'en')).not.toContain('/')
    expect(formatRunStart(times[3], NOW, 'en')).toContain('/')
  })

  it('builds its formatters once for a list, not once per row', () => {
    const built = vi.spyOn(Intl, 'DateTimeFormat')
    const rows = Array.from({ length: 200 }, (_, index) => NOW - index * 3_600_000)
    const text = rows.map(timestamp => formatRunStart(timestamp, NOW, 'ko'))
    expect(text).toEqual(rows.map(timestamp => written(timestamp, NOW, 'ko')))
    // Its two formatters, and at most one look at the system's time zone.
    expect(built.mock.calls.filter(args => args.length > 0)).toHaveLength(2)
    expect(built.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('follows a change of the system time zone within a second, as the date it compares with does', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const times = [Date.UTC(2026, 9, 13, 10, 0), Date.UTC(2026, 2, 27, 12, 0), Date.UTC(2026, 2, 29, 1, 30), Date.UTC(2026, 9, 25, 0, 30)]
    let clock = times[0]
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Europe/Athens', 'Asia/Jerusalem', 'UTC']) {
      process.env.TZ = zone
      clock += 1_000
      vi.setSystemTime(clock)
      for (const timestamp of times) {
        expect(formatRunStart(timestamp, clock, 'en'), `${zone} ${new Date(timestamp).toISOString()}`).toBe(written(timestamp, clock, 'en'))
      }
    }
  })

  it('tells apart zones that share winter and summer offsets but change their clocks on different days', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const timestamp = Date.UTC(2026, 2, 27, 12, 0)
    vi.setSystemTime(timestamp)
    process.env.TZ = 'Europe/Athens'
    expect(formatRunStart(timestamp, timestamp, 'en')).toBe('02:00 PM')
    process.env.TZ = 'Asia/Jerusalem'
    vi.setSystemTime(timestamp + 1_000)
    expect(formatRunStart(timestamp, timestamp + 1_000, 'en')).toBe('03:00 PM')
    expect(formatRunStart(timestamp, timestamp + 1_000, 'en')).toBe(written(timestamp, timestamp + 1_000, 'en'))
  })

  it('still reads an unreadable time as it did, without throwing', () => {
    expect(formatRunStart(Number.NaN, NOW, 'en')).toBe(written(Number.NaN, NOW, 'en'))
  })
})
