/**
 * Session-affinity headers carry the per-conversation session id that upstream
 * channel-affinity routing (halo cloud gateway) uses to pin a conversation to a
 * stable channel+key, keeping the prompt cache warm. The two SDKs name it
 * differently:
 *   - Claude Code SDK: x-claude-code-session-id
 *   - Codex SDK:        session_id  (mirrors the request body's prompt_cache_key)
 *
 * The OpenAI-conversion path (chat_completions / responses) rebuilds a minimal
 * header set from provider config only, so without this allowlist these headers
 * never reach upstream and affinity silently degrades to per-request routing.
 * The anthropic_passthrough path forwards all SDK headers already and does not
 * need this.
 *
 * Allowlist — not passthrough — so the conversion path stays closed by default:
 * only these two header names cross over, nothing else from the SDK request.
 */
const SESSION_AFFINITY_HEADERS = new Set(['x-claude-code-session-id', 'session_id'])

/**
 * Extract the session-affinity headers from an SDK header map (Express lowercases
 * incoming header names). Returns canonical lowercase keys; upstream and the
 * gateway read them case-insensitively.
 */
export function pickSessionAffinityHeaders(
  sdkHeaders?: Record<string, string>
): Record<string, string> {
  if (!sdkHeaders) return {}
  const picked: Record<string, string> = {}
  for (const [key, value] of Object.entries(sdkHeaders)) {
    if (value && SESSION_AFFINITY_HEADERS.has(key.toLowerCase())) {
      picked[key.toLowerCase()] = value
    }
  }
  return picked
}
