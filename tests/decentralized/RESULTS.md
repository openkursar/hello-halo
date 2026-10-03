# Decentralized Office · Backend Consistency Test Results (RESULTS)

> Run at 2026-09-30T16:20:20.875Z · cluster=2 ready node(s) · model key present=true
> Spec: SCENARIOS.md · Driver: run-scenarios.mjs · HTTP/backend-only, real multi-process cluster.

## Summary

| Total | ✅ PASS | ❌ FAIL | ⚠️ PARTIAL | ⏭️ SKIP |
|---|---|---|---|---|
| 14 | 14 | 0 | 0 | 0 |

## Per-scenario

| ID | Status | Evidence |
|---|---|---|
| C4 | ✅ PASS | joiner auto-rejoined: 2 online, roster=3 |
| C5 | ✅ PASS | host auto re-hosted, 2 nodes online |
| C6 | ✅ PASS | joiner role=joined selfAuthority=false hostStatus=gone (expect no self-promotion) |
| E1 | ✅ PASS | all nodes status=running, epoch=480e4b2c-8360-49d4-bcfc-309c9e8bb885 byte-identical |
| E2 | ✅ PASS | member working/idle churn visible on nodes |
| E3 | ✅ PASS | activity/task counts per node=[2,2] agree=true |
| E4 | ✅ PASS | all nodes idle; lingering working=false |
| G1 | ✅ PASS | statuses=[200,200] lens=[0,0] noHistoryNotFound=true |
| G2 | ✅ PASS | message+reply content-consistent, both nodes read 4 msgs |
| G3 | ✅ PASS | owner-down history fetch took 1ms status=200 rows=4 stale=false (expect <12s + local replica or neutral) |
| H1 | ✅ PASS | transcript content-consistent len=3 across nodes |
| H2 | ✅ PASS | transcript content-consistent len=4 across nodes |
| H6 | ✅ PASS | joiner reads its own member transcript (len=4) |
| K1 | ✅ PASS | 50 concurrent sends: transportOk=true accepted=50/50 deliveredAndAgreedAcrossNodes=5/50 (the remainder is discarded at run seal by design) elapsed=18893ms alive=true |
