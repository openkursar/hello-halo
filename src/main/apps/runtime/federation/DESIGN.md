# runtime/federation — Cross-Node Office Federation

Lets one node **host** offices it created and **join** offices hosted elsewhere,
so digital humans from different machines collaborate in one office. A peer of
`runtime/team` (the in-process coordination kernel) and `runtime/im-channels`:
this module owns the office **join handshake**, **presence** runtime, activity
**relay**, and the M2 **authority/replication/resilience** layer. It reads/writes
only through `TeamStore` + `FederationStore` (+ `AuthorityStore` for M2) and the
link; it never touches the team coordination kernel state.

## Layer position — downward-only dependency direction

```
runtime/federation  (this module)
  ├── may import: apps/team (TeamStore), apps/federation (FederationStore/AuthorityStore/OfficeScope),
  │               the `ws` npm library (a library, not the http tier)
  └── MUST NOT import: http/* (websocket.ts, auth/*, identity/*), bootstrap, services/*
```

Everything the module needs from the transport/identity tiers is **injected** by
`bootstrap/extended.ts` through `FederationManagerDeps`:

- host→joiner send + office-client listing (`websocket.ts` primitives),
- office-credential verification (`http/auth/office-credential`),
- local node id / display name / advertised URL (`http/identity`),
- the device-key auth-proof factory and gateway-announce signer (`http/identity`),
- run/roster/presence UI callbacks (mapped to `team:*` renderer events),
- the M2 owner-status / reassign / artifact / history hooks.

The cycle (federation needs transport primitives; transport routes frames into
federation) is broken by the module-level accessor `setFederationManager` /
`getFederationManager` in `manager.ts` (mirrors `setActiveTeamRuntime`).

## Two roles on one node

| | HOST role | JOINER role |
|---|---|---|
| Transport | inbound `federation` frames arrive on this node's WS **server**, routed here by `websocket.ts` → `handleHostInbound` | an outbound `WsFederationClient` connects to the host's server |
| Send | `hostSend(clientId, frame)`, nodeId→clientId resolved from a per-office map | frames ride the single upstream client link |
| Authority (M2) | this node is the office authority (term 0 on first host) | hot-standby; may be elected on host loss |

A node holds a `HostedOffice` per office it authorities and a `JoinedOffice` per
office it joined; both wrap a `Federation` (coordinator + link).

## Files

**Assembly & transport seam**
- `index.ts` — `createFederation(deps)` (coordinator over a link) + the
  `setActiveFederation` accessor and the module's public re-exports.
- `link.ts` — the `FederationLink` dumb-pipe contract
  (`send`/`broadcast`/`onMessage`/`close`) + the in-memory hub/link used by tests.
- `lan-mesh-provider.ts` — `LanMeshLink`, the production link whose outbound
  sender is **repointable** (the transport re-form seam) and whose `deliver`
  feeds inbound frames to the coordinator.
- `ws-federation-client.ts` — joiner-side outbound WS client. Thin transport
  (no join/presence semantics), exponential backoff, per-plane bounded queues
  (`plane-queue.ts`; control → stream → feed → artifact priority drain).
- `plane-queue.ts` — the outbound queue both the joiner client and the gateway
  attachment use. Planes and their bounds come from ONE source,
  `src/shared/federation/planes.json`; the Go gateway's
  `internal/wire/planes_gen.go` is generated from it
  (`node scripts/gen-gateway-planes.mjs`; a guard test fails when it drifts).
  The `feed` plane carries transcript replication and board catch-up pages,
  bounded by count AND bytes, so a slow consumer backfilling history never
  crowds out a wake; ctrl-feed frames stay on `control`. The sender stamps
  `plane: "feed"` on the envelope because the relay does not read payloads.
- `gateway-attach.ts` — host-side **outbound** attachment to a federation gateway
  (one socket per hosted office) speaking the `gw:*` addressed vocabulary, so
  off-LAN members reach the office through the relay. Separate from the joiner
  client by design (addressed sends + attach state vs. un-addressed join client).

