# AI Model Setup — Troubleshooting

Read this when the user reports a specific failure while configuring or using an AI source.
Every row below traces to the actual error-producing code, not a guess.

## Errors during a real chat turn (not Fetch Models / Test connection)

These come from the Claude Code SDK subprocess or the upstream provider while an actual message
is being sent — a different code path from §"Fetch Models" / §"Test connection" below, and it
does **not** classify errors the way those two do: `send-message.ts:280`
(`errorMessage = err.message || 'Unknown error...'`) uses the SDK's raw `error.message` almost
verbatim (the only exception is Windows Git Bash detection, `send-message.ts:282-293`, unrelated
to model config). So the exact text the user sees is whatever the provider/SDK produced, not a
Halo-authored message — treat it as a symptom to classify yourself, not a fixed string to match:

| Symptom (raw text, may vary by provider) | Likely cause | Fix |
|---|---|---|
| `fetch failed` | Network unreachable from the URL configured for the current source | Verify the source's API URL in Settings → AI Model, check network/proxy |
| `401` / `Unauthorized` / `invalid api key` | Current source's key/token is wrong or expired | Settings → AI Model → re-check the key, or re-login for OAuth |
| `429` / `rate limit` / `insufficient quota` | Provider-side rate limit or exhausted quota | Wait and retry, or switch to a different source (the radio button on any other source card) |
| `context length exceeded` / context-limit wording | The conversation exceeds the model's `contextWindow` (§5 of index.md) | Send `/compact`, or start a new conversation. If the model's real limit is higher than what Halo shows, the model capability preset may be wrong — check/raise `contextWindow` in the model's capability override panel |
| Error after an image was sent, and every message after it also fails | The current model's resolved `vision` capability is `false` (§5 of index.md) — the conversation now has an image block the model rejects on every subsequent turn, since context is cumulative | **Must start a new conversation** — the bad image block cannot be stripped from history. Before retrying, switch to a source/model whose `vision` is `true`, or correct the override if the model's real vision support is being misreported |
| `500` / `overloaded` / generic server error | Provider-side transient failure | Retry after a short wait |
| "There's an issue with the selected model (...). It may not exist or you may not have access to it." | Not necessarily a wrong model — this can be `CLAUDE_CONFIG_DIR/settings.json` holding a stale/bad value the CLI rejects at startup. `ensureSandboxSettings()` (`src/main/services/agent/sdk-config.ts:523-548`) only merges in `sandbox`/`skipWebFetchPreflight` keys and preserves everything else already in the file — it does not repair a bad `model`/other field | Verified-safe fix: close Halo, delete `settings.json` inside the Claude config dir, restart — `ensureSandboxSettings` recreates the file from scratch on next launch (confirmed by the `mkdirSync`+`existsSync` guard at lines 525-530). Default location is `resolveClaudeConfigDir()` (`src/main/foundation/config.service.ts:843-856`) → `app.getPath('userData')/claude-config/settings.json` unless the user changed `agent.configDirMode` to `cc` (`~/.claude`) or `custom` |

I could not verify in code why `settings.json` would end up holding a bad model field in the
first place (only that deleting-and-regenerating is a safe, code-confirmed recovery) — flag this
as unresolved root cause if the user hits it repeatedly.

## "Fetch Models" fails

Triggered by `fetchModelsFromApi` (`src/main/services/api-validator.service.ts:48-116`), which
calls the provider's `/v1/models` (or `/models`) endpoint and classifies the failure
(`src/shared/model-fetch-error.ts`). The renderer shows one of these exact messages
(`src/renderer/utils/model-fetch-error.ts:5-33`):

| Message shown | Underlying code | Root cause | Fix |
|---|---|---|---|
| "Invalid API Key or no permission" | `MODEL_FETCH_UNAUTHORIZED` (HTTP 401/403) | Wrong/expired key, or key lacks model-list permission | Re-check the key; some gateways issue separate keys per capability |
| "Endpoint not found, check the URL" | `MODEL_FETCH_NOT_FOUND` (HTTP 404) | Wrong base URL, or `/v1` was appended where it shouldn't be | See the URL-normalization note below |
| "Rate limited or out of quota" | `MODEL_FETCH_RATE_LIMITED` (HTTP 429) | Too many requests, or plan quota exhausted | Wait, or check the provider's dashboard |
| "Request timed out, check the server or proxy" | `MODEL_FETCH_TIMEOUT` | No response within 15s (`AbortSignal.timeout(15000)`, `api-validator.service.ts:86`) | Check proxy/VPN, or the gateway is down |
| "Cannot reach server, check network or proxy" | `MODEL_FETCH_NETWORK` (`TypeError`, ECONNREFUSED/ENOTFOUND/etc.) | DNS failure, connection refused, no network | Verify the URL is reachable at all (e.g. `curl`) |
| "Failed to fetch models" | `MODEL_FETCH_FAILED` (any other status, or empty list, or non-array response body) | Endpoint returned 200 but not an OpenAI-shaped `{data: [...]}`, or the array was empty | The provider isn't OpenAI-models-API-compatible; the user should pick a model manually via the "custom model ID" toggle instead of Fetch Models |

