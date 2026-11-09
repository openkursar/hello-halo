# Collaboration library

This entry owns engine-independent collaboration contracts and coordination.
Importing it starts no sessions, opens no storage and schedules no work. It must
not import the SDK model loop, an execution adapter or a desktop application.

The host owns execution, identities, authorization, storage and transport. Halo
is the host for every engine it runs, including Halo SDK. Standalone consumers
use a local host adapter. A session has one collaboration owner; installing both
hosted and local ownership is invalid.

## Turn admission

`turn-gate.ts` is the shared permission-aware mailbox and exclusive turn
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

`types.ts`, `tool-contract.ts` and `tools.ts` define one typed operation set,
JSON schemas, validation and callable MCP server for all hosts. Operation
callbacks are bound to a trusted caller and work scope. Model arguments cannot
choose a team, permission identity or model source. Only supplied operations
are exposed; hiding a tool never replaces authorization inside a host callback.
The returned server uses the existing in-process, worker and external-engine
MCP bridges without registering another transport.

Creating a collaborator is asynchronous, with isolated context and optional
workspace isolation. An ordinary message can continue existing work. There are
no organization, waiting or team-completion tools. Board records are separate
from dispatch; a finding is shared knowledge, not a directed message.

`artifacts.ts` resolves publication ownership through an injected store. Both
local reads and remote serving use it. Conflicting producers remain ambiguous;
neither a host nor a transport may silently choose one file with that name.

## Shared records and writes

`records.ts` defines the durable task, finding and activity shapes. Halo re-exports
these types for its renderer and storage; it does not duplicate their definitions.
`board-writes.ts` writes through an injected store and then notifies view and
replication observers. Observer failures cannot turn a committed write into a
reported failed write or prevent the other observer from receiving it. Task
updates and parent references must match both the team and work scope before
anything is written. Host permissions and artifact publication checks remain
additional admission requirements.

## Scoped execution

`runtime.ts` owns incremental membership, dispatch admission and execution
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

Borrowed MCP instances carry their structured source metadata and a catalog
revision reader. A member refreshes its filtered execution pool when that revision
changes, while keeping its own discovery state and history. Tool discovery policy
and the effective result budget follow the source; they grant no additional tools.
Idle retirement preserves discovery metadata through the ordinary session journal
or in-memory checkpoint, rather than a separate collaborator transcript format.

`sdk/store.ts` journals committed scope changes with exclusive ownership and
bounded record parsing. A damaged final append is preserved before recovery;
corruption in the middle of the journal is an error. Session transcripts remain
the source for conversation restoration.

`sdk/workspaces.ts` validates canonical authorized directories and owns optional
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
