# Collaboration library

The engine-independent collaboration entry exposes contracts and coordination
without importing the SDK model loop, an execution adapter or a desktop
application. Importing it starts no sessions, opens no storage and schedules no work.

`crates/halo-core/src/collaboration/` owns the coordination algorithms, mailbox,
board writes, journal and workspace policy. `bindings/node/native/collaboration.ts`
and its sibling adapters preserve JavaScript callbacks and public objects through
`bindings/node/crate/`. Public records and protocol shapes remain in
`bindings/node/collaboration/`, with declaration contracts in
`bindings/node/contracts/collaboration/`. Node regressions live under
`bindings/node/tests/collaboration/`. Paths below are SDK-relative; Rust filenames
refer to the collaboration owner unless qualified.

The host owns execution, identities, authorization, storage and transport. Halo
is the host for every engine it runs, including Halo SDK. Standalone consumers
use a local host adapter. A session has one collaboration owner; installing both
hosted and local ownership is invalid.

## Turn admission

`turn_gate.rs` is the shared permission-aware mailbox and exclusive turn
reservation. It is extracted from Halo's platform contract without introducing
a second mailbox at the same delivery boundary. Unknown permissions never merge.
Compatible inputs can join a live turn, while exclusive operations form FIFO
barriers. Accepted inputs remain owned until dispatch or explicit cancellation.

A gate holds no model process. The host reports readiness and release against
its authoritative running turn. Stops park pending work; teardown discards it.
Timers exist only for pending work or explicitly configured recovery and do not
keep the process alive. Diagnostic tracing is opt-in; failures remain visible.
The public `/collaboration/turn-gate` entry lets generic chat admission use the
mailbox without importing collaboration tools or board operations.

## Tool contract

`tool_contract.rs` owns operation definitions, JSON schemas and validation.
`bindings/node/collaboration/types.ts` and
`bindings/node/native/collaboration-contract.ts` expose typed operations and the
callable MCP server for Node hosts. Operation
callbacks are bound to a trusted caller and work scope. Model arguments cannot
choose a team, permission identity or model source. Only supplied operations
are exposed; hiding a tool never replaces authorization inside a host callback.
The returned server uses the existing in-process, worker and external-engine
MCP bridges without registering another transport.

Creating a collaborator is asynchronous, with isolated context and optional
workspace isolation. An ordinary message can continue existing work. There are
no organization, waiting or team-completion tools. Board records are separate
from dispatch; a finding is shared knowledge, not a directed message.

`artifacts.rs` resolves publication ownership through an injected store. Both
local reads and remote serving use it. Conflicting producers remain ambiguous;
neither a host nor a transport may silently choose one file with that name.

## Optional model selection

Hosts register model selection through the second argument of
`createCollaborationServer(operations, { modelSelection: { policy, policyRevision } })`.
Only registered endpoints expose the optional `spawn_agent.model_profile` and
`reasoning_effort` fields and the supplied `list_model_profiles` operation. Existing
one-argument calls retain their tool declarations, parser and guidance.
`modelSelectionGuidance` returns the explicit capability's Harness guidance.
Hosts that carry over the direct parent's reasoning even when the model changes
can set `modelSelection.reasoningPolicy: 'inherit'`. The spawn schema omits
`reasoning_effort`, the parser refuses it, and the guidance explains inheritance.
The host adapts the parent's reasoning to the selected target; planning,
finalization, and restore keep their existing contracts. This option is specific
to the engine-independent collaboration server; standalone model selection is unchanged.
The directory tool takes no arguments. It lists all configured entries, including
unavailable ones. The internal projection is bounded by the validated catalog size.
The runtime or host enforces the tool result limit after formatting and refuses
oversized results instead of returning a partial list.

`contracts/collaboration/model-selection.ts` declares the non-secret catalog,
parent binding, choice plan, prepared capability metadata and versioned selection
snapshot. Both `/collaboration` and browser-safe `/collaboration/protocol` export
these types and `MODEL_SELECTION_LIMITS`. The limits have one JSON source shared
with Rust. Provider connections and credentials are not part of these contracts.