**Coordinator & protocol**
- `coordinator.ts` — all join + presence logic. Transport-agnostic; persists
  through `FederationStore` (office_nodes) + `TeamStore` (remote members). Owns
  the suspect/confirmed-offline presence FSM (monotonic silence clock, suspend-safe).
  Join admission mirrors the WS auth layer's **roster re-entry** rule: an
  unverifiable credential from an ALREADY-ADMITTED node (an office_nodes row
  exists; fromNode is session-proven upstream) is admitted as a rejoin — never a
  first admission, and never new members. A rejected join **latches** on both
  sides (every JoinReject reason is terminal for the request as sent), so the
  confirmed-offline recovery paths (heartbeat re-drive / rejoin nudge) stop
  instead of looping; an explicit `requestJoin` or an admitted join re-arms them.
- `protocol-m2.ts` — SSOT for M2 frame shapes, reject reasons and the version
  gate (`isSameProtocol`). The version itself is `FEDERATION_PROTOCOL_VERSION`
  in `src/shared/federation/protocol-version.ts`; see "Compatibility policy".
- `types.ts` — M1 frame shapes (join/presence/wake/turn-complete/stream-frames/
  roster) + frame-plane classification. `presence-constants.ts` — FSM thresholds.
- `deps.ts` — the `FederationStore` / `OfficeCredentialLike` structural contracts.

**Office-shared rows outside the board**

Some office-shared state belongs to the TEAM layer rather than the blackboard: a
member's owner-authored profile (`member_profile` — its team duty, whether it
accepts periodic checks, and whether it is waiting on its owner to decide) and
periodic checks (`check_upsert` / `check_delete`).
They ride the same single-writer log as tasks and epochs — `routeSharedWrite` is
the one implementation of "authority captures locally, joiner sends to the host,
a single machine needs neither" — but their apply is injected as
`applyOfficeState`, because it also has to arm or disarm a local alarm. The
member's *delegated policy* is deliberately NOT among them: it guards one
person's machine, so only that machine holds it; just the accepts-checks bit
travels, on the roster snapshot.

**Who may write what (`office-authority.admitMemberWrite`)**

A write from another node is admitted only for a member that node owns, resolved
from the AUTHENTICATED sender plus the author field the payload carries — never
from an unauthenticated claim. Two consequences worth stating, because both were
learned the hard way:

- *Every op that has an author must name it.* An op that carries none is refused
  outright on any node owning more than one member, non-retryably, and the writer
  silently rolls back a row its user already saw. `update_task` shipped without
  one, so a busy machine could not move a task it was working.
- *Some writes have no member author at all* (`NODE_SCOPED_WRITE_OPS`): a
  conversation's lifecycle (`epoch_upsert`) belongs to the node, and stopping a
  periodic check (`check_delete`) is explicitly allowed to anyone, so the row
  names people the stopping machine need not own. These are admitted per-node —
  the sender must still own a member allowed to make coordination writes, so a
  read-only participant gains nothing.

**The office record (`post_activity`)**

The record of what happened — who messaged whom, who answered, who moved a task
— replicates like a board row rather than as office state: its apply is a plain
insert into `team_activity`, with no alarm to arm. It must be office-shared
because a directed message exists nowhere else AS a message (only inside the two
transcripts it passed through, on machines that may differ), so a record true on
one node only would be worse than none. The rows are immutable — an answer is a
new row pointing back at the message it answers — so there is no update op,
apply is idempotent by id, and a rejected shadow write rolls back to a delete.
The catch-up snapshot carries the open epochs' recent rows (not per task,
because an epoch can consist entirely of messages); applying it only adds rows,
so a standby keeps the older record it already holds.

**Who receives what**

A node's inbound traffic is meant to grow with what it owns, what it shows, and
a digest of the rest, never with the size of the office. Every
subscription-like state is soft state, re-declared after each (re)join,
reconnect or election.

