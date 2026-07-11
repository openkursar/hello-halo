# Decentralized Office · Backend Consistency Scenario Catalog (HTTP-driven · multi-instance)

> **Purpose.** On a single machine, boot N **real** Halo instances (real
> processes, real HTTP/WS, real SQLite, real agent). Drive them over **HTTP
> requests** (not UI clicks) to form an office, collaborate, and inject faults,
> then **assert per-scenario that "backend data is consistent across all
> nodes."** This upgrades "a human clicking through a smoke test" into a
> **repeatable, scalable, self-verifying** regression bench.
>
> **This directory is the product-level verification anchor + the source of
> functional truth for future AI.** Implementation lives in `run-scenarios.mjs`
> in this directory (engineer-implemented from this file).

---

## 0. Scope (read first · honest layering)

**This suite covers = backend / consistency / collaboration-semantics layer**
(exactly where every historical hard bug originated):
join / presence / roster propagation / run / run-state / blackboard replication /
owner-served history / cross-member dispatch (four directions) / governance
(kick / leave / dissolve) / restart recovery / rejoin / security credentials / scope.

**This suite does NOT cover** (needs other means; do not misread "pass = product
fully healthy"):
1. **Render layer**: React render bugs (freezes, animation timing, flicker) — the
   harness drives the main process, there is no renderer. But **the backend root
   cause of those bugs IS catchable here** (e.g. a UI "flash-then-vanish" roots in
   "history not persisted" → asserting `chat-messages` is readable catches it).
   Pure render issues are left to the frontend layer / manual QA.
2. **True network partition**: loopback is same-network zero-latency; partition can
   only be approximated by "kill link / close port" (not faithful).
3. **Clock skew**: each process has its own wall clock; needs injected fake clocks
   (not faithful under local multi-instance).
4. **True cross-machine / NAT / host-drift re-mesh (LAN re-mesh)**: not observable
   over loopback — belongs to M4 / deferred items.

---

## 1. Test bench & running

```bash
npm run build                                                  # 1. build once
# configure the model in .env.local (HALO_TEST_API_KEY / URL / MODEL / PROVIDER)
node scripts/cluster/launch-nodes.mjs start --nodes 5 --fresh  # 2. boot 5 nodes
node tests/decentralized/run-scenarios.mjs --all               # 3. run all scenarios
node scripts/cluster/launch-nodes.mjs stop                     # 4. tear down
```

Each node: isolated `HALO_DATA_DIR` + isolated port + known PIN
(`Authorization: Bearer <pin>`) + isolated federation identity; the manifest is
written to `.cluster/nodes.json` (port / token / identityId / wsUrl).
**The model must actually run** (agent turns need a real model); protocol-only
scenarios (join / presence / roster / governance) can run without a key and are
tagged `[no-model-ok]`.

### 1.1 Core assertion principle (the soul of this suite)
> **After each action, fetch the same data from every participating node and
> assert they are "consistent with each other."**

Common helpers the implementation needs (suggested `tests/decentralized/_lib.mjs`):
- `api(node, method, path, body?)` — HTTP call with Bearer; returns `{status, json}`.
- `pollUntil(fn, {timeoutMs, intervalMs})` — poll until the condition holds or times
  out (for async-convergence assertions).
- `detailOnAll(nodes, teamId)` — GET `/api/teams/:id/detail` on every node, returns
  an array.
- `assertConsistentRoster(details)` — assert each node's roster agrees on {member
  set / lead / edges / per-member status} (status tolerates a ≤2s convergence
  window).
- `assertConsistentBoard(details/boards)` — assert each node's task/finding set is
  consistent, with no duplicate task ids and committedWriteAuthority ≤ 1.
- `chatOnAll(nodes, teamId, appId, epochId)` — GET `/chat-messages` on every node,
  assert transcripts match.
- `killNode(i)` / `reviveNode(i)` — process-level kill/start (fault injection;
  approximates offline/restart).
- `dropLink(i)` / `restoreLink(i)` — close/open a node's outbound WS (approximates
  jitter/partition, marked "not faithful").

### 1.2 HTTP surface (already exists, `src/main/http/routes/team.routes.ts`)
`GET /api/teams/:id` · `GET …/detail` · `GET …/chat-messages` · `POST …/members/:appId/send` ·
`GET …/epochs` · `GET …/epochs/:eid/board` · `GET …/artifacts` · `PATCH …` · `DELETE …` (dissolve) ·
`POST …/members` · `DELETE …/members/:appId` (kick) · `POST /api/teams/propose-members` ·
invite minting + join (federation controller / WS). Run endpoints: see `team.routes`
/ ipc mirror; if only exposed over IPC, the engineer adds a test-only HTTP run entry
or triggers via an existing route.

---

## 2. Scenario catalog

