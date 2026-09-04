/**
 * Email MCP — CalDAV Client
 *
 * Handles calendar operations via CalDAV protocol.
 * Stateless HTTP client — each request is independent with Basic auth.
 *
 * The CalDAV URL is configured via `config.caldavUrl` (supports {host} and {email}
 * placeholders).
 */

import https from 'https'
import type { EmailChannelConfig } from '../../../shared/types/notification-channels'

// ============================================
// Types
// ============================================

export interface CalendarEvent {
  uid: string
  summary: string
  description: string
  start: string
  end: string
  location: string
  organizer: string
  attendees: EventAttendee[]
  status: string
  categories: string[]
}

export interface EventAttendee {
  name: string
  email: string
  status: string
}

export interface CreateEventOptions {
  summary: string
  start: string
  end: string
  description?: string
  location?: string
  attendees?: string[]
  reminderMinutes?: number
}

// ============================================
// CalDAV Client
// ============================================

export class CalDavClient {
  private config: EmailChannelConfig
  private calendarUrl: string
  private authHeader: string
  private agent: https.Agent

  constructor(config: EmailChannelConfig) {
    this.config = config
    const email = config.smtp.user
    const host = config.smtp.host

    this.calendarUrl = (config.caldavUrl || '')
      .replace(/\{host\}/g, host)
      .replace(/\{email\}/g, email)

    this.authHeader = 'Basic ' + Buffer.from(`${email}:${config.smtp.password}`).toString('base64')

    const tlsOptions: Record<string, unknown> = { rejectUnauthorized: false }
    if (config.tlsCiphers) {
      tlsOptions.ciphers = config.tlsCiphers
    }
    this.agent = new https.Agent(tlsOptions)
  }

  /** Whether CalDAV is available (caldavUrl must be configured) */
  get available(): boolean {
    return this.calendarUrl.length > 0
  }

  /**
   * List calendar events within a date range.
   */
  async listEvents(startDate: string, endDate: string): Promise<CalendarEvent[]> {
    const startUTC = toUTCCalendarFormat(startDate)
    const endUTC = toUTCCalendarFormat(endDate, true)

    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${startUTC}" end="${endUTC}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`

    console.log(`[EmailMCP][CalDAV] Listing events from ${startDate} to ${endDate}`)

    const response = await this.request('REPORT', this.calendarUrl, body, { 'Depth': '1' })
    return parseCalDavResponse(response)
  }

  /**
   * Create a new calendar event.
   */
  async createEvent(options: CreateEventOptions): Promise<string> {
    const { randomUUID } = await import('crypto')
    const uid = randomUUID()
    const icsContent = buildICalEvent(uid, options, this.config.smtp.user)
    const eventUrl = `${this.calendarUrl}${uid}.ics`

    console.log(`[EmailMCP][CalDAV] Creating event: uid=${uid}, summary="${options.summary}"`)

    await this.request('PUT', eventUrl, icsContent, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'If-None-Match': '*',
    })

    return uid
  }

  /**
   * Delete a calendar event by UID.
   */
  async deleteEvent(uid: string): Promise<void> {
    const eventUrl = `${this.calendarUrl}${uid}.ics`
    console.log(`[EmailMCP][CalDAV] Deleting event: uid=${uid}`)
    await this.request('DELETE', eventUrl)
  }

  /**
   * Send an HTTP request to the CalDAV server.
   */
  private async request(
    method: string,
    url: string,
    body?: string,
    extraHeaders?: Record<string, string>
  ): Promise<string> {
    const headers: Record<string, string> = {
      'Authorization': this.authHeader,
      'Content-Type': 'application/xml; charset=utf-8',
      ...extraHeaders,
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body || undefined,
      // @ts-expect-error - Node.js fetch supports agent option
      agent: this.agent,
    })

    // Accept 200, 201, 204, 207 (Multi-Status) as success
    if (response.status >= 200 && response.status < 300 || response.status === 207) {
      return await response.text()
    }

    const errorText = await response.text().catch(() => '')
    throw new Error(`CalDAV ${method} failed: HTTP ${response.status} ${response.statusText}. ${errorText.slice(0, 200)}`)
  }
}

// ============================================
// iCalendar Builder
// ============================================

function buildICalEvent(uid: string, options: CreateEventOptions, organizerEmail: string): string {
  const now = new Date()
  const dtstamp = toICalDateTime(now)
  const dtstart = toICalDateTime(parseLocalDateTime(options.start))
  const dtend = toICalDateTime(parseLocalDateTime(options.end))

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Halo//Email MCP//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=Asia/Shanghai:${dtstart}`,
    `DTEND;TZID=Asia/Shanghai:${dtend}`,
    `SUMMARY:${escapeICalText(options.summary)}`,
    `ORGANIZER;CN=${organizerEmail}:mailto:${organizerEmail}`,
  ]

