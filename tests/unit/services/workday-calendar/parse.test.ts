/**
 * Which days a "mainland China working days only" schedule runs on: the
 * calendar's marked holidays and make-up workdays decide, Monday to Friday
 * fills in the rest, and a year the calendar has not published is never read
 * as a working year.
 */

import { describe, expect, it } from 'vitest'
import { parseHolidayCalendar, workdayStatus } from '../../../../src/main/services/workday-calendar/parse'

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261001',
  'DTEND;VALUE=DATE:20261008',
  'SUMMARY:National Day',
  // Folded: the marker's value continues on the next line.
  'X-APPLE-SPECIAL-DAY:WORK-',
  ' HOLIDAY',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261010',
  'DTEND;VALUE=DATE:20261011',
  'SUMMARY:Make-up workday',
  'X-APPLE-SPECIAL-DAY:ALTERNATE-WORKDAY',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260920',
  'SUMMARY:Make-up workday',
  'X-APPLE-SPECIAL-DAY:ALTERNATE-WORKDAY',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261023',
  'DTEND;VALUE=DATE:20261024',
  'SUMMARY:Frost descent',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20270101',
  'DTEND;VALUE=DATE:20270102',
  'SUMMARY:New Year festival, arrangements not published yet',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const day = (year: number, month: number, date: number) => new Date(year, month - 1, date, 9, 0)

describe('parseHolidayCalendar', () => {
  it('reads holiday ranges up to their exclusive end and make-up workdays, and nothing unmarked', () => {
    expect(parseHolidayCalendar(ICS)).toEqual({
      holidays: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'],
      workdays: ['2026-09-20', '2026-10-10'],
    })
  })
})

describe('workdayStatus', () => {
  const data = parseHolidayCalendar(ICS)

  it('does not run on a holiday that falls on a weekday', () => {
    expect(workdayStatus(data, day(2026, 10, 1))).toBe('day_off')
    expect(workdayStatus(data, day(2026, 10, 7))).toBe('day_off')
  })

  it('runs again the day after the holiday ends', () => {
    expect(workdayStatus(data, day(2026, 10, 8))).toBe('workday')
  })

  it('runs on a make-up workday that falls on a weekend', () => {
    expect(workdayStatus(data, day(2026, 10, 10))).toBe('workday')
    expect(workdayStatus(data, day(2026, 9, 20))).toBe('workday')
  })

  it('goes by the day of the week otherwise, ignoring unmarked festivals and solar terms', () => {
    expect(workdayStatus(data, day(2026, 10, 11))).toBe('day_off')
    expect(workdayStatus(data, day(2026, 10, 12))).toBe('workday')
    expect(workdayStatus(data, day(2026, 10, 23))).toBe('workday')
  })

  it('treats a year without published arrangements as not covered, not as working days', () => {
    expect(workdayStatus(data, day(2027, 1, 4))).toBe('not_covered')
  })

  it('treats a missing calendar as not covered', () => {
    expect(workdayStatus(null, day(2026, 10, 12))).toBe('not_covered')
  })
})
