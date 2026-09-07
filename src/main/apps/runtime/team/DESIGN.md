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
- `turn-report.ts` — the lead is told, once, whenever a member's turn ends.
  Everything else here is pull or opt-in, so a member that finishes without
  calling `team_send` left the lead with nothing to react to AND no turn in which
  to notice — see "Output is not delivery" below for why that is not a prompt
  problem. What travels is the FACT of an ending and never a word the member
  said, which is what keeps it clear of the rule that killed auto-delivery.
  Three constraints shape it, and each cost more than it looks. It never
  concludes: "ended with no error" is stated as exactly that, because a model
  that quit early ends the same way as one that is done, and a reassuring word is
  the one output that stops the lead looking. It claims a member filed NOTHING
  only when it watched the whole turn — that combination is the strongest
  evidence of an early quit, which is precisely why it must never be guessed. And
  it counts acts as they are FILED rather than reading them back afterwards: on a
  joined office a member's writes travel to the authority and return replicated,
  so the store can still be empty at the moment its own turn ends.
- `checks.ts` — periodic checks: one member's standing instruction for another
  ("from now on, every half hour, look at this"). Two rules shape it: the alarm
  is armed only on the machine that OWNS the target (so the setter can shut their
  computer, and an away owner simply does not wake), and the row is office-shared
  through an injected `publish` seam (so every node's board shows the same list
  and any member — or the user — can stop one it did not set). A due RECURRING
  check whose target is mid-turn is SKIPPED, never queued (probed here, then
  enforced again at the bus's dispatch gate, which also sees wakes in flight).
  Because that second gate can still refuse, the injected `wake` returns the
  bus's `WakeDisposition` and a skipped round leaves no trace — `runCount`,
  `lastRunAt` and the replicated row are what the panel and the agent read. A
  `once` check inverts both rules, having no next round: it QUEUES on a busy
  target (`onBusy: 'buffer'`), and once handed over it is RETIRED — row dropped,
  delete replicated, because the turn it starts is the record of it. Retiring
  its alarm is left to the scheduler, which disables a one-shot job by itself:
  deleting a job from inside its own due handler pulls it out from under the run
  log written on the way out, so leftovers are swept at `rehydrate()`. Checks
  end with the epoch they were set inside.
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
- `artifact-path.ts` — what a published `ref` MEANS: a file inside the producing
  member's WORKING directory, stored relative to it. Two rules earn their own
  module because publishing and reading must never disagree about them. First,
  the root is the directory the agent actually works in (`getSpaceDir`), never
  the space's internal bookkeeping path — for a space pointed at a project
  folder the two differ, and resolving against the wrong one makes every
  artifact unreadable while every default-space test stays green. Second, an
  absolute path INSIDE that root is folded back to relative rather than refused:
  the model sees absolute paths everywhere, and only the relative form survives
  the trip to a teammate whose copy of the project sits elsewhere. Symlinks are
  resolved before the containment test.
- `artifact-read.ts` — the location-transparent logic behind
  `team_read_artifact`. Resolves the producing member through the published-ref
  SSOT (`apps/team/artifact-refs`: a finding's ref OR a task's resultRef), then
  reads bytes locally (`createLocalArtifactResolver`, resolving through
  `artifact-path`, shared with the federation owner-serve path) or through the
  injected remote fetch. A ref claimed by two members resolves to `ambiguous`
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

So the rule is the one Claude Code's own team tooling states: *your plain output
is not visible to other agents — to communicate you must call the tool*. The
cost is that a model which forgets to call `team_send` leaves its colleague
waiting.

**The rule governs CONTENT, and only content.** It was over-applied once, and
the cost was the whole feature going quiet: with no forwarding at all, a member
that forgot to call the tool — or crashed, or was stopped by hand — produced no
signal of any kind, so the lead took no further turn and no code looked. That is
not the same problem. Which listener a closing line was meant for is
unanswerable; **who stopped** is not a sentence anyone uttered, it is something
the system watched happen. `turn-report.ts` sends that and nothing else. The
digest's failed attempt is the constraint it had to clear (see `board-digest.ts`:
an inference from absence fires forever and trains the reader to skip the block)
and it clears it — every line is a fate that was observed, and a turn that was
not watched produces no claim about it.

**What is still open.** Only the lead is told: a member that messages a PEER and
gets no answer learns nothing, exactly as before. And the content gap is
untouched by design — knowing that someone stopped is not knowing what they
found, and the only way to hear that is still their own `team_send`.

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

Endings that land while the lead is still reading the last notice merge into the
next one, rather than each waking it — the trigger is the lead's own turn ending,
which this module is already told about, so no timer and no second queue. It
holds nothing back for a lead on ANOTHER machine, which can never tell us it has
read one; that lead gets a notice per ending. A notice shed by mailbox overflow
also strands whatever had accumulated behind it, which is a bound worth knowing
and not worth machinery until it is seen.

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