  if (options.description) {
    lines.push(`DESCRIPTION:${escapeICalText(options.description)}`)
  }
  if (options.location) {
    lines.push(`LOCATION:${escapeICalText(options.location)}`)
  }

  // Add attendees
  if (options.attendees?.length) {
    for (const email of options.attendees) {
      lines.push(`ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${email}`)
    }
  }

  // Add reminder
  const reminderMinutes = options.reminderMinutes ?? 15
  if (reminderMinutes > 0) {
    lines.push('BEGIN:VALARM')
    lines.push('ACTION:DISPLAY')
    lines.push('DESCRIPTION:Reminder')
    lines.push(`TRIGGER:-PT${reminderMinutes}M`)
    lines.push('END:VALARM')
  }

  lines.push('END:VEVENT')
  lines.push('END:VCALENDAR')

  return lines.join('\r\n')
}

// ============================================
// iCalendar Parser (Simple)
// ============================================

function parseCalDavResponse(xmlResponse: string): CalendarEvent[] {
  const events: CalendarEvent[] = []

  // Extract all calendar-data CDATA blocks from the XML
  const calDataRegex = /<c:calendar-data[^>]*>([\s\S]*?)<\/c:calendar-data>/gi
  let match: RegExpExecArray | null

  while ((match = calDataRegex.exec(xmlResponse)) !== null) {
    const icsData = decodeXmlEntities(match[1].trim())
    const event = parseVEvent(icsData)
    if (event) {
      events.push(event)
    }
  }

  // Also try the pattern without namespace prefix
  const calDataRegex2 = /<cal:calendar-data[^>]*>([\s\S]*?)<\/cal:calendar-data>/gi
  while ((match = calDataRegex2.exec(xmlResponse)) !== null) {
    const icsData = decodeXmlEntities(match[1].trim())
    const event = parseVEvent(icsData)
    if (event && !events.find(e => e.uid === event.uid)) {
      events.push(event)
    }
  }

  return events
}

function parseVEvent(icsData: string): CalendarEvent | null {
  const veventMatch = icsData.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/)
  if (!veventMatch) return null
  const vevent = veventMatch[1]

  const uid = extractICalProp(vevent, 'UID')
  if (!uid) return null

  const summary = extractICalProp(vevent, 'SUMMARY') || ''
  const description = extractICalProp(vevent, 'DESCRIPTION') || ''
  const location = extractICalProp(vevent, 'LOCATION') || ''
  const status = extractICalProp(vevent, 'STATUS') || 'confirmed'

  // Parse dates
  const dtstart = extractICalDateProp(vevent, 'DTSTART')
  const dtend = extractICalDateProp(vevent, 'DTEND')

  // Parse organizer
  const organizerLine = extractICalLine(vevent, 'ORGANIZER')
  const organizer = organizerLine
    ? (organizerLine.match(/mailto:(.+)/i)?.[1] || organizerLine)
    : ''

  // Parse attendees
  const attendees = parseAttendees(vevent)

  // Parse categories
  const categoriesStr = extractICalProp(vevent, 'CATEGORIES')
  const categories = categoriesStr ? categoriesStr.split(',').map(c => c.trim()) : []

  return {
    uid,
    summary: unescapeICalText(summary),
    description: unescapeICalText(description),
    start: dtstart,
    end: dtend,
    location: unescapeICalText(location),
    organizer,
    attendees,
    status: status.toLowerCase(),
    categories,
  }
}

