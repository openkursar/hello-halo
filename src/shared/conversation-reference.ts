/**
 * The textual form a conversation reference takes inside a message.
 *
 * The composer inserts this form directly, so what the user sees, what gets
 * persisted, and what the model reads are all the same string — no rewrite on
 * send, no annotation the transcript does not contain. That matters twice
 * over: a later reader of this conversation (another conversation calling
 * `conversation_read`) sees the same pointer the model saw, rather than a bare
 * title it would have to guess at all over again.
 *
 * Shape: `[#Title](conv:3a5d77ea)` — a markdown link, so a model reads it as a
 * reference without being told, and a renderer can decorate it without parsing
 * anything bespoke.
 *
 * The id is truncated to `SHORT_ID_LENGTH` for the same reason git shows short
 * SHAs: the full UUID is longer than most titles and the composer is a plain
 * textarea, so the untruncated form buries the sentence it sits in. A prefix
 * that matches more than one conversation is reported as ambiguous with the
 * full ids, never resolved by guessing.
 *
 * Lives in `shared/` because the composer writes this form and the main
 * process reads it; a second copy of the format on either side is a fork
 * waiting to drift.
 */

import { isAppChatKey } from './apps/im-keys'

export const CONVERSATION_REFERENCE_SCHEME = 'conv'

/** Hex characters of the conversation id kept in a reference. */
export const SHORT_ID_LENGTH = 8

/**
 * SHA-1 as lowercase hex. Only used to derive a reference handle, never for
 * security. Pure and synchronous so the composer (renderer) and the resolver
 * (main) compute the very same handle from the very same key.
 */
function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const bitLength = bytes.length * 8
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6
  const data = new Uint8Array(paddedLength)
  data.set(bytes)
  data[bytes.length] = 0x80
  const view = new DataView(data.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  const rotl = (x: number, n: number): number => (x << n) | (x >>> (32 - n))

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999 }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1 }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc }
      else { f = b ^ c ^ d; k = 0xca62c1d6 }
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0
      e = d
      d = c
      c = rotl(b, 30) >>> 0
      b = a
      a = temp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('')
}

/**
 * The handle a reference carries for a conversation. A space conversation's id
 * is a uuid, so its own first hex digits are already a good handle. A digital
 * human's conversation id is a structured key whose leading characters are
 * identical across all of them, so it is digested instead. A collision between
 * any two conversations is legal and resolved by the ambiguity flow.
 */
export function shortConversationId(conversationId: string): string {
  if (isAppChatKey(conversationId)) return sha1Hex(conversationId).slice(0, SHORT_ID_LENGTH)
  return conversationId.replace(/-/g, '').slice(0, SHORT_ID_LENGTH)
}

/** The exact text the composer inserts when a conversation is picked. */
export function formatConversationReference(title: string, conversationId: string): string {
  return `[#${title}](${CONVERSATION_REFERENCE_SCHEME}:${shortConversationId(conversationId)})`
}

/**
 * Strip the `conv:` scheme a model may have copied along with the id. Passing
 * the id bare is the documented shape, but copying the reference verbatim is
 * the obvious mistake to make, and failing on it would be a lookup error that
 * tells the caller nothing about what it did wrong.
 */
export function normalizeConversationTarget(target: string): string {
  const trimmed = target.trim()
  const prefix = `${CONVERSATION_REFERENCE_SCHEME}:`
  return trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed
}

/** True if `target` looks like a short id rather than a full id or a title. */
export function isShortConversationId(target: string): boolean {
  return new RegExp(`^[0-9a-f]{${SHORT_ID_LENGTH}}$`, 'i').test(target)
}

/** Longest a first-message preview stands in for a chat's missing name. */
export const CHAT_TITLE_PREVIEW_CHARS = 50

/**
 * The title a digital-human chat goes by: the digital human's name for its
 * default session, `Name: <label>` for a local one. The backend lists it under
 * this title and the composer names its reference with it, so both derive it
 * here — a reference that has to fall back to its title must still find the chat.
 * `untitled` is the caller's (localized) stand-in for a chat with no name and no message.
 */
export function digitalHumanChatTitle(
  chat: { name: string; isDefault: boolean; customName?: string; displayName?: string; lastMessage?: string },
  untitled: string
): string {
  if (chat.isDefault) return chat.name
  const label =
    chat.customName ||
    chat.displayName?.trim() ||
    (chat.lastMessage ? chat.lastMessage.slice(0, CHAT_TITLE_PREVIEW_CHARS) : '') ||
    untitled
  return `${chat.name}: ${label}`
}