- Live streams — `stream-subscriptions.ts`. A joiner subscribes, at the
  authority, the team sessions its local viewers render in detail (bootstrap
  bridges `services/conversation-detail` into `setWatchedSessions`). The host
  forwards a session's `stream-frames` in full only to its subscribers, never
  back to the producer. Every other node still gets the batch's status events
  (turn start, completion, error, a question or approval waiting; relay
  `statusOnly`, the same rule as `shared/agent-event-visibility` for local
  clients), so a "running" indicator never goes stale on a node that is not
  showing the session. The rule lives in one function, `fanOutStream`, behind
  a `StreamRoute` seam that the first host and an elected authority each supply
  (LAN clients and relayed members; dialed peers, election legs and a claimed
  room; nodes confirmed offline are left out). Every batch the serving node
  receives, from any source (a LAN or dialed-in session, the relay, an
  election leg), passes `acceptServedStream`: it is accepted only from the node
  that owns the streamed member, as proven by the transport (the session
  identity, the relay-stamped sender, the dialed peer) and never from a label
  the frame carries, and it is re-sent to everyone but that node. A relayed
  batch with no stamped sender is dropped. A backed-up LAN client receives
  stream batches reduced to their milestones (`relay.milestoneOnly`), so it
  still ends with the full reply. Replication, ctrl, roster and presence frames
  are never reduced.
- Roster — the coordinator versions its roster. When membership is unchanged
  it sends run state only (`member-status`, changed members). A re-projection
  with nothing changed is an empty status at the current version. A joiner
  whose version does not line up asks for the full roster (`roster-request`).
  A full roster goes out only on a structural change or a join; there is no
  periodic resend (the run-state liveness re-projection keeps sending statuses,
  which is what exposes a missed one).
- Wakes and turn completions — `ctrl-feed.ts`. A node addresses each peer on its
  own feed, `ctrl:<peer>`, which only that peer reads and which prunes on that
  peer's ack alone.
- Session transcripts — lazy replication (`session-feed` `wantsReplica`). A
  joiner copies only the sessions a local viewer shows; the rest are remembered
  from the authority's `feed-digest` frames and subscribed when shown. A copy
  nobody here shows any more is released (`feed-unsubscribe`) after
  `REPLICA_RELEASE_GRACE_MS`, keeping its cursor, so traffic follows the
  sessions shown now. **A
  joiner does NOT keep a copy of a session merely because it messaged or was
  addressed to one of its own members — only sessions a local viewer shows. Do
  not re-add that rule:** a member's session in a piece of work holds its
  exchanges with everyone, so copying it on that basis put the office's busiest
  transcript on every node (measured at host+30: 132 KB per joiner, growing
  with the office), while what was said to our member is already in our
  member's own transcript. History is guaranteed readable while the authority
  is online; a copy that is not local is fetched when shown. The serving node
  sends each peer one full digest when it comes online or its join-request is
  admitted (a quick restart is never seen as an absence), then per tick only the
  feeds that grew since it last told that peer (a full resend every 10 min
  heals a lost one), so an idle office announces nothing.

**Manager (the facade)**
- `manager.ts` — `createFederationManager(deps)`: per-node facade over all hosted
  + joined offices. Owns host/join lifecycle, inbound routing + origin assertions,
  wake dispatch, roster egress, and the transport re-form seam. See below.
- `remote-busy-overlay.ts` — a small self-contained collaborator the manager
  composes: tracks members whose turn is running on a **remote** owner (keyed by
  wake correlationId, TTL-backstopped) so the roster projected to viewers pulses
  joiner-owned members too. Every mutation asks the manager to schedule a
  throttled roster refresh.
