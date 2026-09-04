# Configuring AI Models — What Actually Happens in Settings → AI Model

Last updated: 2026-09-03

Read this whenever the user asks how to add/switch/fix an AI provider, reports a chat error
("invalid key", "no response", "model not found"), or asks what a model's context window /
vision / thinking support is. Everything below was verified against Halo's source (file paths
cited). If a statement here contradicts observed behavior, trust the observed behavior and
report the discrepancy.

## Companion documents

| Document | Read it when |
|---|---|
| `ai-model-setup/troubleshooting.md` | The user reports a specific failure (login stuck, "invalid API key", fetch-models error, chat not responding) — has the exact message-to-cause-to-fix table |

## 0. The UI path

Everything in this document lives at **Settings → AI Model** (`t('AI Model')` /
设置 → AI 模型), rendered by `AISourcesSection` at
`src/renderer/components/settings/AISourcesSection.tsx` and reached from
`src/renderer/pages/SettingsPage.tsx:94-95`. There is a separate first-run setup screen
(`src/renderer/components/setup/SetupProviderConfig.tsx`) that a brand-new install shows before
any AI is configured, but by the time a digital human or the main chat is running to answer a
user's question, setup is already done — always point the user at Settings → AI Model, not the
first-run screen.

**There is no tool for the AI itself to add/edit/switch a source.** This is pure UI-navigation
knowledge — you tell the user what to click, you do not call an API for them
(confirmed: no `ai-sources`/`authGetProviders`/`fetchModels` handler is exposed as an agent
tool anywhere under `src/main/services/agent` or `src/main/apps`).

## 1. Concepts — the four things users conflate

1. **A "source"** (`AISource`, `src/shared/types/ai-sources.ts`) is one configured
   provider account — a display name, a provider id, an auth method, and its own model list.
   A user can have many sources (e.g. both a DeepSeek API key and a Claude OAuth login) at once.
2. **The "current" source** is the one global default used by the main chat
   (`getCurrentSourceConfig`, `manager.ts:181-184`, a thin pass-through; the actual selection
   logic is `getCurrentSource` in `src/shared/types/ai-sources.ts:442`). Exactly one source is
   current at a time, shown by
   a filled checkmark circle on its card (`AISourcesSection.tsx:381-393`). Switching it is one
   click on another source's card (`handleSwitchSource` → `aiSourcesSwitchSource`,
   `AISourcesSection.tsx:154-157, 384`).
3. **A per-app model override** is a *different, narrower* mechanism: an individual digital
   human (automation app) can pin itself to a specific source+model instead of following the
   global current source (`getBackendConfigForSource`, `manager.ts:385-451`). That is configured
   on the app itself, not here — this document only covers the global Settings → AI Model list.
4. **Model capability overrides** (contextWindow / maxOutputTokens / vision / thinking /
   reasoningEffort) are per-(source, model) preferences, not a provider or auth setting — see
   §5. Do not confuse "the model doesn't support vision" (a capability fact) with "the source
   isn't logged in" (an auth fact); they fail differently and are fixed differently.

### Auth methods — there are four, not two

| Auth method | `authType` | How it's added | Where the token lives |
|---|---|---|---|
| API key (BYOK) | `api-key` | "Add AI Provider" → pick a builtin gateway or "Custom API" → paste key | Encrypted in Halo's own config (`secure-storage.service`) |
| OAuth | `oauth` | Click a provider card in the "OAuth Login" row, or a closed-source module card | Encrypted in Halo's own config; refreshed automatically (`ensureValidToken`, `manager.ts:891-927`) |
| Delegated (CLI) | `delegated` | "Claude Code CLI" card → `DelegatedLoginDialog` → run a shell command → auto-detected | **Nowhere in Halo.** The bundled Claude Code CLI keeps its own credential; Halo only records that the slot is signed in (`cli-delegated.provider.ts:1-19`, `CliDelegatedProvider.getBackendConfig` sends `key: ''`) |
| External OAuth module | `oauth` | Same UI as OAuth, but the login/token logic is a separate module loaded from a `path` in `product.json`, not builtin code | Same as OAuth |

Delegated is **macOS-only** (`manager.ts:100-104`, gated on `process.platform === 'darwin'`,
`authDelegatedStatus` also checks this at `src/main/ipc/auth.ts:315-334`). On any other OS the
"Claude Code CLI" card must not be offered — it is never registered as a provider.

## 2. Which providers actually exist in this build — mechanism, not a list

