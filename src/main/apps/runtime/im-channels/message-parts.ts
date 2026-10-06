/**
 * apps/runtime/im-channels -- A long message as parts that fit one platform message
 *
 * Every platform caps a single message. A reply past the cap goes out as
 * several, in order, each labeled `(i/n)` so the reader knows more is coming
 * and how the parts read in sequence. What the cap is belongs to each provider —
 * its platform's limit, in the unit that platform counts — and generic code
 * never shortens a reply on a provider's behalf. How a long message is cut is
 * shared, so every channel cuts the same way: at a paragraph break near the
 * cap, else a line break, else a space, else between two characters (never
 * inside one, nor inside an emoji sequence). A code block a cut lands in is
 * closed at the end of its part and reopened at the start of the next, so both
 * halves still render as code.
 *
 * How many parts a chat gets is shared too ({@link MAX_PARTS}), and so is what
 * happens when one does not go out: the rest is held back and the chat is told
 * where to read the whole reply. The person-facing notes are Chinese, like the
 * channels' other notices: the backend has no renderer i18n.
 */

/** What one platform message can carry. A part must satisfy every limit set. */
export interface MessageLimit {
  /** UTF-8 bytes. */
  maxBytes?: number
  /** Characters as JavaScript counts them (UTF-16 code units). */
  maxChars?: number
}

/** How a send is identified: messages to one chat go out one reply at a time. */
export interface MessageRoute {
  /** The chat, unique across bots (e.g. `${instanceId}:${chatId}`); also names it in logs. */
  chat?: string
}

/**
 * The most parts one reply is sent in. Past ten messages a chat is the wrong
 * place to read it, and every channel's own burst limit sits well above this
 * (the strictest, WeCom's 30 messages a minute per chat, leaves room for the
 * acknowledgements around a reply) — so one number serves all of them and a
 * provider needs none of its own.
 */
export const MAX_PARTS = 10

/** Kept free in every part for its label; "(999/999)\n\n" takes 11. */
const LABEL_RESERVE = 16

/** Kept free in every part for closing a code block a cut lands in. */
const FENCE_CLOSE_RESERVE = 16

/** Ends the last part sent when a reply needs more than {@link MAX_PARTS}. */
const REST_IN_HALO_NOTE = '\n\n（内容过长，其余部分请在 Halo 里查看）'

/** Sent in place of the parts held back after part `k` failed. */
function failedPartNote(k: number): string {
  return `回复的第 ${k} 条发送失败，完整内容请在 Halo 里查看`
}

/**
 * The messages `text` needs on a platform with `limit`: the text itself when
 * it fits, otherwise its parts in order, each labeled and each within the
 * limit with its label — at most {@link MAX_PARTS}, the last of them then
 * saying the rest is in Halo.
 */
export function splitIntoMessages(text: string, limit: MessageLimit): string[] {
  if (fits(text, limit)) return [text]

  const room = shrink(limit, LABEL_RESERVE, LABEL_RESERVE)
  const bodies: string[] = []
  let rest = text
  let reopen: Fence | null = null
  while (rest.trim().length > 0) {
    const prefix = reopen === null ? '' : `${reopen.line}\n`
    if (fits(prefix + rest, room)) {
      bodies.push(prefix + rest)
      break
    }
    const last = bodies.length === MAX_PARTS - 1
    const space = shrink(room, Buffer.byteLength(prefix, 'utf8') + FENCE_CLOSE_RESERVE, prefix.length + FENCE_CLOSE_RESERVE)
    const part = takePart(rest, last ? shrinkBy(space, REST_IN_HALO_NOTE) : space, reopen)
    const open = openFenceAfter(part, reopen)
    const body = prefix + part + (open === null ? '' : closeFence(part, open))
    if (last) {
      bodies.push(body + REST_IN_HALO_NOTE)
      break
    }
    bodies.push(body)
    reopen = open
    rest = rest.slice(part.length)
  }
  return bodies.map((body, i) => `(${i + 1}/${bodies.length})\n\n${body}`)
}

/**
 * Send `text` through `sendOne` as {@link splitIntoMessages} parts, in order —
 * each once the one before it has settled, so they arrive in sequence, and
 * after any earlier reply to the same `route.chat` has finished, so two long
 * replies never interleave. When a part does not go out, the rest is held back
 * (a reply with a hole in it reads as whole) and the chat is told, best effort,
 * to read the reply in Halo. Resolves whether every part went out.
 */
export function sendAsMessages(
  text: string,
  limit: MessageLimit,
  sendOne: (message: string, index: number) => Promise<boolean>,
  route: MessageRoute = {},
): Promise<boolean> {
  return oneReplyAtATime(route.chat, async () => {
    const messages = splitIntoMessages(text, limit)
    for (let i = 0; i < messages.length; i++) {
      if (await sendOne(messages[i], i)) continue
      if (messages.length === 1) return false
      console.warn(
        `${LOG_TAG} Part ${i + 1}/${messages.length} to ${route.chat ?? 'a chat'} not sent; ` +
        `holding back the rest`
      )
      const told = await sendOne(failedPartNote(i + 1), i).catch(() => false)
      if (!told) console.warn(`${LOG_TAG} The note about the missing parts did not go out either`)
      return false
    }
    return true
  })
}

/**
 * {@link sendAsMessages} for a sender that throws when a message does not go
 * out: the first failure is rethrown once the chat has been told.
 */
export async function sendAsMessagesOrThrow(
  text: string,
  limit: MessageLimit,
  sendOne: (message: string, index: number) => Promise<void>,
  route: MessageRoute = {},
): Promise<void> {
  const failures: unknown[] = []
  const sent = await sendAsMessages(text, limit, async (message, index) => {
    try {
      await sendOne(message, index)
      return true
    } catch (err) {
      failures.push(err)
      return false
    }
  }, route)
  if (!sent) throw failures[0]
}

