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
- **Resident cost** = the single `request_toolset` meta tool, whose description
  bakes in the current disabled-toolset summaries (meta-server.ts). ENABLED
  toolsets get their full `usageGuide` appended to the system prompt
  (`buildToolsetSection`); disabled ones add nothing to the prompt itself.

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
| `state.ts` | Per-conversation open-set; write-through persisted on the conversation record |
| `broker.ts` | Builds the creation-time MCP record (`buildCreationTimeServers`); `openToolset`/`closeToolset` (user toggle → persist + schedule rebuild); `requestToolset` (AI → user, emits `toolsets:requested`); emits `toolsets:changed`. Rebuild via an injected invalidator (DI seam, avoids a cycle with session-manager) |
| `meta-server.ts` | The resident `request_toolset` MCP server (disabled-toolset awareness lives in its tool description) |
| `capability-index.ts` | `buildToolsetSection`: enabled-toolset usage guides for the system prompt |
| `service.ts` | User-initiated open/close/list façade for transport |

## 4) Seeding & rebuild

- `send-message.ts` / `ensureSessionWarm` pass a deferred builder
  (`buildMcpServers: () => ({ ...dbMcpServers, ...buildCreationTimeServers(scope) })`)
  to `getOrCreateV2Session`, which invokes it only when a session is actually
  created — after any cleanup of the previous one. **Instances must be born at
  session creation**: an in-process MCP server binds to exactly one session
  transport, and seeding an instance that was bound to a torn-down session fails
  as a swallowed SDK rejection (server registered but dead, tools silently
  unavailable). The SDK/codex bridge delivers the in-process servers at thread
  creation; a reused session skips instantiation entirely.
- A toolset toggle (`openToolset`/`closeToolset`, `opener='user'`) persists the
  open-set to the conversation record (`state.ts`) and calls the injected
  `invalidateSessionForRebuild` → `requestSessionRebuild`
  (session-manager), which rebuilds now or defers to the turn boundary
  (`pendingConsumerRebuilds` + `consumePendingRebuild`, shared with credentials
  rebuild). The next `sendMessage` re-seeds the new set.
- Server instances are NEVER cached across builds — every build creates fresh
  instances via the registry factories. (A per-conversation instance cache
  existed briefly and caused rebuilt sessions to receive already-bound
  instances; see the invariant above.)
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
On first run, before any user toggle has written `config.lastToolsets`, `createConversation`
seeds `FIRST_RUN_DEFAULT_TOOLSETS` (currently `['ai-browser']`) so the browser is on out of
the box; once the user toggles anything, `config.lastToolsets` (including an empty set = all
off) is authoritative.

## 5) `request_toolset` UX

`requestToolset` (broker) emits `toolsets:requested`; the renderer
(`App.tsx` → `toolsets.store.applyRequestedEvent` → `ToolsetControls`) opens the
"Tools" menu and pulse-highlights the requested switch. The meta-server tool
returns guidance so the AI tells the user which toolset to enable, then stops.

## 6) Automation (digital humans)

Automation does NOT use this broker or the meta server. Enabled toolsets are
**app permissions** resolved via `resolvePermission(app, '<id>')` in
`apps/runtime/execute.ts` + `app-chat.ts`, seeded into the run's static MCP set at
creation, and their usage guides appended in `prompt.ts` / `prompt/identity.ts`.
Capabilities are toggled in `AppCapabilitiesSection.tsx` (grant/revoke-permission).
All built-in capabilities default ON (only an explicit user deny turns one off —
see PROTOCOL.md §13). A caller who is NOT the owner (IM guest, teammate) is held
to the capability policy on top of that: `filterMcpServersByPolicy` in
`apps/runtime/capability-policy.ts` injects only what the policy tables classify,
so a server absent from those tables reaches neither a guest nor a teammate.
`ai-terminal` is a listed capability with one extra rule, carried by
`followsBuiltin` on the toggle table: for a TEAMMATE (where an unstated permission
means "granted"), an untouched terminal switch follows the built-in command tool —
the two are the same door onto the owner's machine, and withholding commands while
leaving the terminal reachable is the gap that rule closes. For a GUEST (where
silence means "denied") nothing is inherited: their policies were saved before the
terminal switch existed, so inheriting would grant a capability the owner was
never shown — and there is no second gate behind it, since `canUseTool` only fires
for interactive tools and `disallowedTools` covers built-ins, not MCP servers.
Injection IS the grant.

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