**`product.json` is per-deployment, often gitignored/locally-built, and never something to
assert from memory.** The open-source template (`product.example.json`) ships exactly four
`authProviders` entries (`claude`, `claude-cli`, `custom`, `github-copilot`, zero `preset`
blocks) — but any real install, including internal/enterprise builds, can and does ship a
completely different `authProviders` array (different provider set, different closed-source
`path`-loaded modules, and/or one or more `preset` gateway entries). **Never tell a user which
providers "exist" or "don't exist" — always go by what their Settings → AI Model screen actually
shows them** (ask them, or use AI Browser to look, if you need to know).

What's constant across every build is the *mechanism* that turns that array into UI
(`AISourcesSection.tsx`):

1. On mount, `api.authGetProviders()` fetches the live `authProviders` array and keeps every
   entry except `type === 'custom'` (`AISourcesSection.tsx:108-118`) — `custom` is excluded here
   because it's rendered separately via the generic "Add AI Provider" flow (step 4 below), not as
   its own card.
2. At render time this pool is split into two rows purely by whether an entry has a `preset`
   block, each also excluding sources already added (`AISourcesSection.tsx:760-777`):
   - **"Preset API" row**: entries *with* `preset` (fixed gateway URL, API-key-only —
     `PresetApiConfig`, `ai-sources.ts:725-740`) and not yet added (matched by
     `isPreset === true && apiUrl === preset.baseUrl`).
   - **"OAuth Login" row**: entries *without* `preset` and not yet added (matched by
     `provider === provider.type`).
3. Inside the OAuth Login row, one further special case: if an entry's `type` equals the
   delegated-CLI provider id, its card opens `DelegatedLoginDialog` instead of the generic OAuth
   flow (`AISourcesSection.tsx:838-844`) — everything else in that row calls `handleOAuthLogin`.
   A `path`-loaded closed-source OAuth module renders identically to a builtin OAuth provider;
   if its module file is missing on disk it simply fails to register
   (`auth-loader.ts:63-107` → `loadError`, no crash, no card) — a "missing" provider is not
   necessarily a config error to chase.
4. **"Add AI Provider" button** — independent of `product.json` entirely. It opens the generic
   `ProviderSelector`, whose dropdown is the full hardcoded `BUILTIN_PROVIDERS` catalog: 26
   `authType: 'api-key'` gateways (`getApiKeyProviders()`, `src/shared/constants/providers.ts`)
   plus a raw "Custom API" entry for any OpenAI/Anthropic-compatible endpoint not in that list.
   This path is always available regardless of what `product.json` contains.

**Why the Preset API row matters even though the open-source default has none of it**: a locked-
URL, API-key-only preset gateway is a common shape for an internal/enterprise deployment, and for
a user on that kind of build it *is* the entire configuration flow — pick the one preset card,
paste a key, done (no URL, no provider choice). If the user's screen shows a "Preset API"
section, treat that card's flow as their fast path rather than steering them toward the generic
"Add AI Provider" dropdown.

## 3. Configuring a source, step by step

### API key / BYOK / Custom API (the common case)

1. Settings → AI Model → **Add AI Provider**.
2. Pick a provider from the dropdown (or leave it as a generic Claude/OpenAI-compatible entry
   for an arbitrary endpoint), or use a specific gateway card if one is already listed.
3. Fill in: Display Name, API Key, and — only for the generic/Custom form — the API URL
   (builtin gateways prefill their own URL; the field stays editable).
4. Click **Fetch Models** (`handleFetchModels` → `api.fetchModels(apiKey, apiUrl)` →
   `fetchModelsFromApi`, `src/main/services/api-validator.service.ts:48-116`) to populate the
   model dropdown from the provider's real `/v1/models` (or `/models`) endpoint, or pick a model
   manually via the "custom model ID" toggle.
5. Optionally click **Test connection** (`handleTestConnection` → `api.validateApi(...)` →
   `validateApiConnection`, `api-validator.service.ts:144-315`) — this sends one real "test"
   message through the actual SDK pipeline and reports success/failure with a reason.
6. Click **Save**. The only client-side gate is a non-empty API key and a resolved model
   (`ProviderSelector.tsx:253-267`) — Save does **not** require Test connection to have passed.

### OAuth (Claude / GitHub Copilot / a closed-source module)

