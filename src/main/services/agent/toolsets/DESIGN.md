# services/agent/toolsets — Toolset Broker

> Optional built-in in-process MCP servers ("toolsets", e.g. ai-browser,
> ai-terminal). Read this before adding a toolset or touching MCP seeding.

## 1) Purpose

The broker assembles built-in MCP servers for space conversations. Context loading
and authorization have separate owners: the Halo SDK manages model context;
actual access grants, tool restrictions and platform availability remain host policy.

## 2) Capability availability and tool context

- Supported browser, terminal, OCR, collaboration and Operate Halo capabilities
  are supplied automatically in space conversations. Core capability residency
  does not depend on saved per-conversation switches or engine selection.
- A conversation can carry host-only toolset exclusions. An exclusion wins over
  automatic inclusion and is persisted, so every rebuilt session keeps it out;
  a quick review uses this to stay one agent while collaboration remains core.
- Operate Halo is core. Its reference tool, usage guide and scoped runtime
  credentials are available from the first turn without a human enablement step.
- The engine owns detailed tool context. Halo SDK uses client discovery for
  configured MCP services in native mode; legacy histories, explicit XML/JSON and
  other engines retain their own calling/history representation. This does not
  turn capability loading into a user authorization workflow.
- The status catalog retains platform-available capabilities. `configurable:
  false` hides a core loading control while preserving availability for actions
  such as opening a terminal. Platform restrictions and explicit caller/tool
  policies still determine what an execution may do.
- The broker assembles servers and short capability hints at session creation.
  Browser and terminal service metadata come from their capability modules. Native
  Halo defers their full definitions and service instructions through the existing
  discovery catalog; full-mode SDK sessions and external engines receive service
  instructions with their normal MCP context. Terminal has no resident tutorial.
  This changes model presentation, not mounting, connections or authorization.
  The broker never parses native history to decide whether a person must enable a capability.
  Each build receives fresh server instances. Configuration changes apply at safe
  boundaries; ordinary SDK discovery does not recreate sessions or connections.
- An optional registered capability may be activated by the AI through
  `request_toolset`. It emits an ordinary change, not a request for a human click.
  Current core capabilities need no activation tool at all.
- Fixed host guidance overrides obsolete documentation about capability switches.
  It directs the model to the actual exposed tools and preserves explicit tool,
  connection and caller restrictions.

## 3) Files

| File | Responsibility |
|---|---|
| `types.ts` | `ToolsetDefinition`, scope, status, event types |
| `registry.ts` | The catalog. **Adding a toolset = one entry here** |
| `state.ts` | Legacy/manual open-set persisted on the conversation; resolved context mode retained only for its session |
| `base.ts` | `buildBaseToolset`: the servers every user-facing session starts from (web-search, halo-docs, halo-apps while digital humans are enabled). Space chat (via the broker), digital-human chat and automation start from it and exclude explicitly. Imported directly, not through the barrel (the barrel loads the registry). See §6 |
| `broker.ts` | Builds the creation-time MCP record (`buildCreationTimeServers`); `openToolset`/`closeToolset` (user toggle → persist + schedule rebuild); `requestToolset` (AI → user, emits `toolsets:requested`); emits `toolsets:changed`. Rebuild via an injected invalidator (DI seam, avoids a cycle with session-manager) |
| `meta-server.ts` | The resident `request_toolset` MCP server (disabled-toolset awareness lives in its tool description) |
| `selection.ts` | Shared mode-aware selection for mounted capabilities and manual controls; explicit conversation exclusions win |
| `capability-index.ts` | `buildToolsetSection`: guides for the mode's mounted capabilities |
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

## 4b) Persisted optional selections

Historical open-sets and last-used defaults remain readable for optional
capabilities. They do not withhold core capabilities. User changes may update
that preference; AI activation changes only the current conversation and does
not rewrite the user's global last-used selection.

## 5) Capability activation

`request_toolset` exists only if an optional capability is not already included.
The broker activates it directly and schedules the existing safe session update.
It never asks the user to enable a switch. Core capabilities report already
available, and older clients cannot close them through the loading endpoint.
Availability/status events retain desktop and remote parity.

## 6) Automation (digital humans)

**Base toolset.** `base.ts` is the one part shared with the broker: every entry
builds its record from `buildBaseToolset` and takes servers OUT, with the reason at
its call site, rather than listing them itself — so a new base server reaches every
entry by default. Current exclusions: automation runs and disposable team members
get no `halo-apps`. Never in the base: `halo-conversations` (its own switch per
entry kind) and anything granted per conversation or permission (browser,
terminal, OCR, email, Halo API, memory, report, notify, team tools, person
context, IM file send). `tests/unit/services/agent/entry-capability-matrix.test.ts`
pins what each entry ends up with.

Beyond that base, automation does NOT use this broker or the meta server. Enabled toolsets are
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

**`halo-api-ref` ("Operate Halo") is not a switch for a digital human.** It is
how a digital human perceives its own environment — the teams it serves, their
conversations, its own settings — so chat and runs mount it without consulting a
permission, and the Capabilities panel lists it as always on. It is decided by
who is asking instead: never for an IM guest or a request from outside
(`origin`), whose switches do not include it and whose turns the policy filter
would strip of it anyway, and never for a disposable team member, which goes
without `halo-apps` for the same reason. A stored grant or denial for it is
inert. The cost is its tool schema plus usage guide (about 1K tokens) on every
digital-human turn and run; keep both as short as they can be.

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
3. Interactive: meta tools, system-prompt section, the composer's Capabilities
   group, and persistence all derive from the registry. State whether the switch
   is solely for context size (`contextManaged`) or a real access grant. Add the renderer icon,
   label and one-line description in `components/chat/composer-menu/toolset-display.tsx`.
4. Automation (optional): add a `resolvePermission` gate + MCP injection in
   `apps/runtime/execute.ts` and `app-chat.ts`, a usage-guide append in
   `prompt.ts` / `prompt/identity.ts`, and a toggle in `AppConfigPanel.tsx`.
