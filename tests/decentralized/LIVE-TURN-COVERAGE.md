# Live-turn delivery regression coverage

The shared contract is: equal, known authority joins the running turn; different
or unknown authority remains isolated and merges into the next eligible turn.
Acceptance transfers ownership of input, including when the native engine has
already started its final response. A queued job is not described as delivered.
The numbered rows below correspond exactly to the implementation proposal's
17 scenarios; the final row covers the existing interactive entry points.

| # | Scenario and required behavior | Delivery path | Deterministic regression files |
|---|---|---|---|
| 1 | A member's report or ending notice reaches a working space coordinator at its next tool boundary. | Team space-coordinator adapter → conversation-interop mailbox → space conversation source → engine. | `tests/unit/apps/runtime/team/space-coordinator.test.ts`; `tests/unit/services/conversation-interop/delivery.test.ts`; `tests/unit/services/conversation-interop/delivery-lifecycle.test.ts` |
| 2 | A member's ending notice is submitted immediately to a digital-human lead; the latest pending notice for that member replaces older pending notices. | Team turn-report → message bus → orchestration live delivery or grouped dispatch. | `tests/unit/apps/runtime/team/turn-report.test.ts`; `tests/unit/apps/runtime/team/message-bus.test.ts`; `tests/unit/platform/turn-gate/live-delivery.test.ts` |
| 3 | Member-to-member messages join equal-authority work, including human-started turns and compatible queued messages; incompatible authority stays separate. | Team message bus → shared gate → orchestration → app-chat live input. | `tests/unit/apps/runtime/team/message-bus.test.ts`; `tests/unit/apps/runtime/team/orchestration.test.ts`; `tests/unit/apps/runtime/app-chat-delivery.test.ts` |
| 4 | A due periodic check joins compatible live work; repeated pending occurrences of the same check coalesce. | Team checks → periodic wake → shared gate with the check's coalescing key. | `tests/unit/apps/runtime/team/checks.test.ts`; `tests/unit/apps/runtime/team/message-bus.test.ts`; `tests/unit/platform/turn-gate/live-delivery.test.ts` |
| 5 | Cross-conversation messages arrive during work; explicit replies can satisfy independent waiting senders without ending the recipient's turn. | Conversation-interop → registered source live input; pending-wait correlations survive an engine-owned continuation. | `tests/unit/services/conversation-interop/delivery.test.ts`; `tests/unit/services/conversation-interop/delivery-lifecycle.test.ts`; `tests/unit/services/conversation-interop/pending-wait.test.ts` |
| 6 | The owner's IM supplement joins a compatible running digital-human turn and retains its original record. | IM dispatch → supplement gate → app-chat batch injection. | `tests/unit/apps/runtime/dispatch-inbound.test.ts`; `tests/unit/apps/runtime/im-rapid-messages.test.ts`; `tests/unit/apps/runtime/dispatch-inbound-stream-race.test.ts` |
| 7 | An IM guest's message never enters an owner turn; compatible guest messages remain grouped for a separate restricted turn. | IM sender standing → supplement identity → isolated gate group → ordinary restricted app-chat assembly. | `tests/unit/apps/runtime/dispatch-inbound.test.ts`; `tests/unit/apps/runtime/app-chat-delivery.test.ts`; `tests/unit/apps/runtime/app-chat-team-im-access.test.ts` |
| 8 | Direct API and local app-chat sends join compatible work or queue a permission-isolated batch; admission failures are reported. | Validated IPC/HTTP target → app-chat delivery → engine acceptance and reply observers. | `tests/unit/apps/runtime/app-chat-delivery.test.ts`; `tests/unit/apps/runtime/app-chat-member-surfaces.test.ts`; `tests/unit/ipc/app-chat-transcript.test.ts` |
| 9 | The owner can type into a locally owned member's working team chat; an incompatible or ending turn uses the normal send fallback. | Team-session composer → app-chat inject controller → owner addition gate; fallback → app-chat send. | `tests/unit/renderer/team-session-input.test.ts`; `tests/unit/http/routes/apps-chat-inject.test.ts`; `tests/unit/apps/runtime/app-chat-live-turn.test.ts` |
| 10 | Reminders join eligible live work; pending reminders refresh the setter's permissions and destination before delivery and respect cancellation. | Reminder delivery → deferred-request refresh → app-chat gate with reminder coalescing key. | `tests/unit/apps/runtime/reminder-delivery.test.ts`; `tests/unit/apps/runtime/app-chat-delivery.test.ts`; `tests/unit/platform/turn-gate/live-delivery.test.ts` |
| 11 | Notifications and private owner questions supply context to eligible active IM chats; native refusal or changed authorization leaves their durable context unconsumed. | Notify/private-question producer → pending relay spool → owner/destination validation → live-only gate. | `tests/unit/apps/runtime/pending-relay-delivery.test.ts`; `tests/unit/apps/runtime/notify-bot-current-chat.test.ts`; `tests/unit/apps/runtime/pending-relays.test.ts`; `tests/unit/apps/runtime/relay-actions.test.ts` |
| 12 | An answered decision joins its original compatible live work; delivery starts and settles against that execution, without bypassing another unanswered question or treating a stop as completion. | Team decision wake → orchestration live decision tracking; solo continuation → exact original active run. | `tests/unit/apps/runtime/team/orchestration.test.ts`; `tests/unit/apps/runtime/runtime.test.ts`; `tests/unit/apps/runtime/execute.test.ts`; `tests/unit/apps/runtime/decision-durability.test.ts` |
| 13 | An incoming remote-member message is stamped external on the receiving machine; it can join external work but never a local owner's turn. | Federation owner-side space/origin resolution → local app-chat permission gate. | `tests/unit/apps/runtime/federation/wake.test.ts`; `tests/unit/apps/runtime/federation/manager.test.ts`; `tests/unit/apps/runtime/app-chat-delivery.test.ts` |
| 14 | A message to a busy remote member is forwarded without waiting behind a sender-side turn reservation; the owner applies live delivery and failure receipts remain traceable. | Team remote-message path → location-aware session dependencies → durable wake → owner-side gate. | `tests/unit/apps/runtime/team/message-bus.test.ts`; `tests/unit/apps/runtime/federation/wake.test.ts`; `tests/unit/apps/runtime/federation/wake-undelivered.test.ts`; `tests/unit/apps/runtime/federation/coordinator.test.ts` |
| 15 | File/event triggers arriving during automation work join that run, including startup arrivals and final-response continuations; schedule and manual restart semantics remain unchanged. | Runtime event gate → active-run readiness → shared live-input channel; closed acceptance → grouped next event run. | `tests/unit/apps/runtime/runtime.test.ts`; `tests/unit/apps/runtime/active-runs.test.ts`; `tests/unit/apps/runtime/execute.test.ts` |
| 16 | A configuration, tool or MCP change during a turn applies from the next turn and never stops input joining the running one; a changed permission standing (IM owners or guest policy, delegated policy) keeps other senders out; retired preparation cannot release or affect a successor. | Permission-envelope fingerprint → refused live handoff → gate; deferred rebuild at turn end; session lease retirement ownership. | `tests/unit/apps/runtime/app-chat-member-surfaces.test.ts`; `tests/unit/apps/runtime/app-chat-delivery.test.ts`; `tests/unit/services/agent/session-manager-mcp-retry.test.ts`; `tests/unit/services/agent/session-handoff.test.ts` |
| 17 | Editing a supported conversation goal reaches the model before its next step, including an edit during the final response. | Goal host API → Halo SDK goal-change queue → query-loop step/final-response check. | `tests/unit/services/agent/goal.test.ts`; `src/sdk/halo-sdk/core/session.test.ts`; `src/sdk/halo-sdk/core/query-loop.test.ts` |
| — | Existing user interruption in space/digital-human chats and run-detail instructions keeps working through the shared engine contract; original messages appear at their arrival positions. | Space inject; app-chat owner addition; active-run input; detail-scoped input-arrival deltas and transcript reconciliation. | `tests/unit/services/agent/inject-message-references.test.ts`; `tests/unit/apps/runtime/app-chat-live-turn.test.ts`; `tests/unit/apps/runtime/active-runs.test.ts`; `tests/unit/apps/runtime/runtime.test.ts`; `tests/unit/renderer/live-inputs.test.ts`; `tests/unit/renderer/streaming-input-arrival.test.ts` |

