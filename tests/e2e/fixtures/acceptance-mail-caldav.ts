import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

type Account = 'primary' | 'control'
type Failure = 'none' | 'auth' | 'transport'
interface Credentials { user: string; password: string }
export interface CalendarReceipt { method: string; account?: Account; uid?: string; authorized: boolean; status: number }

function uidSafe(value: string) { return /^[a-zA-Z0-9_-]{1,100}$/.test(value) }
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const textValue = (value: string) => value.replace(/\\([nN,;\\])/g, (_match, escaped: string) => /n/i.test(escaped) ? '\n' : escaped)

export function parseFixtureCalendar(bytes: Buffer) {
  const lines = bytes.toString('utf8').replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const stack: string[] = []
  const fields = new Map<string, Array<{ parameters: string; value: string }>>()
  let events = 0
  for (const line of lines) {
    if (line.startsWith('BEGIN:')) { const component = line.slice(6); stack.push(component); if (component === 'VEVENT') events++; continue }
    if (line.startsWith('END:')) { if (stack.pop() !== line.slice(4)) throw new Error('The fixture received unbalanced iCalendar components'); continue }
    if (stack.at(-1) !== 'VEVENT') continue
    const separator = line.indexOf(':')
    if (separator < 1) throw new Error('The fixture received an invalid iCalendar property')
    const descriptor = line.slice(0, separator)
    const semicolon = descriptor.indexOf(';')
    const name = (semicolon < 0 ? descriptor : descriptor.slice(0, semicolon)).toUpperCase()
    const property = { parameters: semicolon < 0 ? '' : descriptor.slice(semicolon + 1), value: textValue(line.slice(separator + 1)) }
    fields.set(name, [...(fields.get(name) ?? []), property])
  }
  if (events !== 1 || stack.length || lines[0] !== 'BEGIN:VCALENDAR') throw new Error('The fixture requires one complete calendar event')
  const required = (name: string) => {
    const values = fields.get(name)
    if (values?.length !== 1) throw new Error(`The fixture requires exactly one ${name} property`)
    return values[0]
  }
  return {
    uid: required('UID').value,
    summary: required('SUMMARY').value,
    start: required('DTSTART'), end: required('DTEND'),
    description: fields.get('DESCRIPTION')?.[0].value ?? '',
    location: fields.get('LOCATION')?.[0].value ?? '',
    organizer: fields.get('ORGANIZER')?.[0].value ?? '',
    attendees: (fields.get('ATTENDEE') ?? []).map(value => value.value),
  }
}