function extractICalProp(vevent: string, prop: string): string | null {
  // Match property with possible parameters (e.g., DTSTART;TZID=...)
  const regex = new RegExp(`^${prop}(?:;[^:]*)?:(.*)$`, 'm')
  const match = vevent.match(regex)
  return match ? unfoldICalLine(match[1].replace(/\r/g, '').trim()) : null
}

function extractICalDateProp(vevent: string, prop: string): string {
  const value = extractICalProp(vevent, prop)
  if (!value) return ''
  return formatICalDate(value)
}

function extractICalLine(vevent: string, prop: string): string | null {
  const regex = new RegExp(`^${prop}(?:;[^:]*)?:(.*)$`, 'm')
  const match = vevent.match(regex)
  return match ? match[1].replace(/\r/g, '').trim() : null
}

function parseAttendees(vevent: string): EventAttendee[] {
  const attendees: EventAttendee[] = []
  const regex = /^ATTENDEE(;[^:]*)?:(.*)$/gm
  let match: RegExpExecArray | null

  while ((match = regex.exec(vevent)) !== null) {
    const params = (match[1] || '').replace(/\r/g, '')
    const value = match[2].replace(/\r/g, '').trim()

    const email = value.match(/mailto:(.+)/i)?.[1] || value
    const name = params.match(/CN=([^;]*)/)?.[1] || email
    const partstat = params.match(/PARTSTAT=([^;]*)/)?.[1] || 'NEEDS-ACTION'

    attendees.push({
      name: name.replace(/"/g, ''),
      email,
      status: partstat.toLowerCase().replace(/-/g, '-'),
    })
  }

  return attendees
}

// ============================================
// Date/Time Helpers
// ============================================

/**
 * Convert "YYYY-MM-DD" to CalDAV time-range format "YYYYMMDDTHHMMSSZ".
 * Directly parses the string — no Date object, no timezone shift.
 * If isEnd is true, uses the next day (exclusive upper bound).
 */
function toUTCCalendarFormat(dateStr: string, isEnd = false): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  if (isEnd) {
    // Create a date to handle month/year rollover, then extract parts
    const next = new Date(Date.UTC(y, m - 1, d + 1))
    const ny = next.getUTCFullYear()
    const nm = (next.getUTCMonth() + 1).toString().padStart(2, '0')
    const nd = next.getUTCDate().toString().padStart(2, '0')
    return `${ny}${nm}${nd}T000000Z`
  }
  return `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}T000000Z`
}

/**
 * Parse "YYYY-MM-DD HH:MM" to Date.
 */
function parseLocalDateTime(str: string): Date {
  // Handle format "2026-04-15 10:00"
  const [datePart, timePart] = str.split(' ')
  const [year, month, day] = datePart.split('-').map(Number)
  const [hours, minutes] = (timePart || '00:00').split(':').map(Number)
  return new Date(year, month - 1, day, hours, minutes)
}

/**
 * Convert Date to iCalendar local datetime format "YYYYMMDDTHHMMSS".
 */
function toICalDateTime(date: Date): string {
  const y = date.getFullYear()
  const m = (date.getMonth() + 1).toString().padStart(2, '0')
  const d = date.getDate().toString().padStart(2, '0')
  const h = date.getHours().toString().padStart(2, '0')
  const min = date.getMinutes().toString().padStart(2, '0')
  const s = date.getSeconds().toString().padStart(2, '0')
  return `${y}${m}${d}T${h}${min}${s}`
}

/**
 * Format an iCalendar date value (YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ)
 * to "YYYY-MM-DD HH:MM".
 */
function formatICalDate(value: string): string {
  // Remove Z suffix if present
  const clean = value.replace(/Z$/, '')
  if (clean.length < 13) return value

  const year = clean.slice(0, 4)
  const month = clean.slice(4, 6)
  const day = clean.slice(6, 8)
  const hour = clean.slice(9, 11)
  const minute = clean.slice(11, 13)

  return `${year}-${month}-${day} ${hour}:${minute}`
}

// ============================================
// Text Helpers
// ============================================

function escapeICalText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

function unescapeICalText(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

function unfoldICalLine(line: string): string {
  return line.replace(/\r?\n[ \t]/g, '')
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#13;/g, '')     // strip XML-encoded \r (carriage return)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}