- `relay.ts` — `createRelayCapture` (owned member's activity → relaySink) +
  `createStreamReplay` (received activity frames → local agent events, viewer
  renderer zero-change).
- `session-feed.ts` — session-transcript plane over the feed substrate (`log/`).
  Replication is lazy on joiners (see "Who receives what").
  A node that does not serve drops its copy of an unwanted feed a week after
  its epoch ended, rewinding the cursor so that opening the history later
  subscribes afresh.
  the OWNER appends each transcript message to its own `session:<sessionKey>`
  feed (single writer). A consumer writes one history-cache row per entry (the
  rows the manager's cache-first `fetchMemberHistory` reads, so history opens
  locally); only the node that SERVES (the office authority) also keeps the
  verbatim mirror row, because it alone serves feeds onward (joiner↔joiner
  replication over the star). A node elected later starts its mirror mid-feed
  and announces that floor (`truncatedBeforeSeq`), so a consumer behind it skips
  ahead; the hole this leaves in its history copy is detected by the cache-first
  read and filled from the owner. History is guaranteed readable while the
  authority is online — not when the authority's copy is gone — and a copy that
  is not local never reads as "this member said nothing": the read reports the
  owner unreachable instead. Retention: a node that does not serve drops the
  prefix of its own feeds the authority has acked (keeping the last entry, which
  the publisher reads back). Discovery, from an in-memory table of servable feeds
  (the tables are scanned once): an owner announces its own feeds to the
  authority with `feed-advertise` (on append and on the slow re-announce tick);
  the authority announces to peers with `feed-digest`. A consumer that wants a
  feed and is behind answers with `feed-subscribe` from its watermark. A received batch applies in one transaction. Publish
  triggers: the manager's `relaySink` (debounced + finalize pass) and a
  start-time heal.
- `replica-events.ts` — turns what one hot-standby apply pass changed into
  renderer events: each replicated board row is a `team:blackboard` delta the
  renderer merges; `team:updated` (a whole-office reload) is reserved for an
  epoch change, a snapshot, or a catch-up page too large to send row by row.
- `session-deps.ts` — location-aware session deps so a woken member runs with the
  right owner-resolved space. Also where "stop this member" becomes
  position-transparent: a locally-owned member is aborted in place, a remote one
  over the stop plane. Unlike `closeTeamSession`, doing nothing for a remote
  member is not an option — someone asked for a running turn to end.

**M2 authority — `authority/`**
- `office-authority.ts` — the per-office integration root composing the pieces
  below behind one `handle(from, frame)` dispatcher the manager routes `onM2Frame`
  to. Derives election/replication "views" from the office_nodes ledger; applies
  replicated roster ops to it (committed roster) and owns the roster-replication
  API the manager calls on admissions/departures.
- `term-state.ts` (tenure), `election.ts` + `handover.ts` (authority election &
  post-handover reconcile — a freshness-vetoed candidate (STALE_LOG/STALE_ROSTER)
  now catches up from the vetoing voter then re-claims, bounded by the attempt
  cap; the winner broadcasts `authority-announce` so losers realign + re-form
  transport immediately), `reconcile.ts` (owner reachability / orphan re-drive),
  `replication.ts` (blackboard write log + acks to hot-standbys; catch-up
  responses carry the responder's committedSeq, and a standby applies one only
  if it answers its outstanding request. Replayed entries keep the term they
  were committed in. From the believed authority a page is applied whole; from
  any other responder (a voter a vetoed candidate pulls from), entries past its
  committed seq are taken only from the current term onward, so a deposed
  authority's uncommitted older-term tail is not. Only the believed
  authority's response can realign this node's tenure; a voter that already
  knows a newer term is not its winner; a standby pages itself to the
  head, one transaction + one ack + one applied notification per page; a
  snapshot carries tasks, findings, epochs, checks and the open epochs'
  activities). The log is retained whole today. Since the version gate
  guarantees every node reads the full snapshot, pruning is now safe to add
  when the log's size calls for it, with this floor: never past the slowest
  KNOWN standby's ack (a known standby that has not acked since the authority
  took office counts as 0), never inside the newest `REPLICATION_LOG_RETAIN`
  entries; a standby keeps committed − `REPLICATION_LOG_RETAIN`. Its size
  (rows/KB) rides the per-office health line every 10 minutes),
  `scope-gate.ts` (invite-scope enforcement), `governance.ts`,
  `escalation-routing.ts`, `location-aware-blackboard.ts`,
  `artifact-fetch.ts` (lazy artifact bytes), `history-fetch.ts` (transcript pull),
  `stop-turn.ts` (owner-served turn abort: a stop pressed on a viewer's machine
  travels to the node actually running the member's turn — same pending table,
  host relay and ownership gate as the transcript pull, answering a fact rather
  than a payload).

