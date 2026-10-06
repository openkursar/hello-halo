/**
 * Reading a mainland China holiday calendar (iCalendar) and deciding a day.
 *
 * Only events carrying the source's special-day marker count: a holiday range
 * (`WORK-HOLIDAY`, DTEND exclusive) or a make-up workday (`ALTERNATE-WORKDAY`).
 * Display text is never read; the solar terms and festivals the same feed
 * carries have no marker and drop out on their own.
 */

/** The days that differ from Monday-to-Friday, as YYYY-MM-DD. */
export interface WorkdayCalendarData {
  /** Days off that would otherwise be workdays. */
  holidays: string[]
  /** Weekend days that are workdays. */
  workdays: string[]
}

/**
 * - `workday` / `day_off`: decided from the calendar.
 * - `not_covered`: the calendar says nothing authoritative about the day's
 *   year (not yet published, or no calendar at all); never read as a workday.
 */
export type WorkdayStatus = 'workday' | 'day_off' | 'not_covered'

const SPECIAL_DAY_FIELD = 'X-APPLE-SPECIAL-DAY'

export function parseHolidayCalendar(ics: string): WorkdayCalendarData {
  const holidays = new Set<string>()
  const workdays = new Set<string>()
  // Long lines are folded onto continuation lines that start with a space or tab.
  const lines = ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  let event: Map<string, string> | null = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      event = new Map()
      continue
    }
    if (line === 'END:VEVENT') {
      if (event) collect(event, holidays, workdays)
      event = null
      continue
    }
    if (!event) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const name = line.slice(0, colon).split(';')[0].toUpperCase()
    event.set(name, line.slice(colon + 1).trim())
  }
  return { holidays: [...holidays].sort(), workdays: [...workdays].sort() }
}

function collect(event: Map<string, string>, holidays: Set<string>, workdays: Set<string>): void {
  const kind = event.get(SPECIAL_DAY_FIELD)
  const target = kind === 'WORK-HOLIDAY' ? holidays : kind === 'ALTERNATE-WORKDAY' ? workdays : null
  const start = parseDate(event.get('DTSTART'))
  if (!target || !start) return
  const end = parseDate(event.get('DTEND')) ?? new Date(start.getTime() + DAY_MS)
  for (let day = start; day < end; day = new Date(day.getTime() + DAY_MS)) target.add(dayKey(day))
}

const DAY_MS = 24 * 60 * 60 * 1000

/** An all-day date (YYYYMMDD) as UTC midnight. */
function parseDate(value: string | undefined): Date | null {
  const match = value?.match(/^(\d{4})(\d{2})(\d{2})/)
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null
}

function dayKey(utcMidnight: Date): string {
  return utcMidnight.toISOString().slice(0, 10)
}

/** `date`'s calendar day on this machine, as YYYY-MM-DD. */
export function localDayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * A year counts as covered only once it lists a holiday or make-up workday: a
 * year whose arrangements are not published yet still carries its festivals,
 * and reading it as "no holidays" would run straight through them.
 */
export function workdayStatus(data: WorkdayCalendarData | null, date: Date): WorkdayStatus {
  if (!data) return 'not_covered'
  const key = localDayKey(date)
  const year = key.slice(0, 4)
  if (!data.holidays.some(day => day.startsWith(year)) && !data.workdays.some(day => day.startsWith(year))) {
    return 'not_covered'
  }
  if (data.holidays.includes(key)) return 'day_off'
  if (data.workdays.includes(key)) return 'workday'
  const weekday = date.getDay()
  return weekday === 0 || weekday === 6 ? 'day_off' : 'workday'
}