> Columns: `ID` · `node topology` · `steps (HTTP)` · `expectation/assertion
> (focus = cross-node consistency)` · `[guards: historical bug]`
> Status is filled in after the engineer runs: ✅PASS / ❌FAIL / ⚠️PARTIAL /
> ⏭️SKIP(+reason).

### A. Cluster & identity (fundamentals)
| ID | Topology | Steps | Assertion | Status |
|---|---|---|---|---|
| A1 | N=3 | boot 3 nodes | three independent identityIds, independent ports, each `/api/health` 200 | |
| A2 | N=3 | restart a node | identityId unchanged after restart (`node-identity.json` persists) | |
| A3 | N=5 | boot 5 nodes | no port conflicts, no data crosstalk (each DATA_DIR isolated) | |

### B. Office creation / invite / join (AC-1)
| ID | Topology | Steps | Assertion | Status |
|---|---|---|---|---|
| B1 | host+1 | host creates team+members → mints invite → joiner joins with members | both nodes' `/detail` contain both sides' members (with owner tag) | |
| B2 | host+1 | same as B1 | invite link is **stable**: repeated minting returns the same token/jti (A-1 regression) | [guards: A-1 invite re-mint] |
| B3 | host+1 | revoke invite then reuse the old link to join | rejected; already-seated members do not drop | |
| B4 | host+1 | reuse a one-time link / two people concurrently on same link | at most one succeeds (AC-1.5) | |
| B5 | host+4 | 4 joiners join in sequence | all 5 nodes' `/detail` rosters fully consistent (identical member set) | |
| B6 | host+1 | joiner logs in remotely with a custom PIN containing `.` | can log in (F5 regression: not misjudged as office-member and locked out) | [guards: F5] |
| B7 | host+1 | call `/api/*` control endpoints (run/file/shell/PIN-only) with an **office** credential | each returns 401/403 (AC-6.1) | [guards: dual credentials] |
| B8 | host+1 | connect WS with an office credential | receives only authorized office events, never the full `agent:*` firehose | [guards: AC-6.1 WS scope] |

### C. Presence / offline / restart / rejoin (AC-4 / AC-11 / lifecycle)
| ID | Topology | Steps | Assertion | Status |
|---|---|---|---|---|
| C1 | host+1 | killNode(joiner) | that member/node is marked offline within ~13–15s in host `/detail` | |
| C2 | host+1 | dropLink then restore after 2–10s (jitter) | does **not** trigger reassignment, does **not** mark offline (AC-11.4 jitter no false-positive) | [guards: B2 presence] |
| C3 | host+1 | joiner keeps WS connected but heartbeat stalls >13s (approximates frontend freeze) | after being marked offline, **host sends rejoin-request → joiner auto-rejoins**, no deadlock loop | [guards: deadlock/rejoin-on-live-socket] |
| C4 | host+1 | killNode(joiner) then reviveNode | joiner **auto re-joins** on restart (office-recovery), returns to the same office, roster restored | [guards: H-1 re-join] |
| C5 | host | killNode(host) then reviveNode | host **auto re-hosts** on restart, joiner auto-reconnects, office restored | [guards: H-1 re-host] |
| C6 | host+1 | killNode(host) (no restart) | office on the joiner side **honestly pauses** (no fake seamlessness); no split-brain, no self-appointed authority | [guards: AC-5.1 Option-B boundary] |
| C7 | host+1 | joiner rejoins after being offline >24h (approximated by changing system clock) | enters the current office/run, visible state correctly rebuilt, no errors, no half-torn context (AC-11.5) | |

### D. Roster consistency / real-time propagation (AC-1.2 / AC-3.1 / D-1)
| ID | Topology | Steps | Assertion | Status |
|---|---|---|---|---|
| D1 | host+2 | host changes lead | all joiners' `/detail` reflect the new lead within seconds (D-1 continuous propagation, not only at join) | [guards: D-1 + updateTeam missing hook] |
| D2 | host+2 | host adds a member | all nodes' rosters converge to include the new member | |
| D3 | host+2 | host removes a member | all nodes' rosters converge to remove that member | |
| D4 | host+2 | host changes edges/connections | all nodes' edges consistent | |
| D5 | host+2 | two nodes change **simultaneously** (lead vs edges) | final state is deterministic and consistent across all nodes, no write silently dropped (AC-5.6 concurrency) | |