## Compatibility policy

Today: one protocol and an exact-version gate, no negotiation. Every node
speaks exactly `FEDERATION_PROTOCOL_VERSION`
(`src/shared/federation/protocol-version.ts`). The joiner sends it in its
`join-request`; the authority refuses any other version with a
`VERSION_INCOMPATIBLE` join-reject; a joiner refuses a
`join-grant` whose version differs from its own. Either refusal is terminal and
the user sees "This team requires everyone to update Halo to the latest
version" with a check-for-updates action (on a manual join in the join dialog;
on a re-join, including the one at startup, as an `update-required` office
status). A join that carries no version at all is admitted: every socket-borne
join sets one, so only an in-process link omits it. `isSameProtocol` in
`protocol-m2.ts` is the single place where this decision is made. Keep the gate
there, and keep it small.

This holds because federation ships only on internal experience builds whose
users upgrade together. A breaking wire or semantic change ships by bumping the
constant; nothing else is needed.

Revisit before either of these happens: federation ships to users who cannot be
made to upgrade together, or two released versions must work in one office. At
that point, choose between per-peer capability negotiation (and carrying both
forms of every changed frame) and a longer support window at the gate
(accepting a range of versions for one release).

The gateway is not a federation peer. It is a separately deployed server that
may lag the apps, so its wire version (v1 / v2-gw, `gateway-attach.ts`) is
still negotiated on auth. That negotiation is intended and is not a
compatibility leftover to remove.

## Manager internals (`manager.ts`)

Shared per-node state (all keyed by officeId): `hosted`, `joined`,
`turnCompleteWaiters`, the `remoteBusy` overlay, `dialedPeers`,
`officeAddressBooks`, `rosterRefreshTimers`. Function groups:

- **Lifecycle** — `hostOffice` / `joinOffice` build a `Federation` (link +
  coordinator + optional M2 authority + optional gateway attach); `teardownOffice`
  (keeps the re-join record) vs `leaveOffice` (forgets it).
- **Inbound routing + origin assertions** — `handleHostInbound`,
  `handleGatewayInbound`, `handleJoinedInbound`. Every inbound frame is checked:
  its inner `officeId` must match the session's credentialed office, and its
  self-reported `fromNode` must match the identity the session **proved** at the
  WS auth handshake (`getSessionIdentity`) — closing same-office node spoofing.
  `stream-frames`/`turn-complete` (no source node) are asserted by session
  ownership instead. Relayed (gateway) frames trust the gateway's session binding.
- **Wake dispatch** — `sendWakeToMember` + `runOrForwardWakeOnHost` (a joiner→
  joiner wake is relayed through the host to the real owner and refluxed back).
  **The busy gate is on the OWNER, not the sender.** `runLocalTurn` (injected by
  bootstrap) runs the landed wake through `bus.runRelayedTurn`, so it queues
  behind whatever that member is already doing — a teammate's message, or its own
  owner chatting with it on the same session key. It must not go through
  `wakeTarget`: the turn's input was already rendered and booked on the sending
  node. Putting the gate on the sender instead is not an option — its view of a
  remote member is stale by the time the wake crosses the network, and for a
  member it does not own it has no view at all (`session-deps.isSessionActive`
  answers false by design; `remote-busy-overlay` is a display projection, not a
  lock). Skipping the gate entirely is what let a relayed wake start a second
  turn on one session key: see `team/DESIGN.md` "One turn per session" for what
  that does to the shared SDK iterator.
  Consequence for `coordinator.handleWake`: wakes for one session no longer
  collapse into a single turn, so each acks its own `turn-complete`. The old
  batch-ack keyed by `conversationId` was removed — with a queue it answers the
  second wake with the first turn's outcome.
