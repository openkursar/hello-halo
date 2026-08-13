# Decentralized Office · Backend Consistency Test Results (RESULTS)

> Run at 2026-08-12T09:48:57.835Z · cluster=5 ready node(s) · model key present=true
> Spec: SCENARIOS.md · Driver: run-scenarios.mjs · HTTP/backend-only, real multi-process cluster.

## Summary

| Total | ✅ PASS | ❌ FAIL | ⚠️ PARTIAL | ⏭️ SKIP |
|---|---|---|---|---|
| 3 | 2 | 1 | 0 | 0 |

### ❌ FAILs (real cross-node disagreements — investigate)

- **A2** — node did not come back up after revive

## Per-scenario

| ID | Status | Evidence |
|---|---|---|
| A1 | ✅ PASS | 5 nodes status=all200, uniqueIds=true, uniquePorts=true |
| A2 | ❌ FAIL | node did not come back up after revive |
| A3 | ✅ PASS | 5 nodes, uniquePorts=true, isolatedDataDirs=true |
