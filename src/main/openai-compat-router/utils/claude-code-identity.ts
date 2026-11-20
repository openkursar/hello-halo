/**
 * How Halo presents itself as Claude Code on the wire.
 *
 * Anthropic gates access to some models on the reported Claude Code version and
 * reads it from two independent places: the `user-agent` header, and the
 * `cc_version` field of the attribution line that sits in the system prompt.
 * Covering only the header leaves the other one reporting whatever version the
 * spawned CLI happens to be, so both derive from the single pin here.
 */

import { createHash } from 'node:crypto'

/** Fixed version; adjust as needed. */
export const CLAUDE_CODE_VERSION = '2.1.290'

export const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`

/** Constant across installs; changing it changes the value on every request. */
const FINGERPRINT_SALT = '59cf53e54c78'

const ATTRIBUTION_PREFIX = 'x-anthropic-billing-header:'

/** `cc_version=<version>.<fingerprint>`, terminated by the field separator. */
const CC_VERSION_FIELD = /cc_version=([^;]*)/

type IdentityMessage = { role: string; content: unknown }

/**
 * The user-agent to send upstream in place of the caller's. A non-Claude-Code
 * user-agent passes through; any Claude Code one reports the pin, whatever
 * version it carried.
 */
export function resolveClaudeCodeUserAgent(userAgent: string | undefined): string {
  if (userAgent && !userAgent.startsWith('claude-cli/')) return userAgent
  return CLAUDE_CODE_USER_AGENT
}

/**
 * The text the fingerprint is derived from: the first user message, or its
 * first text block when the content is structured.
 */
export function extractFirstUserMessageText(
  messages: ReadonlyArray<IdentityMessage>,
): string {
  const userMsg = messages.find(m => m.role === 'user')
  if (!userMsg) return ''
  const content = userMsg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (b: Record<string, unknown>) => b.type === 'text',
    )
    if (textBlock && typeof (textBlock as Record<string, unknown>).text === 'string') {
      return (textBlock as Record<string, unknown>).text as string
    }
  }
  return ''
}

/** The 3-hex-digit fingerprint Claude Code appends to its version. */
export function computeAttributionFingerprint(
  firstUserMessageText: string,
  version: string,
): string {
  const chars = [4, 7, 20].map(i => firstUserMessageText[i] || '0').join('')
  return createHash('sha256')
    .update(`${FINGERPRINT_SALT}${chars}${version}`)
    .digest('hex')
    .slice(0, 3)
}

/** `<version>.<fingerprint>` — the value of the `cc_version` field. */
function buildCcVersion(firstUserMessageText: string): string {
  return `${CLAUDE_CODE_VERSION}.${computeAttributionFingerprint(firstUserMessageText, CLAUDE_CODE_VERSION)}`
}

/**
 * The line the Claude Code CLI opens its system prompt with. Which wording it
 * writes depends on how it was launched, so the match is the shape, not a list.
 */
const CLAUDE_CODE_IDENTITY_LINE = /^You are (?:Claude Code|a Claude agent)\b[^\n]{0,200}?\./

function stripIdentityLine(text: string): string | null {
  if (!text.startsWith('You are ')) return null
  const match = CLAUDE_CODE_IDENTITY_LINE.exec(text)
  return match ? text.slice(match[0].length).trimStart() : null
}

/**
 * Remove that opening line from the first system message of an OpenAI-format
 * request, in place; a message left empty is dropped. For upstreams whose
 * prompts carry no engine identity.
 *
 * Returns whether the body changed.
 */
export function stripClaudeCodeIdentity(body: Record<string, unknown>): boolean {
  const messages = body.messages
  if (!Array.isArray(messages)) return false
  const system = messages[0] as { role?: unknown; content?: unknown } | undefined
  if (system?.role !== 'system') return false

  const { content } = system
  if (typeof content === 'string') {
    const rest = stripIdentityLine(content)
    if (rest === null) return false
    if (rest) system.content = rest
    else messages.shift()
    return true
  }

  if (!Array.isArray(content)) return false
  for (let i = 0; i < content.length; i++) {
    const part = content[i] as { type?: unknown; text?: unknown } | null
    if (part?.type !== 'text' || typeof part.text !== 'string') continue
    const rest = stripIdentityLine(part.text)
    if (rest === null) continue
    if (rest) part.text = rest
    else content.splice(i, 1)
    if (content.length === 0) messages.shift()
    return true
  }
  return false
}

/** The whole attribution line, for callers that own the system prompt. */
export function buildAttributionLine(firstUserMessageText: string): string {
  return `${ATTRIBUTION_PREFIX} cc_version=${buildCcVersion(firstUserMessageText)}; cc_entrypoint=cli; cch=00000;`
}

/**
 * Re-stamp an existing attribution line with the pinned version, leaving every
 * other field the producer set (entrypoint, workload, …) untouched.
 *
 * Returns null when `text` is not an attribution line or already carries the
 * pinned value — the caller can then leave the request byte-identical.
 */
export function rewriteAttributionVersion(
  text: string,
  firstUserMessageText: string,
): string | null {
  if (!text.startsWith(ATTRIBUTION_PREFIX)) return null
  const current = CC_VERSION_FIELD.exec(text)
  if (!current) return null

  const next = buildCcVersion(firstUserMessageText)
  if (current[1] === next) return null
  return text.replace(CC_VERSION_FIELD, `cc_version=${next}`)
}
