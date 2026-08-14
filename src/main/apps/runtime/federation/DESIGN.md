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
  (control → stream → artifact priority drain).
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
- `protocol-m2.ts` — SSOT for M2 frame shapes, capability bits, reject reasons,
  and version negotiation. **`pv` is the protocol major version; current = min
  supported = 3** (device-key node-identity handshake). Pre-3 nodes cannot prove
  a node identity and are rejected at join with `VERSION_INCOMPATIBLE`.
- `types.ts` — M1 frame shapes (join/presence/wake/turn-complete/stream-frames/
  roster) + frame-plane classification. `presence-constants.ts` — FSM thresholds.
- `deps.ts` — the `FederationStore` / `OfficeCredentialLike` structural contracts.

**Office-shared rows outside the board**

Some office-shared state belongs to the TEAM layer rather than the blackboard: a
member's owner-authored profile (`member_profile` — its team duty and whether it
accepts periodic checks) and periodic checks (`check_upsert` / `check_delete`).
They ride the same single-writer log as tasks and epochs — `routeSharedWrite` is
the one implementation of "authority captures locally, joiner sends to the host,
a single machine needs neither" — but their apply is injected as
`applyOfficeState`, because it also has to arm or disarm a local alarm. The
member's *delegated policy* is deliberately NOT among them: it guards one
person's machine, so only that machine holds it; just the accepts-checks bit
travels, on the roster snapshot.

**The office record (`post_activity`)**

The record of what happened — who messaged whom, who answered, who moved a task
— replicates like a board row rather than as office state: its apply is a plain
insert into `team_activity`, with no alarm to arm. It must be office-shared
because a directed message exists nowhere else AS a message (only inside the two
transcripts it passed through, on machines that may differ), so a record true on
one node only would be worse than none. The rows are immutable — an answer is a
new row pointing back at the message it answers — so there is no update op,
apply is idempotent by id, and a rejected shadow write rolls back to a delete.
The catch-up snapshot carries them team-wide rather than per task-epoch, because
an epoch can consist entirely of messages.

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
- `session-feed.ts` — multi-replica session-transcript plane over the feed
  substrate (`log/`): the OWNER appends each transcript message to its own
  `session:<sessionKey>` feed (single writer, never pruned); every peer
  replicates it into a local mirror + the history cache the manager's
  cache-first `fetchMemberHistory` reads, so history opens locally and survives
  an offline owner. The office authority serves the mirrored feeds onward
  (joiner↔joiner replication over the star). Discovery = the `feed-advertise`
  frame (on append / peer-online / slow re-announce tick); a behind consumer
  answers with `feed-subscribe` from its watermark. Publish triggers: the
  manager's `relaySink` (debounced + finalize pass) and a start-time heal.
- `session-deps.ts` — location-aware session deps so a woken member runs with the
  right owner-resolved space.

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
  responses carry the responder's committedSeq),
  `scope-gate.ts` (invite-scope enforcement), `governance.ts`,
  `escalation-routing.ts`, `location-aware-blackboard.ts`,
  `artifact-fetch.ts` (lazy artifact bytes), `history-fetch.ts` (transcript pull).

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
| A new M2 control frame / capability / reject reason | `protocol-m2.ts`, then the `authority/*` handler |
| Host/join lifecycle, inbound routing, wake, egress | `manager.ts` |
| Election / replication / reconcile / scope | `authority/*` (via `office-authority.ts`) |
| Transport wiring / injected deps | `bootstrap/extended.ts` (`FederationManagerDeps`) |
| Gateway relay behaviour | `gateway-attach.ts` (+ the gateway Go module, out of this tree) |

## Tests

Unit tests live in `tests/unit/apps/runtime/federation/*` (in-memory hub +
in-process links; `_fake-gateway.ts` / `gateway-interop.ts` exercise the real Go
binary). Federation/team changes additionally require the multi-process cluster
tier in `tests/decentralized/` (`npm run test:team -- federation`) — build first,
never run suites in parallel.