Mailbox liveness has three drains, because a team session also runs turns the
bus never sees (a human 1:1 chat with a member uses the same session key):
1. `completeTurn` — after every BUS-driven turn (the primary path);
2. the session layer's turn-end nudge — app-chat calls `bus.drainMailbox` when
   ANY team-session turn ends, so mail buffered behind a human turn is not
   stranded until the next bus turn (which may never come);
3. a per-session recheck timer armed at buffering — covers the race where the
   target went idle between the busy probe and the buffer push. It re-arms while
   the target is still busy and stops once the mailbox is empty, so mail behind a
   turn that hangs for minutes is not held hostage to that turn ending.

None of the three can free a slot: they all drain, and a drain refuses a session
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
  `onBusy` picks the semantics, and only the caller knows which applies:
  `'buffer'` (mailbox it, deliver at turn end) for a wake that must not be lost
  — an escalation answer is the member's ONLY way back to life, and a one-shot
  check has no second chance; `'skip'` for one that comes round again on its own
  rhythm (a recurring check).
- `runRelayedTurn({ sessionKey, run }) → Promise<T>`
  The **owner-side** gate for a federation wake (see "One turn per session" below).
  Same slot, same mailbox, same cap as everything else; it does NOT go through
  `wakeTarget`, because the turn's input was rendered and booked on the sending
  node and re-entering the session layer here would render a second header, file a
  duplicate act, and start a quiescence sweep on a node that does not own the run.
  `run` is invoked once the slot is free; its promise settles the caller's and
  releases the slot. A `resetEpoch` (or a mailbox overflow) rejects a still-queued
  one rather than leaving the remote caller on its hours-long backstop.
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
`team_read_artifact`, `team_schedule`, `team_unschedule`, `team_complete`
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
  checks?: TeamChecks
  digest?: BoardDigest
  archive?: BoardArchive
}
```

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
  mid-turn), and `buildPromptContext(teamId, selfAppId)` (roster + topology).
  An escalation always marks the member as owing its own person an answer —
  `escalationRouting` never changes that here (see "The escalation preference is
  a prompt, not a gate"). Owns `reconcileAwaitingDecision` — what the office reads
  about a member waiting on its own person, derived rather than pushed (see "Who
  is waiting on whom is derived, not routed"). Its own wakes (escalation resume, quiescence nudge,
  periodic check, turn-end report) go out through `bus.deliverRuntimeWake`, never `wakeTarget`
  directly — the bus owns the busy gate.
- `team-prompt.ts` — `buildTeamEntry(ctx)` / `buildTeamConstraints(ctx)`, the
  Team Entry/Constraint layers (parallel to `im-prompt`). Rendered from a
  `TeamPromptContext` built by orchestration; a team turn runs as a trusted
  member (never an IM guest).

  **The Entry is frozen at session creation, so it must be byte-stable for a
  (team, member) pair.** It is part of the agent session's reuse fingerprint
  (`computeSessionInputsFingerprint`), and a prompt that changes per turn rebuilds
  the CC subprocess on every turn — aborting whichever turn is still streaming.
  That is why `TeamPromptContext` carries no per-turn field: who started the turn
  and whether the sender is blocking on the reply are rendered into the message
  body by `renderEnvelope`, not into the prompt.
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
- The user-facing queue is worked oldest-first (`components/team/EscalationPanel`).
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
by a teammate on ANOTHER machine runs through `runRelayedTurn`, an IM-backed
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
  paths converge on the injected `runTeam`, guarded by the team's
  `currentEpochId` so triggers never overlap a live run.
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
  `/clear`, and all end on dissolve. The mode is persisted on
  `team_epochs.lifecycle` (`'run' | 'conversation'`, v3) and the chat scope on
  `team_epochs.chat_key` (v4); `getCurrentEpochForTeam` is filtered to run epochs
  so open conversation epochs never shadow it.

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
member runs as a trusted team peer — IM guest hardening is intentionally not
applied (no permission context for the team session key). Provider-agnostic: any
IM brand works, since the binding lives in the generic config + dispatch path.

**The binding names a member, not a role.** Promoting a different lead does not
re-point an existing channel. `dispatch-inbound.ts` is the trust boundary for it
(config.json is user-editable and a roster changes after binding): a message is
dropped unless the bound app is still a member of that team AND is locally owned
(`isRemoteMember` false). A federated member's app is not installed on this
machine, so nothing here could run it — the picker offers only `localMembers`
(`TeamListItem`) for the same reason.

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

**A mid-turn delivery does not reach an IM front-desk turn today, and whether it
should is open.** The mechanism is incidental rather than a decision: an IM turn
is started by `dispatch-inbound` calling `sendAppChatMessage` directly, so the
gate sees a session busy with a turn it did not dispatch and falls back to the
mailbox (see `platform/turn-gate` §8 — the guard is aimed at a member's owner
chatting privately, and this path merely looks the same from there).

Both answers are defensible and the trade is real, so it is recorded rather than
settled. Against entering: the turn's final message is what a real person reads,
and an envelope arriving mid-way could redirect it. For entering: a teammate's
answer reaching this member ALREADY ends up in that chat — it wakes a later turn
whose reply is pushed there (next paragraph), so the choice is not whether the
person hears teammate-derived content but whether they hear it inside the answer
they are waiting for or as a second message afterwards. Nothing about the current
behavior depends on having decided.

What must not happen is deciding it by accident: routing IM inbound through the
bus would flip this silently, since the only thing standing between the two
today is which code path starts the turn.

This is **the one place a final message IS a delivery**, and only because the IM
reply handle is attached to this turn — it still reaches no teammate. The bridge
says so explicitly, so the exemption cannot be read as "your output is visible
after all". It also tells the serving member that a teammate's answer cannot
arrive inside this turn: a handed-over question becomes two messages to the
person (an acknowledgement now, the answer when the teammate's `team_send` wakes
it again) rather than one long silence. That is a deliberate trade for the sender
knowing which listener it is talking to.

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
- **delegated policy** — what someone ELSE may make it do. Enforced in
  `app-chat` on the OWNER's machine, for every turn the owner did not start
  (`isBorrowedTeamTurn`). The question is deliberately WHO, not human-vs-model:
  the limit is about what may happen on the owner's machine, and a colleague
  reaching in by hand does the same damage as their digital human doing it — so
  a cross-machine 1:1 from another person is held to it exactly like a
  teammate's `team_send`. The owner's own chat is the one exemption; it is
  recognisable because it goes straight to the session and carries no trigger
  `kind`, a path no office credential can reach (`http/auth/route-scope`). An
  IM-backed turn is out of scope of this rule (see "Team as an IM backend").
  An unset policy withholds nothing. The team's own
  coordination servers (`halo-team`, `halo-report`) are never withheld — they are
  the channel the turn arrived on, not a capability being lent.

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

**Where it does not apply**, and the fallback is always the mailbox:

- A member owned by ANOTHER machine: its turn runs there, and reaching into it
  would need the wake protocol to carry a delivery that expects no completion.
  Deliberately not attempted; `injectIntoSession` finds no local session and the
  message queues as before.
- A turn this runtime did not start — the gate refuses, see `platform/turn-gate`
  §8. Two paths land here for different reasons: a member's owner chatting in the
  same session key (which the guard is FOR), and an IM front-desk turn started by
  `dispatch-inbound` (which it merely catches — see "Team as an IM backend" for
  why that one is unsettled rather than decided).
- A member with mail already queued: order first.
- A stretch of output with no tool call in it. The floor is one model output,
  not zero.

**The known cost.** A message handed to a running turn is context, not a queued
item: if the model reads it and does nothing, nothing records that it was read.
The office record still holds the send itself, so "was it sent" stays answerable
— "was it acted on" was never answerable for any message and is not made worse
here. Left as is deliberately, to be watched in practice rather than machinery
built for it up front.

## One turn per session — the only lock in the design

A team session key (`app-chat:{appId}:team:{teamId}:{epochId}`) runs **at most
one turn at a time**, no matter who asked for it or from which machine. The
bus's `tryReserve` is that rule; everything else queues in the session's single
mailbox (FIFO, cap 128 shedding oldest, drained at turn end plus a re-arming
recheck).

Two turns on one session key is not a slowdown, it is corruption, and it is
worth knowing exactly why. Both turns resolve to the **same live CC subprocess**
(the session is reused), and both call `v2Session.send()` — that part is
harmless, the SDK just enqueues onto one stdin. The damage is on the way out:
`SDKSession.stream()` hands every caller a fresh generator over **one cached
`queryIterator`**, and each generator returns on the first `result` it sees.
Two sends that the CLI folds into one turn produce ONE `result`, so one
consumer returns — possibly holding the other turn's answer — and the other
waits forever on a completion that will never come. If the two turns also differ
in tool set (the owner's own turn is unrestricted, a teammate's is filtered by
the delegated policy — `isBorrowedTeamTurn`), the input fingerprint changes and
`getOrCreateV2Session` tears the subprocess down mid-stream; the three guards
that would defer that rebuild all read the `consumers` map, which app-chat
deliberately never populates.

Hence: **every path that starts a team turn goes through the bus.** Envelopes via
`deliver`, runtime wakes via `deliverRuntimeWake`, and a federation wake landing
on the member's owner via `runRelayedTurn`. The last one is the one that used to
be missing — `bootstrap`'s `runLocalTurn` called `sendAppChatMessage` directly,
so a cross-machine message walked straight into a session a local one already
owned. The gate belongs on the OWNER because busyness is only knowable, and only
still true, on the machine that runs the turn: the sender's view is stale by the
time the wake crosses the network, and `remote-busy-overlay` is a display
projection, not a lock.

One consequence to keep in mind when reading `federation/coordinator.ts`: with a
queue, two wakes for one session no longer collapse into a single turn, so each
gets its own `turn-complete`. The batch-ack that once answered a whole
conversation's wakes with the first outcome was removed — under a queue it hands
wake #2 the outcome of turn #1 before turn #2 has even started.

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