### E. Run + real-time run-state (M1b / signed-Demo backend surface)
| ID | Topology | Steps | Assertion | Status |
|---|---|---|---|---|
| E1 | host+1 | host clicks run | all nodes' `/detail` team.status=running + active epoch consistent; epochId byte-identical across nodes | [guards: run-state/epoch consistency] |
| E2 | host+1 | run in progress | member status shows working/idle across nodes (run-state churn propagated, tolerate throttle window) | [guards: animation/run-state sync] |
| E3 | host+1 | run in progress | all nodes' "recent activity" = the same set of assign/work/done/finding entries (D-2 replica → UI) | [guards: empty activity feed] |
| E4 | host+1 | run ends automatically (quiescence auto-seal) | all nodes set team.status→idle and clear member working within ~1s | [guards: auto-seal lingering] |
| E5 | host+1 | mid-run killNode(joiner-member-owner) | interrupted task correctly marked/reassigned; no loss/duplicate execution (AC-5.5 composite) | |

### F. Blackboard replication / committed-not-lost (AC-5.2 / D5)
| ID | Topology | Steps | Assertion | Status |
|---|---|---|---|---|
| F1 | host+2 | run produces N tasks + findings | all nodes' boards converge consistent; **no duplicate task id**; committedWriteAuthority ≤ 1 (split-brain proxy criterion) | [guards: AC-5.2] |
| F2 | host+2 | killNode(a hot standby) mid-replication | committed writes survive on the successor (no committed loss) | |
| F3 | host+2 | member writes, then owner restarts and replays the same frame | replication_log produces no duplicate rows (fid idempotency) | [guards: bedrock M2 fid] |

### G. Owner-served history / persistence (C-1 · core lifeline)
| ID | Topology | Steps | Assertion | Status |
|---|---|---|---|---|
| G1 | host+1 | for a **remotely-owned** member, GET `/chat-messages` from every node | all return the same transcript (owner-served), no `history-not-found` | [guards: spaceId placeholder/transcript not persisted] |
| G2 | host+1 | send a member a message, then GET history | message+reply are **persisted**, still there after refresh, readable on both nodes | [guards: flash-then-vanish] |
| G3 | host+1 | killNode(member owner) then GET its history | **fast failure + calm error** (no 15s hang, no blank) | [guards: history timeout hang] |
| G4 | host+1 | out-of-scope: request the history of a member not in this office / not owned by that owner | rejected (error code, never leaks another's transcript) (AC-6.2) | |

### H. Cross-member dispatch / peer chat (AC-2.3 / AC-3 / E-1 · all four directions required)
| ID | Topology | Steps | Assertion | Status |
|---|---|---|---|---|
| H1 | host+1 | **host → member owned by joiner** send message | executes on owner (joiner), result flows back, host receives reply; both nodes' history consistent | |
| H2 | host+1 | **joiner → member owned by host** send message | executes on owner (host), flows back to joiner; **no more "wake not sent; resolving empty"** | [guards: one-directional dispatch] |
| H3 | host+2 | **joiner-A → member owned by joiner-B** | routed via host to B's owner, executes, flows back to A | |
| H4 | host+1 | **after a run** (epoch sealed) 1:1 send any member | gets a reply, **not dropped by `completeTurn dropped (epoch sealed)`** | [guards: epoch sealed drop] |
| H5 | host+1 | inside a member's digital human, use `team_send` to dispatch to another member | target member actually receives and executes (not just a fake "Message sent") | [guards: team_send not delivered] |
| H6 | host+1 | joiner watches **its own** member execute in a host run | joiner sees its own member's real-time execution + transcript retained after run (session-key/epoch consistent) | [guards: joiner cannot see its own member] |
| H7 | host+1 | our-side action shows local optimistic echo immediately | echoes on send, not gated on the network round-trip (AC-2.3) | |

### I. Governance: kick / leave / dissolve (§8.8 / G-1/G-3)
| ID | Topology | Steps | Assertion | Status |
|---|---|---|---|---|
| I1 | host+1 | host kicks joiner's member | all nodes' rosters remove it; the kicked side's shadow store is torn down, disconnected, no residue | [guards: G-1] |
| I2 | host+1 | joiner actively "leaves with my member" | both views consistent; joiner no longer dispatched work | |
| I3 | host+1 | host dissolves the office | all nodes tear down the shadow office, disconnect, delete no one's digital-human proper | [guards: G-3] |
| I4 | host+1 | kick leaves joiner with no members in that office | joiner's persistent join-conn is cleared (next startup won't auto-rejoin an office that kicked it) | [guards: case ③ kicked-empty] |
| I5 | host+1 | after dissolve, inspect each node's local residue | no residue in conversations/blackboard/artifacts/identity (Persona C data isolation) | |