## Shared contracts and verification scope

- Inbox invariants are exercised in `tests/unit/platform/turn-gate/turn-gate.test.ts`
  and `tests/unit/platform/turn-gate/live-delivery.test.ts`: permission groups, FIFO
  exclusive barriers, readiness, in-place authority refresh, bounded coalescing,
  capacity rejection, synchronous acceptance, retry retention, explicit cancellation,
  and old dispatches not releasing their successor's reservation.
- Engine contracts are exercised in
  `tests/unit/services/agent/live-turn-delivery.test.ts`,
  `tests/unit/services/agent/cc-live-input.test.ts`,
  `tests/unit/services/agent/codex/session-adapter-stream.test.ts`,
  `tests/unit/services/agent/dsh/session-adapter.test.ts`,
  `tests/unit/services/agent/dsh/runtime-e2e.test.ts`, and the Halo SDK's
  `src/sdk/halo-sdk/core/session.test.ts` and `core/query-loop.test.ts`. They cover
  tool-boundary delivery, ordered input, final-response races, and continuation
  ownership. Session handoff tests cover failed/retired preparation separately.
- Codex protocol round trips are covered by
  `tests/unit/openai-compat-router/codex-responses-handler.test.ts`, including
  exact namespaces, fragmented UTF-8/SSE frames and preserved native reasoning.
  With `CODEX_E2E=1`, `tests/unit/services/agent/codex/runtime-e2e.test.ts` runs
  the bundled Codex process against the production router and MCP bridge, calls
  an MCP tool and a real shell command, and verifies both receipts in the next
  model request for Responses and Chat Completions. Only its local model endpoint
  is scripted; it does not establish live-provider availability.