- **Roster egress** — `broadcastRosterFor` (immediate) / `scheduleRosterRefresh`
  (coalesced during a run) / `projectMemberRemoved` / `projectOfficeDissolved`.
- **Transport re-form seam** — after a host loss the authority moves to a peer;
  `repointLink` swaps a link's outbound sender in place (a JOINED office swaps
  only the **upstream** leg inside its router, so the ctrl shim and per-peer
  return paths survive), `redialToAuthority` resolves a sender via the injected
  `PeerDialer` (dialing a peer's **advertised URL** from the address book) and
  repoints to it. This is why nodes advertise a URL at join/host time
  (`advertisedUrl`, migration v5 on office_nodes).
- **Failure-window legs** — when a joined office's believed authority is
  confirmed-offline, `openElectionLegs` dials every known survivor so the
  untouched election module's claims/votes ride reachable transports ("one
  election, two kinds of legs"). A leg is torn down as soon as a better path
  exists: the peer's own inbound session (learned into `JoinedOffice.peerClients`
  by `handleJoinedInbound`) or, for followers, the redial to the new authority.
  The elected survivor answers the star that re-forms around it through those
  inbound sessions; a relay-backed office instead claims its gateway room with
  a term-locked `gw:host-attach` (see Gateway relay below).

> Refactor commitment: `manager.ts` has outgrown its facade role (the joined-
> office transport router — upstream/peer-session/dial-leg/relay resolution —
> now lives inline in `joinOffice`). The router is a self-contained concern and
> is to be extracted into its own module under `runtime/federation/` in the
> next structural pass; new routing behaviour should keep its seams (ctrl shim
> first, per-target resolution, single route per peer) so the extraction stays
> mechanical.

## Node address book

- **Hosted** office: peer addresses are the persisted `office_nodes.advertised_url`
  rows (this node's own ledger).
- **Joined** office: PEER contact cards from the authority's roster projection
  are **persisted** into office_nodes too (address book + the authoritative
  joined_at candidate order survive a restart), but they are presence-UNTRACKED:
  the coordinator's `isPresenceTracked` seam separates "I know your address"
  from "I measure your silence", so only the direct upstream (the believed
  authority, which moves after an election) is silence-swept. Untracked rows
  adopt the authority's presence-update projection into the ledger instead.
  A joined office whose node WINS an election flips to full host semantics —
  every ledger row is tracked (the winner is now the office's only presence
  source), with one fresh grace window granted at the win so survivors get the
  full re-enroll budget before any silence can confirm them offline.
- **Committed roster** — node admissions/departures additionally ride the
  replicated blackboard log (`roster_join`/`roster_leave` via
  `replicateNodeAdmitted`/`replicateNodeLeft`), so the election's quorum
  denominator every node derives from its ledger is the committed set, not a
  local view; `rosterEpoch` aligns across replicas from the same entries.

## Gateway relay (optional, off by default)

When `getGatewayUrl()` returns a URL, `hostOffice` additionally opens a
`GatewayAttachClient`. A node's return path is either `nodeToClient` (direct LAN
WS) or `nodeToGateway` (via relay), kept **mutually exclusive** per node —
whichever path a node's frames last arrived on is its return path. Absent gateway
config → pure-LAN behaviour, unchanged.

Edge assertion + host exemption: a **member** frame carrying `fromNode` must
match its proven session identity (anti-spoof, §9.1). The **host** — the room's
single pinned relay hub — is exempt, because it legitimately forwards frames on
behalf of members whose payload preserves the ORIGINAL requester's `fromNode`
(history/artifact fetch keeps it for the scope seam), which is never the host's
own id. Without the exemption those relayed frames are dropped and cross-member
history/artifact reads hang while everything else looks connected.