1. Settings → AI Model → click the provider's card in the OAuth Login row.
2. Either a browser window opens for direct login, or (GitHub Copilot / "partner-assisted"
   Claude login) a device code is shown to enter on another device
   (`AISourcesSection.tsx:704-730` for the generic device-code UI; `claudeLogin` state,
   lines 559-702, for Claude's dual-mode dialog).
3. Halo polls/completes automatically; once done the new source appears and becomes current.

### Delegated (Claude Code CLI, macOS only)

1. Settings → AI Model → "Claude Code CLI" card → opens `DelegatedLoginDialog`.
2. The dialog shows a shell command and offers "Run in Halo terminal" or "Copy command" — the
   user (or the AI, in a terminal it controls) runs it and completes the CLI's own browser login.
3. The dialog polls every 2s (`POLL_INTERVAL_MS`, `DelegatedLoginDialog.tsx:37`) and
   auto-creates the source the moment the CLI reports signed-in — no separate Save step.

### Switching the active source or model

- Click the radio circle on any source card to make it current (`AISourcesSection.tsx:381-393`).
- To change the model within an already-added source, reopen it (edit) and reselect from the
  model dropdown, or use "Fetch Models" again to refresh the list.

## 4. Verification — how to know it worked

There is no tool call to confirm this — verification is entirely visual, so ask the user (or,
if you have AI Browser access to the running Halo window, use it) to confirm:

1. **The source card is highlighted with a filled checkmark** — that means it is `currentId`
   (`AISourcesSection.tsx:369-373`). A newly-added or newly-logged-in source is set current
   automatically (`addSource`/`handleOAuthLoginSuccess`/`upsertDelegatedSource` all end by
   calling `setCurrentSource`).
2. **"Test connection" returns "Connection successful"** (`validateApiConnection` success path,
   `api-validator.service.ts:268-274`) — this is the strongest signal because it actually round-
   trips a real request through the SDK, not just a saved-config check.
3. **A normal chat message gets a real reply.** If the source is misconfigured,
   `getBackendConfig()` returns `null` (missing key/token) and the chat pipeline has nothing to
   call — this shows up as the chat simply not producing an assistant turn, not as a clean error
   dialog (`manager.ts:213-299`).

## 5. Model capability overrides (contextWindow / vision / thinking / maxOutputTokens)

Shown via the expandable panel under a selected model in `ProviderSelector`
(`ModelConfigPanel.tsx`). Resolution order, highest priority first
(`model-capabilities.service.ts:64-107`): **user override → `[1m]` model-id suffix
(contextWindow only) → exact preset match → prefix-pattern match → built-in default**
(`contextWindow: 128_000, maxOutputTokens: 16_384, thinking: false`, vision resolved separately
by an id heuristic — `DEFAULT_CAPABILITY`, `model-capabilities.service.ts:46-50`).

- If no preset exists for a model, the panel auto-expands with an amber warning
  ("No preset found — verify these values match your model",
  `ModelConfigPanel.tsx:274-279`) — this is informational, not an error; the fallback defaults
  above still apply and chat still works.
- `maxOutputTokens` set very low (but > 0) shows a separate amber warning about Claude Code
  auto-compact truncation (`ModelConfigPanel.tsx:366-374`) — tell the user to raise it rather
  than silently leaving it.
- "Reset to preset" clears the override entirely, reverting to preset/default
  (`ModelConfigPanel.tsx:239`, only shown when an override exists).
- A model id ending in `[1m]` (e.g. `claude-sonnet-4[1m]`) is the user's explicit 1M-context
  opt-in; the resolved `contextWindow` is raised to 1,000,000 unless the user has explicitly
  overridden `contextWindow` themselves (`model-capabilities.service.ts:93-104`). Never suggest
  removing the `[1m]` suffix to "fix" a context error unless the user wants to opt out of 1M
  billing.

## 6. Do NOT ask / do NOT tell the user

- **Do not ask which "wire format" or `apiType` to use** (`chat_completions` / `responses` /
  `anthropic_passthrough` / `kiro`). It is resolved automatically from the provider's builtin
  catalog entry or the preset config — there is no UI field for it
  (`ProviderSelector.tsx` — confirmed no `apiType` selector exists;
  `manager.ts:280-284` marks this an explicit `// TODO` for a future UI, meaning it genuinely
  cannot be set today).
- **Do not tell the user to paste a credential for a `path`-loaded closed-source OAuth
  module** (any OAuth Login card whose entry isn't `builtin: true` in this deployment's
  `product.json`) — these are OAuth-only cards; if one is missing from the row, its module file
  simply isn't present in this build, and no credential field would fix that.
- **Do not promise "Preset API" gateways exist** unless you've confirmed the running
  `product.json` actually has a `preset` block — the open-source default has none.
- **Do not gate Save on Test connection passing.** They are independent; a user can save an
  unverified key and only discover a problem later in chat or via troubleshooting.md.
- **Do not offer the Delegated (Claude Code CLI) option on Windows/Linux** — it is not
  registered there at all, not just hidden.
- **Do not conflate a model capability warning (amber, "no preset found") with an auth error**
  — the former never blocks chat; the latter (missing key/token) does.
