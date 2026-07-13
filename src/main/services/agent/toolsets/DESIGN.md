# services/agent/toolsets — Toolset Broker

> Optional built-in in-process MCP servers ("toolsets", e.g. ai-browser,
> ai-terminal). Read this before adding a toolset or touching MCP seeding.

## 1) Problem it solves

Halo's in-process MCP servers keep growing. Injecting every toolset's full tool
schemas into every session is a linear, always-on context cost and dilutes model
attention. The fix is **opt-in loading**: a toolset's tools + rich usage guide
enter context only while it is enabled. Disabled toolsets cost one summary line.

## 2) Model (uniform across all engines)

- **One mechanism, no runtime hot-swap.** The complete in-process MCP set (always-on
  web-search / halo-apps, the broker meta server, and currently-enabled toolsets)
  is seeded at **session creation** via creation-time options. Enabling/disabling a
  toolset schedules a **session rebuild**, so the new set is seeded at the next
  session creation — the same deferral machinery as a credentials change.
- **The AI never enables a toolset itself.** Tools are frozen per turn by the CC
  subprocess, so a mid-turn open would be unusable that turn and the model would
  waste steps probing for it. Instead the AI calls `request_toolset`, which asks
  the user to flip the switch (and highlights it in the input "Tools" menu). Once
  the user enables it, the session rebuilds and its tools are available from the
  next message.
- **Resident cost** = one summary line per DISABLED toolset in the system prompt
  (`buildToolsetSection`) + the two meta tools (`toolsets_list`, `request_toolset`).
  ENABLED toolsets additionally get their full `usageGuide` appended to the prompt.

Historical note: an earlier design let the AI hot-open toolsets via
`session.setMcpServers` + an interrupt/auto-continuation dance to make "open and
use in one message" work. It fought the CC turn model (UI reflow, mid-turn
interrupt artifacts) and put a niche feature on the hot path. It was removed in
favour of the uniform creation-time + rebuild model above; the `setMcpServers`
SDK path is no longer used.

## 3) Files

| File | Responsibility |
|---|---|
| `types.ts` | `ToolsetDefinition`, scope, status, event types |
| `registry.ts` | The catalog. **Adding a toolset = one entry here** |
| `state.ts` | Per-conversation open-set; write-through persisted on the conversation record; per-conversation MCP server instance cache |
| `broker.ts` | Builds the creation-time MCP record (`buildCreationTimeServers`); `openToolset`/`closeToolset` (user toggle → persist + schedule rebuild); `requestToolset` (AI → user, emits `toolsets:requested`); emits `toolsets:changed`. Rebuild via an injected invalidator (DI seam, avoids a cycle with session-manager) |
| `meta-server.ts` | The resident `toolsets_list` + `request_toolset` MCP server |
| `capability-index.ts` | `buildToolsetSection`: disabled-toolset index + enabled-toolset usage guides for the system prompt |
| `service.ts` | User-initiated open/close/list façade for transport |

## 4) Seeding & rebuild

- `send-message.ts` / `ensureSessionWarm` build creation-time options as
  `{ ...dbMcpServers, ...buildCreationTimeServers(scope) }` (all engines).
  `buildBaseSdkOptions` attaches them to `sdkOptions.mcpServers`; the SDK/codex
  bridge delivers the in-process servers at thread creation.
- A toolset toggle (`openToolset`/`closeToolset`, `opener='user'`) persists the
  open-set to the conversation record (`state.ts`) and calls the injected
  `invalidateSessionForRebuild` → `invalidateSessionForToolsetChange`
  (session-manager), which rebuilds now or defers to the turn boundary
  (`pendingConsumerRebuilds` + `consumePendingRebuild`, shared with credentials
  rebuild). The next `sendMessage` re-seeds the new set.
- Server instances are cached per conversation (`getServerCache`) so a rebuild
  keeps name-stable identities. Exception: the `capabilities` meta server is
  recreated on every build — its `request_toolset` description bakes in the
  current disabled list, so caching it would go stale after a toggle.
- Persisted open-sets are hydrated as-is (`getOpenToolsets`), including ids that
  are currently unavailable on this platform; availability is gated at use time
  (registry), so a user's selection survives availability transitions.

## 4b) Last-used seed for new conversations

Per-conversation state is authoritative (`state.ts`, persisted on the conversation
record), but a **new** conversation should inherit the previous window's enabled
toolsets — the toolset analog of the global model selection. On a user toggle
(`openToolset`/`closeToolset`, `opener='user'`) the broker writes the conversation's
full open-set to `config.lastToolsets` (`rememberLastToolsets`). `createConversation`
(conversation.service) stamps that seed onto the new conversation's `toolsets`, next
to the model-pin stamp. Only user toggles update the seed (AI requests never open a
toolset; a restore must not rewrite it). Seeding happens **only at creation** — never
in `getOpenToolsets` hydration — so reopening an old (empty) conversation stays empty.
Unknown ids in the seed are dropped on hydrate, so no filtering is needed at stamp time.

## 5) `request_toolset` UX

`requestToolset` (broker) emits `toolsets:requested`; the renderer
(`App.tsx` → `toolsets.store.applyRequestedEvent` → `ToolsetControls`) opens the
"Tools" menu and pulse-highlights the requested switch. The meta-server tool
returns guidance so the AI tells the user which toolset to enable, then stops.

## 6) Automation (digital humans)

Automation does NOT use this broker or the meta server. Enabled toolsets are
**app permissions** resolved via `resolvePermission(app, '<id>', default)` in
`apps/runtime/execute.ts` + `app-chat.ts`, seeded into the run's static MCP set at
creation, and their usage guides appended in `prompt.ts` / `prompt/identity.ts`.
`ai-terminal` / `ai-browser` are toggled in `AppConfigPanel.tsx`
(grant/revoke-permission). `ai-terminal` defaults OFF and is excluded for guests
(conservative default in `app-chat.ts` `buildGuestMcpServers`).

## 7) Session rebuild contract

Rebuilds are driven by `credentialsGeneration` (global model / API-config changes),
by a per-conversation `credentialsFingerprint` (this conversation's own model/source
pin — see session-manager `computeCredentialsFingerprint`), and by toolset toggles —
all converge on `pendingConsumerRebuilds` / `consumePendingRebuild`. On rebuild,
in-memory toolset state is dropped and rehydrated from the persisted conversation
record, so the user's enabled set survives.

## 8) Adding a toolset

1. Implement the in-process MCP server under `services/<feature>/`.
2. Add one `registerToolset({ id, displayName, summary, usageGuide, isAvailable,
   createServer })` entry in `registry.ts`.
3. Interactive: meta tools, system-prompt section, renderer "Tools" menu, and
   persistence all derive from the registry. Add the renderer icon in
   `components/chat/ToolsetControls.tsx`.
4. Automation (optional): add a `resolvePermission` gate + MCP injection in
   `apps/runtime/execute.ts` and `app-chat.ts`, a usage-guide append in
   `prompt.ts` / `prompt/identity.ts`, and a toggle in `AppConfigPanel.tsx`.