export async function startAcceptanceCalDav(options: { directory: string; accounts: Record<Account, Credentials>; recipients: string[] }) {
  for (const credentials of Object.values(options.accounts)) {
    if (!/^[a-z0-9._+-]+@[a-z0-9.-]+\.test$/i.test(credentials.user) || !credentials.password.startsWith('local-only-')) throw new Error('Calendar fixtures require generated credentials and synthetic .test identities')
  }
  if (!options.recipients.length || options.recipients.some(address => !/^[a-z0-9._+-]+@[a-z0-9.-]+\.test$/i.test(address))) throw new Error('Calendar attendees must be explicitly owned .test identities')
  const recipients = new Set(options.recipients.map(address => `mailto:${address.toLowerCase()}`))
  const directory = join(options.directory, 'caldav')
  mkdirSync(directory)
  for (const account of ['primary', 'control']) mkdirSync(join(directory, account))
  const requests: CalendarReceipt[] = []
  const errors: string[] = []
  const sockets = new Set<Socket>()
  let failure: Failure = 'none'
  let closing = false
  const readEvents = (account: Account) => readdirSync(join(directory, account)).filter(file => file.endsWith('.ics')).sort()
    .map(file => ({ uid: file.slice(0, -4), bytes: readFileSync(join(directory, account, file)) }))
  const server = createServer(async (request, response) => {
    let route: RegExpMatchArray | null
    try { route = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.match(/^\/calendars\/(primary|control)\/(?:([a-zA-Z0-9_-]{1,100})\.ics)?$/) }
    catch { request.resume(); response.writeHead(400).end('Invalid isolated calendar URL'); return }
    const account = route?.[1] as Account | undefined
    const uid = route?.[2]
    const basic = request.headers.authorization?.match(/^Basic ([a-zA-Z0-9+/=]+)$/)?.[1]
    const decoded = basic ? Buffer.from(basic, 'base64').toString('utf8') : ''
    const allowed = account && decoded === `${options.accounts[account].user}:${options.accounts[account].password}`
    const receipt: CalendarReceipt = { method: request.method ?? '', account, uid, authorized: Boolean(allowed && failure !== 'auth'), status: 0 }
    requests.push(receipt)
    const finish = (status: number, body = '', type = 'text/plain') => {
      receipt.status = status
      response.writeHead(status, { 'Content-Type': type }).end(body)
    }
    if (!route) { request.resume(); finish(404, 'Unknown isolated calendar resource'); return }
    if (!receipt.authorized) { request.resume(); finish(401, 'Synthetic calendar authentication refusal'); return }
    if (failure === 'transport') { request.resume(); finish(503, 'Synthetic temporary calendar refusal'); return }
    try {
      if (request.method === 'REPORT' && !uid) {
        request.resume()
        const records = readEvents(account!).map(event => `<d:response><d:href>/calendars/${account}/${event.uid}.ics</d:href><d:propstat><d:prop><d:getetag>"${createHash('sha256').update(event.bytes).digest('hex')}"</d:getetag><c:calendar-data>${xml(event.bytes.toString('utf8'))}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')
        finish(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${records}</d:multistatus>`, 'application/xml')
      } else if (request.method === 'GET' && uid) {
        const file = join(directory, account!, `${uid}.ics`)
        if (!existsSync(file)) finish(404, 'The isolated calendar event does not exist')
        else finish(200, readFileSync(file, 'utf8'), 'text/calendar')
      } else if (request.method === 'PUT' && uid) {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 1024 * 1024) { finish(413, 'The isolated calendar request is too large'); return }
          chunks.push(Buffer.from(chunk))
        }
        const bytes = Buffer.concat(chunks)
        let event: ReturnType<typeof parseFixtureCalendar>
        try { event = parseFixtureCalendar(bytes) } catch { finish(400, 'The isolated calendar received an invalid event'); return }
        if (event.uid !== uid) { finish(409, 'The calendar path and event UID differ'); return }
        if (event.organizer !== `mailto:${options.accounts[account!].user}` || event.attendees.some(address => !recipients.has(address.toLowerCase()))) {
          finish(403, 'The event is outside the owned account and attendee scope'); return
        }
        const file = join(directory, account!, `${uid}.ics`)
        if (request.headers['if-none-match'] !== '*' || existsSync(file)) { finish(412, 'Conditional creation requires a new event'); return }
        writeFileSync(file + '.tmp', bytes)
        renameSync(file + '.tmp', file)
        finish(201)
      } else if (request.method === 'DELETE' && uid) {
        const file = join(directory, account!, `${uid}.ics`)
        if (!existsSync(file)) finish(404, 'The isolated calendar event does not exist')
        else { unlinkSync(file); finish(204) }
      } else { request.resume(); finish(405, 'The isolated calendar does not support that operation') }
    } catch (error) {
      errors.push(`Calendar fixture failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`)
      if (!response.headersSent) finish(500, 'The isolated calendar could not complete the request')
      else response.destroy()
    }
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  server.on('error', (error: NodeJS.ErrnoException) => { if (!closing) errors.push(`Calendar listener failed: ${error.code ?? 'unknown'}`) })
  const port = (server.address() as AddressInfo).port
  return {
    requests, errors, readEvents,
    url(account: Account) { return `http://127.0.0.1:${port}/calendars/${account}/` },
    setFailure(value: Failure) { failure = value },
    seedEvent(account: Account, uid: string, bytes: Buffer) {
      if (!uidSafe(uid) || parseFixtureCalendar(bytes).uid !== uid) throw new Error('Calendar seed requires a matching safe UID')
      writeFileSync(join(directory, account, `${uid}.ics`), bytes, { flag: 'wx' })
    },
    async close() {
      if (closing) return
      closing = true
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

export type AcceptanceCalDav = Awaited<ReturnType<typeof startAcceptanceCalDav>>
