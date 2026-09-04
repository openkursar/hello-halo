/**
 * apps/runtime/im-channels -- WeCom Identity Directory Fetch
 *
 * Wire-level client for WeCom's "message" permission capability
 * (message_aibot_sessions_list), used to recover real names for sender IDs
 * that WeCom otherwise delivers as opaque, encrypted strings (bots created
 * after WeCom's April 2026 anonymization change).
 *
 * This is a SEPARATE credential from the bot's own WebSocket connection
 * (botId/secret, handled by @wecom/aibot-node-sdk elsewhere in this
 * directory): it is a per-member "可使用权限" grant, authorized in the
 * WeCom client (Workspace -> Intelligent Bot -> Permissions -> Message),
 * that yields a streamableHTTP MCP endpoint URL of the form
 * `https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=...`.
 *
 * The endpoint speaks the MCP Streamable HTTP transport, not a plain REST
 * shape — this module opens a short-lived MCP client connection, calls the
 * `message_aibot_sessions_list` tool, and tears the connection down. No
 * persistent connection or session state is kept between calls (matches the
 * one-shot probe pattern in services/agent/mcp-probe.ts). apps/runtime is
 * allowed to depend on services/agent (see runtime/DESIGN.md §5), but that
 * file's client construction is threaded through app-bridge/mcp-manager
 * plumbing built for session-scoped agent MCP servers; reusing it here would
 * pull that in for what is otherwise three SDK calls, so this module builds
 * its own minimal client instead.
 *
 * The grant expires 7 days after authorization; WeCom reports this via
 * `errcode: 850003` in the tool's JSON payload (not an MCP protocol-level
 * error), which this module maps to {@link ImIdentityAuthExpiredError}.
 *
 * Errors are sanitized before they ever leave this module (see
 * sanitizeError): `apiKeyUrl` is a credential, and both the SDK's
 * "Invalid URL" errors and transport-level failures can otherwise echo the
 * full request URL — including the apikey query parameter — into an
 * exception message, which would then reach the caller's logs verbatim.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ImIdentityAuthExpiredError } from '../../../../shared/types/im-channel'

// ============================================
// Constants
// ============================================

const SESSIONS_LIST_TOOL = 'message_aibot_sessions_list'
const FETCH_TIMEOUT_MS = 15_000
/** errcode WeCom returns when the "message" capability grant has expired. */
const WECOM_AUTH_EXPIRED_ERRCODE = 850003

// ============================================
// Wire types (WeCom's message_aibot_sessions_list response shape)
// ============================================

interface WecomAibotSession {
  chat_id?: string
  chat_name?: string
  chat_type?: 'single' | 'group'
}

interface WecomAibotSessionsListResult {
  errcode?: number
  errmsg?: string
  sessions?: WecomAibotSession[]
}

// ============================================
// Public API
// ============================================

/**
 * Fetch WeCom's most-recent-sessions directory (up to 20 entries) via the
 * member-authorized "message" capability MCP endpoint.
 *
 * @param apiKeyUrl - Full streamableHTTP URL copied from the WeCom client
 *   (includes the apikey query parameter). Treat as a credential.
 * @returns Map of chat_id -> chat_name (only entries with both fields set).
 * @throws {@link ImIdentityAuthExpiredError} when the grant has expired.
 * @throws Error for any other failure (network, malformed response, ...).
 */
export async function fetchWecomIdentityDirectory(apiKeyUrl: string): Promise<Map<string, string>> {
  const client = new Client({ name: 'halo-wecom-identity-resolve', version: '1.0.0' })

  try {
    let transport: StreamableHTTPClientTransport
    try {
      transport = new StreamableHTTPClientTransport(new URL(apiKeyUrl))
    } catch (err) {
      // new URL() on a malformed value throws with the invalid input
      // embedded in the message — sanitize before it can propagate.
      throw sanitizeError(err, apiKeyUrl)
    }

    await withTimeout(client.connect(transport), 'connect')
    const result = await withTimeout(
      client.callTool({ name: SESSIONS_LIST_TOOL, arguments: {} }),
      'callTool',
    )
    return parseSessionsListResult(result)
  } catch (err) {
    if (err instanceof ImIdentityAuthExpiredError) throw err
    throw sanitizeError(err, apiKeyUrl)
  } finally {
    await client.close().catch(() => {})
  }
}

// ============================================
// Internal
// ============================================

/**
 * Race a promise against a fresh timeout window (each call gets its own —
 * two sequential calls sharing one timer would let the second silently
 * inherit whatever time the first already burned). Also attaches a no-op
 * catch to the original promise: if the timeout wins the race, `promise`
 * keeps running in the background and may reject later (e.g. a slow
 * connect that ultimately fails); without this, that late rejection would
 * have no handler and surface as an unhandled rejection in the main
 * process, well after this function has already returned/thrown.
 */
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`WeCom identity directory ${label} timed out`)),
      FETCH_TIMEOUT_MS,
    )
  })
  promise.catch(() => {})
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  })
}

/**
 * Strip the credential out of an error's message before it leaves this
 * module. Covers both the full URL string and the bare apikey value (the
 * latter in case only the query parameter, not the whole URL, ends up
 * echoed back by some failure path).
 */
function sanitizeError(err: unknown, credentialUrl: string): Error {
  let message = err instanceof Error ? err.message : String(err)
  message = message.split(credentialUrl).join('<redacted-url>')
  const apikeyValue = credentialUrl.match(/[?&]apikey=([^&]+)/i)?.[1]
  if (apikeyValue) {
    message = message.split(apikeyValue).join('<redacted>')
  }
  return new Error(message)
}

function parseSessionsListResult(result: unknown): Map<string, string> {
  const content = (result as { content?: unknown[] } | undefined)?.content
  const textBlock = Array.isArray(content)
    ? content.find(
        (block): block is { type: 'text'; text: string } =>
          typeof block === 'object' && block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string',
      )
    : undefined

  if (!textBlock) {
    throw new Error('WeCom identity directory response had no text content')
  }

  let parsed: WecomAibotSessionsListResult
  try {
    parsed = JSON.parse(textBlock.text)
  } catch {
    throw new Error('WeCom identity directory response was not valid JSON')
  }

  if (parsed.errcode === WECOM_AUTH_EXPIRED_ERRCODE) {
    throw new ImIdentityAuthExpiredError()
  }
  if (parsed.errcode !== undefined && parsed.errcode !== 0) {
    throw new Error(
      `WeCom identity directory request failed: errcode=${parsed.errcode} errmsg=${parsed.errmsg ?? ''}`,
    )
  }

  const directory = new Map<string, string>()
  for (const session of parsed.sessions ?? []) {
    if (session.chat_id && session.chat_name) {
      directory.set(session.chat_id, session.chat_name)
    }
  }
  return directory
}