The `/collaboration` functions `queryModelProfiles`, `planModelSelection`,
`finalizeModelSelection`, `validateModelSelectionRestore` and
`validateEffectiveReasoning` delegate to Rust's
`model_selection.rs` through the existing native value bridge. Querying performs
a complete projection over a host-authorized catalog with empty input. Planning
checks opaque profile references and the endpoint's policy revision. Finalizing
validates the prepared target and determines effective reasoning: explicit effort,
profile default, then target default; unmodified inheritance retains the direct
parent's effective reasoning. No function creates a provider or starts execution.
The host must still authorize and prepare the exact binding before execution.
Prepared reasoning capabilities may declare supported `modes` and a positive
`maxBudgetTokens` bound. Budget reasoning must fit that bound when supplied and
remain strictly below the target output limit. Plain creation trusts the direct
parent's captured reasoning after matching binding identity, without requiring it
to appear in the target's selectable options. Explicit selections and restoration
reject unsupported settings instead of clamping or adopting a new default; exact
declared defaults and effort mappings do not require the optional mode list.

For repeated operations, `ModelProfileCatalogView` validates and retains one
bounded catalog in a native owner. Its `plan` and `query` methods accept only the
changing input, direct parent and endpoint policy revision, avoiding catalog
serialization and validation on every spawn. Replace the view when the authorized
catalog revision changes and call `close` when its scope ends. Catalog updates
never mutate an existing view or the choices already captured by a plan.

## Shared records and writes

`bindings/node/collaboration/records.ts` defines Node's durable task, finding and activity shapes. Halo re-exports
these types for its renderer and storage; it does not duplicate their definitions.
`board_writes.rs` writes through an injected store and then notifies view and
replication observers. Observer failures cannot turn a committed write into a
reported failed write or prevent the other observer from receiving it. Task
updates and parent references must match both the team and work scope before
anything is written. Host permissions and artifact publication checks remain
additional admission requirements.

## Scoped execution

`runtime.rs` owns incremental membership, dispatch admission and execution
lifecycle through an injected executor. Nested delegation shares the source's
concurrency and creation budgets. Member records are committed before they become
addressable. A stop invalidates previously admitted asynchronous operations; a
later explicit continuation does not authorize an earlier suspended write.
Idle retirement releases execution resources independently of membership and
work completion. Directed replies and system turn-end notices remain separate.

The host resolves workspaces and records their locations on the member. Board
reads and turn-end notices expose these locations so a caller can inspect and
integrate isolated work, including work left by a failed execution. Directory
placement does not change a member's authority.

## Standalone SDK adapter

The separate `/collaboration/sdk` entry uses ordinary SDK sessions as its
executor. Local setup is lazy. A hosted session does not install another local
collaboration owner. Members inherit host tools, permission floors, model and
shared usage accounting; each member has its own conversation history. External
MCP tools and search are borrowed from the source without duplicating their
connection or service ownership.

Successful context compaction restores a short plain-language record of existing
collaborators, unfinished tasks, recent findings, result references and recent
board activity, so the model does not have to rediscover its collaborators first.
It is not a completion claim or a live feed; ordinary team tools retrieve current
detail. Local collaboration does this automatically. Hosted consumers own their
collaboration state and supply equivalent text as `additionalContext` from a
`PreCompact` hook; there is no collaboration-specific compaction option.
A resumed standalone owner opens its existing collaboration journal lazily when
compaction first needs it; that same owner serves subsequent team operations and
releases its journal on session closure. No journal or runtime is created when
there is no saved collaboration.

With local `modelSelection` registered, `/collaboration/sdk` accepts a narrow
`PreparedModelBinding`: target identity and capability metadata, optional
`modelPricing`, and exactly one explicit standard `providerConfig` or local
`provider` object. Preparation is cancellable and cannot return session options
or alter inherited tools, permissions, hooks, workspace, system prompt or budget.
The adapter routes child provider callbacks through that child's binding rather
than mutating the parent's provider; nested inheritance uses the direct parent.
A bound child may retry its exact connection, but cannot use the parent's model
fallback.
Restoration prepares the saved logical binding and validates its reasoning
against current capabilities, without reselecting by a profile's current name.
Worker host callbacks transport standard provider configurations; custom provider
objects must be constructed in Worker setup, not cloned across the boundary.

