import { COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR } from '../../../shared/constants/agent-errors'

type Translate = (key: string) => string

/** What a failed turn's error looks like on a card: one readable reason, with the raw text kept behind a toggle. */
export interface AgentErrorSummary {
  text: string
  /** The raw error says more than `text` does. */
  expandable: boolean
}

const PREVIEW_CHARS = 400
/** Provider errors wrap each other (a gateway quoting the upstream's body); read through at most this many layers. */
const MAX_NESTING = 3

// An object opening with a quoted key — `{ in position 3` in a parser message is not a payload.
const JSON_START = /\{\s*"/
// Read without parsing so a payload cut short by a length cap still yields its reason.
// `error` alone is often a code (`"error":"unauthorized"`), so it only counts when nothing says more.
const REASON_FIELDS = [
  /"(?:message|msg|detail)"\s*:\s*"((?:[^"\\]|\\.)*)/,
  /"error"\s*:\s*"((?:[^"\\]|\\.)*)/,
]

/** A known English failure in the interface language, anything else as it came. */
export function agentErrorText(error: string, t: Translate): string {
  if (error === COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR) {
    return t('Command execution environment not installed. Please restart the app and complete setup, or install manually in settings.')
  }
  return error
}

function decodeJsonString(escaped: string): string {
  for (const candidate of [escaped, escaped.replace(/\\u[0-9a-fA-F]{0,3}$/, '')]) {
    try {
      return JSON.parse(`"${candidate}"`)
    } catch {
      // A cut-short escape sequence; the next candidate drops it.
    }
  }
  return escaped
}

function readableReason(text: string, depth = 0): string | null {
  const start = text.search(JSON_START)
  if (start < 0) return null
  const payload = text.slice(start)
  const field = REASON_FIELDS.map(pattern => pattern.exec(payload)).find(match => match?.[1]?.trim())
  if (!field) return null
  const reason = decodeJsonString(field[1]).trim()
  if (!reason) return null
  return (depth < MAX_NESTING ? readableReason(reason, depth + 1) : null) ?? reason
}

/** The one-line reason a card shows for a turn's error; the raw text stays reachable through `formatAgentErrorDetail`. */
export function describeAgentError(error: string, t: Translate): AgentErrorSummary {
  const known = agentErrorText(error, t)
  if (known !== error) return { text: known, expandable: false }

  const payloadStart = error.search(JSON_START)
  const head = payloadStart >= 0 ? error.slice(0, payloadStart).replace(/[\s:]+$/, '') : ''
  const text = payloadStart >= 0 ? (readableReason(error) ?? (head || error)) : error
  const clipped = text.length > PREVIEW_CHARS
  return {
    text: clipped ? `${text.slice(0, PREVIEW_CHARS)}…` : text,
    expandable: payloadStart >= 0 || clipped,
  }
}

/** The raw error with an embedded JSON payload indented; unchanged when there is none or it does not parse. */
export function formatAgentErrorDetail(error: string): string {
  const start = error.search(JSON_START)
  const end = error.lastIndexOf('}')
  if (start < 0 || end < start) return error
  try {
    const payload = JSON.stringify(JSON.parse(error.slice(start, end + 1)), null, 2)
    return [error.slice(0, start).trimEnd(), payload, error.slice(end + 1).trim()].filter(Boolean).join('\n')
  } catch {
    return error
  }
}
