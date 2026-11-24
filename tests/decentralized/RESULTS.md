# Decentralized Office · Backend Consistency Test Results (RESULTS)

> Run at 2026-11-11T09:04:01.355Z · cluster=5 ready node(s) · model key present=true
> Spec: SCENARIOS.md · Driver: run-scenarios.mjs · HTTP/backend-only, real multi-process cluster.

## Summary

| Total | ✅ PASS | ❌ FAIL | ⚠️ PARTIAL | ⏭️ SKIP |
|---|---|---|---|---|
| 67 | 39 | 5 | 2 | 21 |

### ❌ FAILs (real cross-node disagreements — investigate)

- **G2** — no consistent assistant reply after current message (send status=200)
- **H1** — no consistent assistant reply after current message within 90s
- **H2** — no consistent assistant reply after current message within 90s
- **H3** — no consistent assistant reply after current message within 90s
- **H4** — post-seal dispatch: no consistent assistant reply after current message within 90s

### ⚠️ PARTIALs (incomplete / weak signal)

- **E2** — no working status observed within 40s (model may be slow/idle)
- **E3** — activity/task counts per node=[0,0,0] agree=true

## Per-scenario

| ID | Status | Evidence |
|---|---|---|
| A1 | ✅ PASS | 5 nodes status=all200, uniqueIds=true, uniquePorts=true |
| A2 | ✅ PASS | identity before=id_VywMhqt0WsCy_F2td9kVIF313WEt8R4w after=id_VywMhqt0WsCy_F2td9kVIF313WEt8R4w |
| A3 | ✅ PASS | 5 nodes, uniquePorts=true, isolatedDataDirs=true |
| B1 | ✅ PASS | all 5 nodes agree: 6 members, lead=dc7ea023-6990-4a35-a1e0-327ce56035a1; host sees remote member=true |
| B5 | ✅ PASS | 5 nodes: all 5 nodes agree: 6 members, lead=dc7ea023-6990-4a35-a1e0-327ce56035a1 |
| B2 | ✅ PASS | jti1=f7e7093a-868c-49fe-a935-4c38ebbe4dc1 jti2=f7e7093a-868c-49fe-a935-4c38ebbe4dc1 tokenSame=true |
| B3 | ✅ PASS | revokedJoinRejected=true (node-3 POST /api/teams/7df6fe7c-71d8-44f7-a424-0a3b9356d4b9/join → AUTH_REJECTED (status 200)); seatedMemberRetained=true |
| B4 | ⏭️ SKIP | no one-time invite option on POST /invite (default invites are reusable per B2); cannot drive single-use semantics over HTTP |
| B6 | ✅ PASS | dotToken status=401, nodeStillServes=true (note: cannot drive a real custom-PIN login over this harness; auth-path probe only) |
| B7 | ⏭️ SKIP | office-member HTTP bearer not mintable via harness (PIN-only auth available); cannot exercise dual-credential 401/403 matrix |
| B8 | ⏭️ SKIP | WS office-scope event filtering requires a WS office-credential client; not drivable from this HTTP harness |
| D1 | ✅ PASS | all nodes converged to new lead=50cb3a0b-9bf1-4031-9df3-c978f86de1e1 |
| D2 | ✅ PASS | all 3 nodes agree: 5 members, lead=50cb3a0b-9bf1-4031-9df3-c978f86de1e1 |
| D3 | ✅ PASS | removed 824c3cef-0529-4ed6-a054-031306584729; all 3 nodes agree: 4 members, lead=50cb3a0b-9bf1-4031-9df3-c978f86de1e1 |
| D4 | ✅ PASS | edges agree across nodes |
| D5 | ✅ PASS | both concurrent writes applied and converged; no silent drop |
| C1 | ✅ PASS | victim node marked suspect in presence |
| C2 | ⏭️ SKIP | WS-link jitter (dropLink/restoreLink) not faithfully reproducible over loopback; SCENARIOS §0.2 marks link-loss as non-faithful |
| C3 | ⏭️ SKIP | heartbeat-stall-on-live-socket requires injecting a frozen renderer/heartbeat; not drivable at HTTP layer |
| C4 | ✅ PASS | joiner auto-rejoined: 2 online, roster=3 |
| C5 | ✅ PASS | host auto re-hosted, 2 nodes online |
| C6 | ✅ PASS | joiner role=joined selfAuthority=false hostStatus=suspect (expect no self-promotion) |
| C7 | ⏭️ SKIP | >24h offline rejoin needs clock injection; shared wall clock on one machine (SCENARIOS §0.3) |
| E1 | ✅ PASS | all nodes status=running, epoch=af3a1d85-d3b6-4866-83d0-d8c67c97009d byte-identical |
| E2 | ⚠️ PARTIAL | no working status observed within 40s (model may be slow/idle) |
| E3 | ⚠️ PARTIAL | activity/task counts per node=[0,0,0] agree=true |
| F1 | ✅ PASS | task-id sets agree (n1:0,n2:0,n3:0); authoritySelf=1 |
| E4 | ✅ PASS | all nodes idle; lingering working=false |
| E5 | ⏭️ SKIP | requires a running task owned by a killed joiner mid-run; timing-fragile under shared-CPU model contention, not deterministic at HTTP layer |
| F2 | ⏭️ SKIP | hot-standby inheritance (M2 replication) needs >=2 standbys + authority handover, not faithfully reproducible on loopback (SCENARIOS §0.2) |
| F3 | ⏭️ SKIP | replication_log fid idempotency on replay is internal DB state not exposed over HTTP |
| G1 | ✅ PASS | statuses=[200,200] lens=[0,0] noHistoryNotFound=true |
| G2 | ❌ FAIL | no consistent assistant reply after current message (send status=200) |
| G3 | ✅ PASS | owner-down history fetch took 3ms status=200 rows=1 stale=false (expect <12s + local replica or neutral) |
| G4 | ✅ PASS | non-member appId history request status=404 rejected=true |
| H1 | ❌ FAIL | no consistent assistant reply after current message within 90s |
| H2 | ❌ FAIL | no consistent assistant reply after current message within 90s |
| H3 | ❌ FAIL | no consistent assistant reply after current message within 90s |
| H7 | ✅ PASS | send acked in 445ms status=200 (server-side dispatch ack; true UI optimistic echo is renderer-only) |
| H4 | ❌ FAIL | post-seal dispatch: no consistent assistant reply after current message within 90s |
| H5 | ⏭️ SKIP | in-agent team_send tool dispatch is driven by the model from inside a run, not directly invokable over the HTTP control plane |
| H6 | ✅ PASS | joiner reads its own member transcript (len=3) |
| I1 | ✅ PASS | kicked member removed from host roster (del status=200) |
| I4 | ✅ PASS | post-kick persisted join-conn rows=0 (expect 0 → no auto-rejoin on next start); live presence=joined |
| I2 | ✅ PASS | joiner left; both views consistent (leave status=200) |
| I3 | ✅ PASS | dissolve status=200; hostTeamGone=true, joinerShadowTorn=true |
| I5 | ✅ PASS | post-dissolve: joiner local benches intact=true, office shadow removed=true |
| J1 | ⏭️ SKIP | fromNode spoof rejection is a WS-frame-level check; requires a raw WS client forging frames, not reachable via HTTP control plane |
| J2 | ⏭️ SKIP | empty-identity ('') sentinel join-admission is internal to the WS join handshake; not observable/injectable via HTTP |
| J3 | ✅ PASS | narrow scope rejected: OFFICE_SCOPE_INVALID |
| J4 | ⏭️ SKIP | narrow-scope end-to-end enforcement gated on device-key (D10 deferred) per SCENARIOS J4 |
| K1 | ✅ PASS | 50 concurrent sends: transportOk=true accepted=50/50 deliveredAndAgreedAcrossNodes=50/50 (the remainder is discarded at run seal by design) elapsed=602ms alive=true |
| K2 | ⏭️ SKIP | super-long transcript GET needs a long real run to build volume; covered functionally by G1/G2, perf/OOM not asserted at HTTP layer |
| K3 | ✅ PASS | 5-node office roster: all 5 nodes agree: 6 members, lead=2cf81097-3636-46fb-aa03-41bbadb757b5 |
| K4 | ✅ PASS | after 8 join/leave cycles: all 1 nodes agree: 2 members, lead=10cd5c61-64d8-4964-80f7-2a4cb4e7c4fc; lingering remote members=0 (expect 0) |
| K5 | ⏭️ SKIP | host+9 (10 nodes) exceeds this run’s cluster size; would need --nodes 10 and heavy CPU; not run by default |
| K6 | ⏭️ SKIP | run-time repeated kill/revive of a member-owner is timing-fragile under shared-CPU model contention (same class as E5) |
| K7 | ✅ PASS | two offices isolated: A=3 B=3 members, overlap=0 |
| L1 | ✅ PASS | two offices each consistent (A:true B:true), no cross-pollution=true |
| L2 | ✅ PASS | remote member promoted to lead, converged on both nodes |
| L3 | ⏭️ SKIP | same digital human as lead in A + member in B requires sharing one appId across two offices; harness provisions distinct members per office, cannot reuse identity this way over HTTP |
| L4 | ⏭️ SKIP | chained re-invite (B invites C) requires a joiner to mint an invite for an office it joined; invite minting is host/authority-only on this surface |
| M1 | ✅ PASS | conversation created on joiner (pre-run) is office-wide consistent (2 nodes) |
| M2 | ✅ PASS | rename on host converged on the joiner |
| P1 | ⏭️ SKIP | Select the scripted participant group separately; acceptance runs group model modes automatically. |
| P2 | ⏭️ SKIP | Select the scripted participant group separately; acceptance runs group model modes automatically. |
| P3 | ⏭️ SKIP | Select the scripted participant group separately; acceptance runs group model modes automatically. |