- The shared Codex/dsh MCP tool factory is covered by
  `tests/unit/services/agent/mcp/sdk-server.test.ts`: nested schemas, constraints,
  descriptions, defaults, transforms, empty inputs and validation before handlers.
  `tests/unit/apps/conversation-mcp/collab-start-contract.test.ts` uses a real
  HTTP MCP client and bridge with the team service and app manager. It verifies
  the advertised member schema retains required `responsibility` fields, valid
  calls install schema-valid automation apps, and missing nested fields return a
  correctable tool error before any team or app is created.
- Arrival display is covered by `tests/unit/renderer/live-inputs.test.ts`,
  `tests/unit/renderer/streaming-input-arrival.test.ts`, source delivery tests,
  `tests/unit/apps/runtime/app-chat-sink.test.ts`, and
  `tests/unit/apps/runtime/chat-push-record.test.ts`. These distinguish provisional
  live placement from canonical stored history and retain each original source.
- The Halo SDK is a separate Git checkout under the main repository's ignored
  `src/sdk/halo-sdk` path. Its source changes, tests and built output must be included
  in review and release preparation; the main repository's diff alone is incomplete.

`tests/decentralized/checklist-live-turn.mjs` is the real-model acceptance harness:
three independent reports, evidence after a tool return, preserved arrival records,
and the number of turns after the final response. Run it separately for each available
engine/provider combination; do not substitute another engine for a claimed pass.
The existing federation cluster tier checks real isolated-node routing and receipts.
Configured IM channels are additionally needed to validate provider-specific receipts
and pushed replies; unit tests establish the provider-independent ownership rules.

Model runs establish integration behavior and complement deterministic failure/race
coverage. Provider availability, API compatibility and model instruction-following
must be recorded with the actual run evidence, rather than inferred from unit tests.

## Authority and native-engine boundaries

- A space coordinator's running turn admits only local collaboration work. External,
  remotely owned, or unknown senders run as their own turn after it, as before live
  delivery. Digital-human team turns carry the existing delegated policy on both
  machines.
- Federation retains internal completion receipts for asynchronous delivery failures;
  the sender does not reserve or wait on the remote member's turn. Nodes follow the
  existing strict protocol-version gate, so an older protocol is explicitly refused.
- Coalescing replaces pending mailbox notices. A native engine's accepted input cannot
  be retracted; a later notice is an ordered update within ongoing work.
- Goals currently belong to Halo SDK only; unsupported engines do not expose the goal
  feature. dsh supports live input but retains its existing lack of persistent session
  resume after a configuration rebuild.
- UI delivery uses a detail-scoped input-arrival delta and existing source styles. No
  per-message whole-transcript reload or new stored conversation format is introduced.


## Native permission admission matrix

Four-engine parity in this change covers delivery of work the selected engine
can safely admit. It does not add a new sandbox, per-tool approval protocol, or
permission enforcement to an engine that lacked it before this change.

| Execution context | Claude Code | Halo SDK | Codex | dsh |
|---|---|---|---|---|
| Owner/local unrestricted turn and compatible live messages | Live delivery | Live delivery | Live delivery | Live delivery |
| IM guest / borrowed external work requiring strict permissions | Enforced, then delivered | Enforced, then delivered | Explicit capability refusal before native send | Explicit capability refusal before native send |
| Locally initiated teammate turn with an explicit restrictive policy | Enforced, then delivered | Enforced, then delivered | Explicit capability refusal before native send | Explicit capability refusal before native send |

The unchanged capability descriptors are the source of truth:
`services/agent/capabilities.ts`, `codex/capabilities.ts`, and `dsh/capabilities.ts`.
The existing app-chat guard refuses `applied.enforced` when `permissionRules` is
false or unavailable; strict mode always sets enforcement. A restriction never
falls back to an unrestricted turn, and a lower-authority message never joins an
owner turn to avoid this refusal. Cross-node authority validation remains required
before every live attempt, since the native enqueue primitive does not authenticate
a sender by itself.

`app-chat-member-surfaces.test.ts` checks refusal before SDK acquisition.
The guard also fails closed when the engine provides no capability descriptor.
`app-chat-delivery.test.ts` checks isolated groups and final run rejection without
duplicate admission errors.
The app delivery wrapper settles those callers and releases its reservation once;
team orchestration returns an error completion and releases the member slot. Such
an unsupported turn is not automatically retried forever by the shared mailbox.

Consequently, rows 7 and 13–14 establish permission isolation for all engines;
successful restricted execution in those rows applies to Claude Code and Halo SDK.
Deterministic engine-contract tests establish the live-input behavior separately
on owner/local unrestricted work. Real-model claims must name only the actual
engine/provider pairs exercised. Do not describe Codex or dsh as gaining
guest/remote restricted execution through this work.
