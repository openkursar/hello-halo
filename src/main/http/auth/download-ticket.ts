/**
 * Download tickets: what a download link carries instead of the access token.
 *
 * A link handed to the phone's browser, or kept in a browser's download list,
 * must not hold the long-lived token that controls this computer. A ticket is
 * bound to one file and lasts two minutes, good for every request in that time
 * (the app's web view and then the system browser both fetch the link). Tickets
 * live in memory only, so a restart voids them.
 */

import { randomBytes } from 'crypto'

const TICKET_TTL_MS = 120_000
const MAX_TICKETS = 256
const TICKET_PATH = /^\/api\/artifacts\/file\/[A-Za-z0-9_-]{43}$/

const tickets = new Map<string, { filePath: string; expiresAt: number }>()

export function issueDownloadTicket(filePath: string): string {
  const now = Date.now()
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(ticket)
  }
  // A Map iterates in insertion order, so the oldest go first.
  while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value as string)
  const ticket = randomBytes(32).toString('base64url')
  tickets.set(ticket, { filePath, expiresAt: now + TICKET_TTL_MS })
  return ticket
}

/** The file a ticket opens, or null once it is unknown or expired. */
export function redeemDownloadTicket(ticket: string): string | null {
  const entry = tickets.get(ticket)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    tickets.delete(ticket)
    return null
  }
  return entry.filePath
}

/** A ticket link is its own credential: the API gate admits it without a token. */
export function isDownloadTicketPath(path: string): boolean {
  return TICKET_PATH.test(path)
}
