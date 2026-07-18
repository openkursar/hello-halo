# Decentralized Office · Backend Consistency Test Results (RESULTS)

> Run at 2026-07-18T10:21:54.114Z · cluster=5 ready node(s) · model key present=true
> Spec: SCENARIOS.md · Driver: run-scenarios.mjs · HTTP/backend-only, real multi-process cluster.

## Summary

| Total | ✅ PASS | ❌ FAIL | ⚠️ PARTIAL | ⏭️ SKIP |
|---|---|---|---|---|
| 62 | 41 | 1 | 2 | 18 |

### ❌ FAILs (real cross-node disagreements — investigate)

- **H4** — post-seal dispatch: no consistent reply within 90s

### ⚠️ PARTIALs (incomplete / weak signal)

- **E2** — no working status observed within 40s (model may be slow/idle)
- **E3** — activity/task counts per node=[0,0,0] agree=true

## Per-scenario

| ID | Status | Evidence |
|---|---|---|
| A1 | ✅ PASS | 5 nodes status=all200, uniqueIds=true, uniquePorts=true |
| A2 | ✅ PASS | identity before=id_So6i9fwYnl0JNNMWGzeOwniMhdCGJOjy after=id_So6i9fwYnl0JNNMWGzeOwniMhdCGJOjy |
| A3 | ✅ PASS | 5 nodes, uniquePorts=true, isolatedDataDirs=true |
| B1 | ✅ PASS | all 5 nodes agree: 6 members, lead=8024f15b-2674-4176-b2b1-30cefbd8376c; host sees remote member=true |
| B5 | ✅ PASS | 5 nodes: all 5 nodes agree: 6 members, lead=8024f15b-2674-4176-b2b1-30cefbd8376c |
| B2 | ✅ PASS | jti1=9aa36caf-f27d-4135-a1f2-b20bbc7384be jti2=9aa36caf-f27d-4135-a1f2-b20bbc7384be tokenSame=true |
| B3 | ✅ PASS | revokedJoinRejected=true (node-3 POST /api/teams/290dfab6-0808-474b-b4d1-88738383521b/join → AUTH_REJECTED (status 200)); seatedMemberRetained=true |
| B4 | ⏭️ SKIP | no one-time invite option on POST /invite (default invites are reusable per B2); cannot drive single-use semantics over HTTP |
| B6 | ✅ PASS | dotToken status=401, nodeStillServes=true (note: cannot drive a real custom-PIN login over this harness; auth-path probe only) |
| B7 | ⏭️ SKIP | office-member HTTP bearer not mintable via harness (PIN-only auth available); cannot exercise dual-credential 401/403 matrix |
| B8 | ⏭️ SKIP | WS office-scope event filtering requires a WS office-credential client; not drivable from this HTTP harness |
| D1 | ✅ PASS | all nodes converged to new lead=33048297-66c1-4ef4-ab02-5543bc95382c |
| D2 | ✅ PASS | all 3 nodes agree: 5 members, lead=33048297-66c1-4ef4-ab02-5543bc95382c |
| D3 | ✅ PASS | removed 630f847f-89da-49af-87e9-1dd963451cee; all 3 nodes agree: 4 members, lead=33048297-66c1-4ef4-ab02-5543bc95382c |
| D4 | ✅ PASS | edges agree across nodes |
| D5 | ✅ PASS | both concurrent writes applied and converged; no silent drop |
| C1 | ✅ PASS | victim node marked suspect in presence |
| C2 | ⏭️ SKIP | WS-link jitter (dropLink/restoreLink) not faithfully reproducible over loopback; SCENARIOS §0.2 marks link-loss as non-faithful |
| C3 | ⏭️ SKIP | heartbeat-stall-on-live-socket requires injecting a frozen renderer/heartbeat; not drivable at HTTP layer |
| C4 | ✅ PASS | joiner auto-rejoined: 2 online, roster=3 |
| C5 | ✅ PASS | host auto re-hosted, 2 nodes online |
| C6 | ✅ PASS | joiner role=joined selfAuthority=false hostStatus=suspect (expect no self-promotion) |
| C7 | ⏭️ SKIP | >24h offline rejoin needs clock injection; shared wall clock on one machine (SCENARIOS §0.3) |
| E1 | ✅ PASS | all nodes status=running, epoch=8251505e-104a-4626-affe-25a0495cafa3 byte-identical |
| E2 | ⚠️ PARTIAL | no working status observed within 40s (model may be slow/idle) |
| E3 | ⚠️ PARTIAL | activity/task counts per node=[0,0,0] agree=true |
| F1 | ✅ PASS | task-id sets agree (n1:0,n2:0,n3:0); authoritySelf=1 |
| E4 | ✅ PASS | all nodes idle; lingering working=false |
| E5 | ⏭️ SKIP | requires a running task owned by a killed joiner mid-run; timing-fragile under shared-CPU model contention, not deterministic at HTTP layer |
| F2 | ⏭️ SKIP | hot-standby inheritance (M2 replication) needs >=2 standbys + authority handover, not faithfully reproducible on loopback (SCENARIOS §0.2) |
| F3 | ⏭️ SKIP | replication_log fid idempotency on replay is internal DB state not exposed over HTTP |
| G1 | ✅ PASS | statuses=[200,200] lens=[0,0] noHistoryNotFound=true |
| G2 | ✅ PASS | message+reply content-consistent, both nodes read 2 msgs |
| G3 | ✅ PASS | owner-down history fetch took 5ms status=200 rows=2 stale=false (expect <12s + local replica or neutral) |
| G4 | ✅ PASS | non-member appId history request status=404 rejected=true |
| H1 | ✅ PASS | transcript content-consistent len=2 across nodes |
| H2 | ✅ PASS | transcript content-consistent len=2 across nodes |
| H3 | ✅ PASS | transcript content-consistent len=2 across nodes |
| H7 | ✅ PASS | send acked in 1690ms status=200 (server-side dispatch ack; true UI optimistic echo is renderer-only) |
| H4 | ❌ FAIL | post-seal dispatch: no consistent reply within 90s |
| H5 | ⏭️ SKIP | in-agent team_send tool dispatch is driven by the model from inside a run, not directly invokable over the HTTP control plane |
| H6 | ✅ PASS | joiner reads its own member transcript (len=0) |
| I1 | ✅ PASS | kicked member removed from host roster (del status=200) |
| I4 | ✅ PASS | post-kick persisted join-conn rows=0 (expect 0 → no auto-rejoin on next start); live presence=joined |
| I2 | ✅ PASS | joiner left; both views consistent (leave status=200) |
| I3 | ✅ PASS | dissolve status=200; hostTeamGone=true, joinerShadowTorn=true |
| I5 | ✅ PASS | post-dissolve: joiner local benches intact=true, office shadow removed=true |
| J1 | ⏭️ SKIP | fromNode spoof rejection is a WS-frame-level check; requires a raw WS client forging frames, not reachable via HTTP control plane |
| J2 | ⏭️ SKIP | empty-identity ('') sentinel join-admission is internal to the WS join handshake; not observable/injectable via HTTP |
| J3 | ✅ PASS | narrow scope rejected: OFFICE_SCOPE_INVALID |
| J4 | ⏭️ SKIP | narrow-scope end-to-end enforcement gated on device-key (D10 deferred) per SCENARIOS J4 |
| K1 | ✅ PASS | 50 concurrent sends: transportOk=true repliedWithContent=50 deliveredInTranscript=50/50 elapsed=6167ms alive=true (coalescing per-send-reply semantics flagged in RESULTS for product review) |
| K2 | ⏭️ SKIP | super-long transcript GET needs a long real run to build volume; covered functionally by G1/G2, perf/OOM not asserted at HTTP layer |
| K3 | ✅ PASS | 5-node office roster: all 5 nodes agree: 6 members, lead=7cdbbd4d-7f3d-45d6-945b-a620e5ed8ee2 |
| K4 | ✅ PASS | after 8 join/leave cycles: all 1 nodes agree: 2 members, lead=33b0c2f9-ab2f-4254-bd1d-cd33571138c8; lingering remote members=0 (expect 0) |
| K5 | ⏭️ SKIP | host+9 (10 nodes) exceeds this run’s cluster size; would need --nodes 10 and heavy CPU; not run by default |
| K6 | ⏭️ SKIP | run-time repeated kill/revive of a member-owner is timing-fragile under shared-CPU model contention (same class as E5) |
| K7 | ✅ PASS | two offices isolated: A=3 B=3 members, overlap=0 |
| L1 | ✅ PASS | two offices each consistent (A:true B:true), no cross-pollution=true |
| L2 | ✅ PASS | remote member promoted to lead, converged on both nodes |
| L3 | ⏭️ SKIP | same digital human as lead in A + member in B requires sharing one appId across two offices; harness provisions distinct members per office, cannot reuse identity this way over HTTP |
| L4 | ⏭️ SKIP | chained re-invite (B invites C) requires a joiner to mint an invite for an office it joined; invite minting is host/authority-only on this surface |