Usage continues through shared execution accounting, once per contribution.
Target pricing belongs to the prepared binding, even when the provider reports
an alias. A parent's unit price cannot price a different model's tokens. Missing usage or prices remain unknown for
billing purposes, and model-string aggregation is not an account ledger. These
contracts do not establish real-model task quality or billed savings.

Borrowed MCP instances carry their structured source metadata and a catalog
revision reader. A member refreshes its filtered execution pool when that revision
changes, while keeping its own discovery state and history. Tool discovery policy
and the effective result budget follow the source; they grant no additional tools.
Idle retirement preserves discovery metadata through the ordinary session journal
or in-memory checkpoint, rather than a separate collaborator transcript format.

The SDK adapter retains the final provider stop reason as optional `stopReason`
on result completions and synchronous receipts. A final `max_tokens` result is
not a task failure or completion claim: turn-end notices identify its text as a
truncated last segment and direct the source to `team_read_member` for earlier
output. The notice is added outside the bounded text preview. Continuation stays
bounded; the source decides whether the existing work needs another turn.

`journal.rs` journals committed scope changes with exclusive ownership and
bounded record parsing. A damaged final append is preserved before recovery;
corruption in the middle of the journal is an error. Session transcripts remain
the source for conversation restoration.

`workspaces.rs` validates canonical authorized directories and owns optional
Git worktrees. Workspace preparation is serialized per member, and nested
worktrees carry denied paths through every ancestor. Host shutdown uses the
common Git repository, so cleanup does not depend on another temporary checkout
still existing. Only unchanged checkouts with unchanged HEAD history are removed;
modified, untracked, ignored or unverified work is retained. Workspace paths and
ownership metadata survive idle execution retirement.

The local adapter retains lightweight session checkpoints when it retires an
execution object. `maxIdleSessions` bounds idle SDK objects independently of
member identity/history retention. Active or preparing sessions are never
selected for idle eviction. Background shell registries remain owned by the
collaboration until explicit stop or close, including when no SDK object is
resident. Known artifact policy denials are typed refusals, not uncertain-write
failures.

Message-store lookups receive the current work scope. A host can combine
standing membership with temporary participants without leaking a participant
into another conversation. Stable member identifiers and unambiguous display
names are both accepted for addressing.
The reserved address `lead` resolves through the host's `leadAppId`, including
existing work whose lead has a different stored name. It does not grant contact
or control permissions. A non-lead member named `lead` remains reachable by ID;
new standalone collaborators cannot claim that reserved name. Model-facing
rosters and message headers publish usable addresses, and replies go to the
requester rather than always to the lead.


Large local boards return a bounded preview plus a scoped archive reference.
`team_read_artifact` reads sequential JSONL fragments without requiring filesystem
tools or new model parameters. Two recent snapshots are retained; obsolete
references report expiration and require a fresh board read. Unchanged reads
reuse their snapshot. The memory store bounds records and encoded field bytes,
rejects an oversized mutation before acceptance, and indexes member names.

Source model-turn limits apply across automatic collaboration continuations.
Each loop reports only its newly consumed turns; the source carries the prior
count into the next admission. Session cost snapshots consume the final combined
result, including member usage arriving during stop, exactly once.


Hosts with durable or remote delivery may supply recipient-incarnation hooks.
The bus acquires a ticket before recording a new send, keeps that ticket on the
envelope and trigger, and validates it before admission, live handoff and deferred
dispatch. An existing ticket is never replaced on retry. A synchronous local
provider introduces no promise boundary; only an asynchronous provider delays
admission. Deferred expired deliveries are discarded and their receipts settle.
These hooks are host contracts and add no model-facing tool parameters.