### J. Security / scope (AC-6 / AC-7 / F1)
| ID | Topology | Steps | Assertion | Status |
|---|---|---|---|---|
| J1 | host+1 | send a frame with forged `fromNode` (mismatching the authenticated session) | host drops the forged frame (F1 anti-spoof) | [guards: F1 / D-NEW-1] |
| J2 | host+1 | join with an identity='' placeholder credential | join is **allowed** ('' treated as inert, not a false first-frame drop) | [guards: D-NEW-1 sentinel] |
| J3 | host+1 | mint a non-default (narrow) scope | currently rejected (OFFICE_SCOPE_NOT_SUPPORTED, Q-A2 gated=secure) | [guards: Q-A2] |
| J4 | host+1 | (after future device-key lands) end-to-end narrow-scope enforcement | readonly cannot be dispatched/cannot read firehose; lead-only contact restriction — **currently SKIP (D10 deferred)** | ⏭️ |

### K. Concurrency / extremes / stress (AC-10 + robustness)
| ID | Topology | Steps | Assertion | Status |
|---|---|---|---|---|
| K1 | host+1 | send **50 messages concurrently** to the same member | all get replies, transcript has no loss/duplicate, order reasonable; UI-emit does not block | |
| K2 | host+1 | GET history after a very long transcript (many member turns, large output) | returns correctly, no timeout, no OOM | |
| K3 | host+4 | 5 nodes producing frequently + frequent roster changes simultaneously | all nodes converge consistent, no split-brain, no blocking of collaboration under slow-consumer backpressure (AC-10) | |
| K4 | host+4 | rapid repeated join/leave (churn 20×) | roster eventually consistent, no zombie members, no connection leak | |
| K5 | host+9 | 10-node office, host star aggregation | host is not a crash point; broadcast fully delivered, no dropped nodes | |
| K6 | host+1 | repeatedly kill/revive joiner mid-run | each interruption converges correctly, rejoin backfills without duplication (AC-4.4) | |
| K7 | multi-team | multiple offices running in parallel on the same instance | each office's data isolated and internally consistent | |

### L. Multi-team / multi-role combinations (real-world complexity)
| ID | Topology | Steps | Assertion | Status |
|---|---|---|---|---|
| L1 | host+2, 2 teams | two offices, members cross-sourced from different nodes | both teams' roster/board internally consistent, no cross-contamination | |
| L2 | host+2 | **lead is a remote (joiner) member** | remote lead schedules normally, results flow back, experience matches a local lead (AC-3.2) | |
| L3 | host+2 | one digital human is lead of team A and a regular member of team B | both teams' states independently correct | |
| L4 | host+3 | chained: A invites B, B invites C (if re-invite allowed) | C joins with consent; governance policy still correct with the creator absent (AC-7.4) | |

---

## 3. Regression anchors (historical real-machine bugs → guarding scenarios)
> Every bug that "all-green tests missed but real machines exposed" pins a
> scenario, ensuring it cannot recur.

| Historical bug | Guarding scenario |
|---|---|
| relay loopback → both ends' UI freeze (root: host echoes the stream back to the producer) | E3/K1 (assert stream not re-delivered; backend surface) |
| presence false-offline + cannot rejoin even while connected (deadlock) | C2 / C3 |
| spaceId placeholder → transcript not persisted (flash-then-vanish / history-not-found / cannot see own member) | G1 / G2 / H6 |
| joiner → host-owned member dispatch "resolving empty" (one-directional) | H2 / H3 / H5 |
| post-run 1:1 reply dropped by epoch-sealed | H4 |
| run-state/animation/activity feed not synced to joiner | E1 / E2 / E3 |
| members still working after auto-seal | E4 |
| invite link re-minted on every open | B2 |
| custom password containing `.` locks out PIN | B6 |
| F1/D-NEW-1 fromNode forgery / '' sentinel | J1 / J2 |
| kick/dissolve not federation-aware, residue left | I1 / I3 / I5 |

---

## 4. Results & output (filled in after the engineer runs)
- Fill each scenario's status (✅/❌/⚠️/⏭️) + one-line evidence (assertion failure
  point / log snippet / node inconsistency).
- Put a **summary** at the top: total / PASS / FAIL / PARTIAL / SKIP, plus a
  priority ordering of FAILs (which ones block release).
- For each FAIL give: repro command, involved nodes, expected vs actual, initial
  root-cause direction (for later fixing).
- **Do not modify product code** (unless separately assigned); this suite is
  read-only assertions + fault injection.
- Implementation lives in `tests/decentralized/run-scenarios.mjs` (+ `_lib.mjs`,
  optionally split into `scenarios/*.mjs` by category), using
  `scripts/cluster/launch-nodes.mjs` to start/stop the cluster;
  `node tests/decentralized/run-scenarios.mjs --all` runs everything,
  `--only <ID,…>` runs a selection.

## 5. Explicitly out of scope (honest declaration)
Render-layer React bugs · faithful true network partition · true clock skew ·
true cross-machine/NAT/host-drift re-mesh (M4 / LAN re-mesh, deferred). Passing
this suite "all green" **does not mean** the product is fully healthy — those have
other verification means or are deferred items.