v2-gw resilience (wire version negotiated on auth, explicit reject on
incompatibility): `gw:host-attach` carries the authority **term** — the gateway
compares it monotonically only, admitting a higher tenure immediately (election
takeover) and refusing a stale one (`STALE_TERM`), with the retention-window
rule kept for term-less v1 attaches. While a room has NO host, the gateway
relays the ELECTION control vocabulary member↔member (rate-limited, admitted
members only), so a relayed office can elect through it; the winner claims the
room via `ensureJoinedGatewayTakeover` (a joined office learns it is
relay-backed from `gw:host-lost`). The gateway still holds no roster and never
interprets payloads beyond `kind`.

## Where to make a change

| Task | Start here |
|---|---|
| Join/presence semantics, roster snapshot shape | `coordinator.ts` |
| A new office-shared row (not on the board) | `protocol-m2.ts` `ReplicationOp`, then `manager.routeOfficeStateWrite` + the injected `applyOfficeState` |
| A new M2 control frame / reject reason | `protocol-m2.ts`, then the `authority/*` handler; a breaking change also bumps `FEDERATION_PROTOCOL_VERSION` |
| Host/join lifecycle, inbound routing, wake, egress | `manager.ts` |
| Election / replication / reconcile / scope | `authority/*` (via `office-authority.ts`) |
| Transport wiring / injected deps | `bootstrap/extended.ts` (`FederationManagerDeps`) |
| Gateway relay behaviour | `gateway-attach.ts` (+ the gateway Go module, out of this tree) |

## Known gaps

### Roster projection after an election

An authority elected after the first host is lost projects no roster: no full
roster, no `member-status`, no `member-removed`, no liveness re-baseline.
`broadcastRosterFor`, `scheduleRosterRefresh` and `projectMemberRemoved` are
gated on a hosted office, and the elected node stays a joined office. Run state
and membership changes then reach joiners only through board replication, so a
roster card can show a stale run state. This predates the current traffic
rules; live streams after an election do follow them (`fanOutStream`).

Intended fix (not implemented):
- **Promote on win, demote on handover.** Replace the hosted-only gates with one
  predicate, "this node serves the office" (hosted, or joined and
  `isAuthoritySelf()`). Route the roster refresh, full roster, `roster-request`
  answers and `member-removed` through the office's own link, as
  `fanOutStream` does for streams. On step-down, clear the timers and the
  version state.
- **Project from the replica.** `buildRosterSnapshot` reads the host's team
  rows. On a joiner those are shadow rows with owner ids relative to that node,
  so the promoted projection needs a joined-office source that maps
  `SELF_NODE_ID` back to this node's id.
- **Version continuity.** The new authority starts a new roster version line.
  Every joiner mismatches once and asks for the full roster: one burst per
  election.

Size: roughly 300–500 lines across `manager.ts` and `coordinator.ts`, plus a sim
scenario (elect, churn run state, assert `member-status` reaches the joiners)
and coordinator tests for the remapped snapshot. Risks:
- a wrong owner-id remap misattributes members and breaks write and stream
  admission;
- during a flap two nodes may project for one office, so joiners must ignore a
  roster from a node that is not their believed authority;
- it touches the election and re-form paths, so it needs a full
  `test:team -- federation` pass.

## Tests

Traffic bounds (who receives what, per plane and frame kind, and that a joiner's
traffic does not grow with the office) are asserted during development by
`tests/unit/apps/runtime/federation/_sim/traffic-bounds.sim.test.ts`: an office of
real managers (10 to 100 nodes) over an in-process accounting bus on fake timers,
in seconds. The real-process `npm run test:team -- scale` suite is the
release-time confirmation of the same bounds.

Unit tests live in `tests/unit/apps/runtime/federation/*` (in-memory hub +
in-process links; `_fake-gateway.ts` / `gateway-interop.ts` exercise the real Go
binary). Federation/team changes additionally require the multi-process cluster
tier in `tests/decentralized/` (`npm run test:team -- federation`) — build first,
never run suites in parallel.