/**
 * As much of `text` as one message with `limit` carries, cut where
 * {@link splitIntoMessages} would end its first part — for a surface that
 * shows the beginning of a long answer in place and the whole of it in parts.
 */
export function messageHead(text: string, limit: MessageLimit): string {
  if (fits(text, limit)) return text
  const head = takePart(text, shrink(limit, FENCE_CLOSE_RESERVE, FENCE_CLOSE_RESERVE), null)
  const open = openFenceAfter(head, null)
  return open === null ? head : head + closeFence(head, open)
}

// ── Internals ─────────────────────────────────────────────────────

const LOG_TAG = '[MessageParts]'

/** Each chat's reply still going out; the next one waits behind it. */
const replyInFlight = new Map<string, Promise<unknown>>()

function oneReplyAtATime<T>(chat: string | undefined, send: () => Promise<T>): Promise<T> {
  if (chat === undefined) return send()
  const sending = (replyInFlight.get(chat) ?? Promise.resolve()).then(send)
  const settled = sending.then(() => undefined, () => undefined)
  replyInFlight.set(chat, settled)
  void settled.then(() => {
    if (replyInFlight.get(chat) === settled) replyInFlight.delete(chat)
  })
  return sending
}

function fits(text: string, limit: MessageLimit): boolean {
  return (limit.maxChars === undefined || text.length <= limit.maxChars) &&
    (limit.maxBytes === undefined || Buffer.byteLength(text, 'utf8') <= limit.maxBytes)
}

function shrink(limit: MessageLimit, bytes: number, chars: number): MessageLimit {
  return {
    ...(limit.maxBytes === undefined ? {} : { maxBytes: limit.maxBytes - bytes }),
    ...(limit.maxChars === undefined ? {} : { maxChars: limit.maxChars - chars }),
  }
}

function shrinkBy(limit: MessageLimit, overhead: string): MessageLimit {
  return shrink(limit, Buffer.byteLength(overhead, 'utf8'), overhead.length)
}

/**
 * Where a part may end, best first, and how far back from the furthest point
 * that fits each is worth reaching for (as a share of that span): a paragraph
 * break only when near it, a line break or a space within the second half.
 */
const BREAKS: ReadonlyArray<{ separator: string; reach: number }> = [
  { separator: '\n\n', reach: 0.3 },
  { separator: '\n', reach: 0.5 },
  { separator: ' ', reach: 0.5 },
]

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * The first part of `text` within `limit`: cut at {@link cutPoint}, but never
 * right after the line that opens a code block — that would leave an empty
 * block at the end of this part — unless that line is all there is.
 */
function takePart(text: string, limit: MessageLimit, openAtStart: Fence | null): string {
  const part = text.slice(0, cutPoint(text, limit))
  const open = openFenceAfter(part, openAtStart)
  if (open === null || open === openAtStart || !part.endsWith(`${open.line}\n`)) return part
  const before = part.length - open.line.length - 1
  return before > 0 && openFenceAfter(part.slice(0, before), openAtStart) === null ? part.slice(0, before) : part
}

/**
 * Where the first part of `text` ends: the furthest character boundary within
 * `limit`, moved back to a break from {@link BREAKS} when one is in reach, else
 * to where a grapheme begins. Always advances by at least one character.
 */
function cutPoint(text: string, limit: MessageLimit): number {
  let end = 0
  let bytes = 0
  while (end < text.length) {
    const code = text.codePointAt(end)!
    const units = code > 0xffff ? 2 : 1
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (limit.maxChars !== undefined && end + units > limit.maxChars) break
    if (limit.maxBytes !== undefined && bytes + size > limit.maxBytes) break
    end += units
    bytes += size
  }
  if (end === 0) return text.codePointAt(0)! > 0xffff ? 2 : 1
  if (end >= text.length) return end

  for (const { separator, reach } of BREAKS) {
    const after = text.lastIndexOf(separator, end - separator.length) + separator.length
    if (after >= separator.length && after <= end && after >= end * (1 - reach)) return after
  }
  // Not inside a cluster: a split ZWJ sequence or skin-tone pair shows as two
  // broken glyphs. The window reaches past `end` so the cluster there is whole.
  const from = Math.max(0, end - 32)
  let start = end
  for (const { index } of graphemes.segment(text.slice(from, end + 32))) {
    if (from + index > end) break
    start = from + index
  }
  return start > 0 ? start : end
}

/** A code block that is open: its opening line, and the run that closes it. */
interface Fence {
  line: string
  marker: string
}

/** A line that opens or closes a code block: its fence run and info string. */
function fenceOf(line: string): { marker: string; info: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return null
  // A backtick fence's info string has no backticks: "```code```" is inline.
  if (match[1][0] === '`' && match[2].includes('`')) return null
  return { marker: match[1], info: match[2].trim() }
}

/** The code block still open after `part`, or null. */
function openFenceAfter(part: string, openAtStart: Fence | null): Fence | null {
  let open = openAtStart
  for (const line of part.split('\n')) {
    const fence = fenceOf(line)
    if (!fence) continue
    if (open === null) {
      open = { line: line.trimStart(), marker: fence.marker }
    } else if (fence.marker[0] === open.marker[0] && fence.marker.length >= open.marker.length && !fence.info) {
      open = null
    }
  }
  return open
}

function closeFence(part: string, open: Fence): string {
  return part.endsWith('\n') ? open.marker : `\n${open.marker}`
}