**URL-normalization gotcha** (`api-validator.service.ts:55-73`): the fetch logic strips known
suffixes (`/chat/completions`, `/completions`, `/responses`, `/v1/chat`) from whatever URL the
user typed, then appends `/v1` **unless** the URL already ends in a version segment
(`/v\d+$`) or already contains `/v1` or `/api/paas`. A gateway whose base URL already ends in
`/v4` (Zhipu Coding Plan pattern) is a real, previously-hit case — do not tell the user to append
`/v1` to such a URL; that produces `/v4/v1/models` → 404.

## "Test connection" fails

Triggered by `validateApiConnection` (`api-validator.service.ts:144-315`), which actually spins
up an SDK session and sends a one-turn "test" message. User-facing messages
(`api-validator.service.ts:290-307`):

| Message shown | Trigger |
|---|---|
| "Invalid API key" | Response/error contains `401`/`Unauthorized` |
| "Access denied - check API key permissions" | `403`/`Forbidden` |
| "API endpoint not found - check URL" | `404`/`Not Found` |
| "Rate limited - try again later" | `429`/`rate limit` |
| "Cannot connect to API server - check URL" | `ECONNREFUSED`/`ENOTFOUND` |
| "Connection timeout - server may be slow or unreachable" | `AbortError`, or message contains `aborted`/`timeout` (also the explicit 15s timeout at line 193-195) |
| "No response received from API" | The SDK session produced no `assistant`/`result` message at all before the stream ended — usually a provider that accepts the request but returns something the SDK can't parse |
| "Please select a model before testing the connection" | OpenAI-compat provider with no model chosen (`line 177-183`) — Anthropic-shaped providers fall back to a default model instead |

Test connection failing does **not** block Save — a user can save a broken config and only find
out via this tool or via real chat later. If a user says "I saved it and now chat doesn't work,"
run through this table using the actual error, don't assume it's the same class of problem as a
fetch-models failure (they hit different endpoints and can fail independently).

## Chat produces no reply at all (no error dialog)

`getBackendConfig()` (`src/main/services/ai-sources/manager.ts:213-299`) returns `null` — and
silently — when:
- `authType === 'api-key'` and `apiKey` is empty (line 229-232)
- `authType === 'oauth'` and `accessToken` is empty (line 233-236)
- The source's `provider` has no registered provider instance (line 241-244) — this happens if a
  closed-source module (`path`-loaded) failed to load; check `[AuthLoader]` log lines for a
  `loadError`

There is no toast for this — the chat pipeline simply has nothing to send. If "nothing happens
when I send a message" and Test connection was never run, walk the user through Test connection
first; it exercises the exact same `getBackendConfig` path plus a real network round trip.

## OAuth login seems stuck

- **Claude "waiting for login..."** — the dialog is polling `authCompleteLogin` after opening a
  browser window; if the window was closed without finishing, there is no separate cancel/retry
  signal — restart from clicking the provider card again (`AISourcesSection.tsx:204-267`).
- **GitHub Copilot / device-code flow stuck** — the user must actually visit the shown
  verification URL and enter the shown code on that page; Halo only polls for completion, it
  cannot detect "I didn't do it yet" vs. "I'm still doing it."
- **Delegated (Claude Code CLI) never activates** — `DelegatedLoginDialog` polls
  `authDelegatedStatus` every 2s and only proceeds once the *CLI's own* credential store reports
  signed-in (`readCliAuthState`) — a login run in a different terminal/shell that doesn't share
  the CLI's config directory will never be detected. On non-macOS this entire path is absent by
  design, not a bug to work around.

## "My provider disappeared from the list" / duplicate-looking sources

- **Zhipu Coding Plan (and any future multi-account provider)**: one OAuth login can create
  **multiple sources at once**, one per organization/account returned by the provider
  (`manager.ts:734-790`, matched by `user.uid`). This is expected — it is not a bug or a
  duplicate bug when a single login produces several cards.
- **A builtin gateway's model list looks "reset"**: `syncBuiltinModels()`
  (`manager.ts:945-992`, runs once at startup) only refreshes a source's model list when every
  model currently on it is a known builtin id — i.e. it never touches a list where the user has
  fetched their own custom models via "Fetch Models." If a user's custom-fetched list changed
  unexpectedly, this sync is **not** the cause; look elsewhere (e.g. they re-ran Fetch Models).
- **Deleting the current source**: `deleteSource()` (`manager.ts:557-578`) reassigns `currentId`
  to the first remaining source, or `null` if none are left — the UI has no separate "pick a new
  default" step, it just happens.

## Model capability panel shows a warning

- "No preset found — verify these values match your model" (amber, `ModelConfigPanel.tsx:274-279`):
  informational only. The fallback defaults (`contextWindow: 128_000, maxOutputTokens: 16_384,
  thinking: false`) are already applied and chat is not blocked. Tell the user to fill in real
  values only if they know them; leaving it alone is safe.
- `maxOutputTokens` warning about Claude Code auto-compact truncation
  (`ModelConfigPanel.tsx:366-374`): appears for any value `0 < value <
  RECOMMENDED_MIN_MAX_OUTPUT_TOKENS`. Recommend raising the value, not disabling the warning.
- "Invalid JSON — changes not saved" / "Unsupported field(s) ignored: {{fields}}" in the JSON
  tab (`ModelConfigPanel.tsx:211, 226-234`): only `contextWindow`, `maxOutputTokens`, `vision`,
  `thinking`, `reasoningEffort` are recognized; any other key is dropped silently but reported in
  this message — it is not an error in the sense of losing the whole edit, only that one field.
