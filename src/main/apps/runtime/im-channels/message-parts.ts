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
 * inside one). A code block a cut lands in is closed at the end of its part and
 * reopened at the start of the next, so both halves still render as code.
 */

/** What one platform message can carry. A part must satisfy every limit set. */
export interface MessageLimit {
  /** UTF-8 bytes. */
  maxBytes?: number
  /** Characters as JavaScript counts them (UTF-16 code units). */
  maxChars?: number
}

/** Kept free in every part for its label; "(999/999)\n\n" takes 11. */
const LABEL_RESERVE = 16

const FENCE = '```'
const FENCE_CLOSE = `\n${FENCE}`

/**
 * The messages `text` needs on a platform with `limit`: the text itself when
 * it fits, otherwise its parts in order, each labeled and each within the
 * limit with its label.
 */
export function splitIntoMessages(text: string, limit: MessageLimit): string[] {
  if (fits(text, limit)) return [text]

  const room = shrink(limit, LABEL_RESERVE, LABEL_RESERVE)
  const bodies: string[] = []
  let rest = text
  let reopen: string | null = null
  while (rest.length > 0) {
    const prefix = reopen === null ? '' : `${reopen}\n`
    if (fits(prefix + rest, room)) {
      bodies.push(prefix + rest)
      break
    }
    const part = rest.slice(0, cutPoint(rest, shrinkBy(room, prefix + FENCE_CLOSE)))
    reopen = openFenceAfter(part, reopen)
    bodies.push(prefix + part + (reopen === null ? '' : closeFence(part)))
    rest = rest.slice(part.length)
  }
  return bodies.map((body, i) => `(${i + 1}/${bodies.length})\n\n${body}`)
}

/**
 * Send `text` through `sendOne` as {@link splitIntoMessages} parts, in order —
 * each once the one before it has settled, so they arrive in sequence. Every
 * part is attempted even when one before it failed (a gap reads better than
 * losing the rest); resolves whether all of them went out.
 */
export async function sendAsMessages(
  text: string,
  limit: MessageLimit,
  sendOne: (message: string, index: number) => Promise<boolean>,
): Promise<boolean> {
  let allSent = true
  const messages = splitIntoMessages(text, limit)
  for (let i = 0; i < messages.length; i++) {
    if (!(await sendOne(messages[i], i))) allSent = false
  }
  return allSent
}

/**
 * {@link sendAsMessages} for a sender that throws when a message does not go
 * out: every part is still attempted, then the first failure is rethrown.
 */
export async function sendAsMessagesOrThrow(
  text: string,
  limit: MessageLimit,
  sendOne: (message: string, index: number) => Promise<void>,
): Promise<void> {
  const failures: unknown[] = []
  await sendAsMessages(text, limit, async (message, index) => {
    try {
      await sendOne(message, index)
      return true
    } catch (err) {
      failures.push(err)
      return false
    }
  })
  if (failures.length > 0) throw failures[0]
}

/**
 * As much of `text` as one message with `limit` carries, cut where
 * {@link splitIntoMessages} would end its first part — for a surface that
 * shows the beginning of a long answer in place and the whole of it in parts.
 */
export function messageHead(text: string, limit: MessageLimit): string {
  if (fits(text, limit)) return text
  const head = text.slice(0, cutPoint(text, shrinkBy(limit, FENCE_CLOSE)))
  return openFenceAfter(head, null) === null ? head : head + closeFence(head)
}

// ── Internals ─────────────────────────────────────────────────────

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

/**
 * Where the first part of `text` ends: the furthest character boundary within
 * `limit`, moved back to a break from {@link BREAKS} when one is in reach.
 * Always advances by at least one character.
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

  for (const { separator, reach } of BREAKS) {
    const after = text.lastIndexOf(separator, end - separator.length) + separator.length
    if (after >= separator.length && after <= end && after >= end * (1 - reach)) return after
  }
  return end
}

/** The code block still open after `part` (its opening line), or null. */
function openFenceAfter(part: string, openAtStart: string | null): string | null {
  let open = openAtStart
  for (const line of part.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith(FENCE)) continue
    open = open === null ? trimmed : null
  }
  return open
}

function closeFence(part: string): string {
  return part.endsWith('\n') ? FENCE : FENCE_CLOSE
}
