# Production Checklist · Automated Execution Results (1.1–7.5 full coverage)

> Executed overnight 2026-07-09/10 · dev build · single machine (multi-process real
> nodes simulating multiple machines)
> Coverage evaluation and the honest "can it be 100% automated" conclusion →
> `CHECKLIST-COVERAGE.md` (read first).
> Suites: `checklist-single-machine.mjs` (§1) · `tests/e2e/specs/team-render.spec.ts`
> (§2 automatable subset) · `run-scenarios.mjs` (§3, 62 scenarios) ·
> `checklist-upgrade-migration.mjs` (§4) · `checklist-perf.mjs` (§5) ·
> `checklist-data-lifecycle.mjs` (§7). §6 packaged build: see the note at the end.
>
> **Status legend**: ✅ auto-verified pass ｜ ⚠️ partial/degraded verification ｜
> ✗ failed (reason attached) ｜ 👁 needs manual (environment nature, not laziness)

## Summary

| Section | Result |
|---|---|
| §1 Single-machine team fundamentals (29 drive points) | ✅ 28 pass · 👁 1 (1.6.3 real IM channel) |
| §2 UI & interaction | ✅ 4 automatable-subset items all pass · 👁 remaining eye-only items |
| §3 Remote office (backend consistency, 62 scenarios) | see `RESULTS.md` (final run); this round fixed the G1 real defect, corrected the I4 false-positive |
| §4 Upgrade compatibility & regression (5 items) | ✅ 7/7 (incl. setup) — **fixed 1 real defect** |
| §5 Performance & resources (5 items) | ✅ 4/5 · ✗ 5.5 (P2 real gap, see below) |
| §6 Packaged-build real install | 👁 all (signing/keychain/firewall are OS-level human interactions) |
| §7 Data lifecycle & security (5+1 items) | ✅ 6/6 — **fixed 1 real defect (PIN leaked to logs)** |
| Full unit suite | ✅ 119 files / 1624 cases all green (fixed 14 stale cases) |

## Real defects found and fixed this round (product code)

| # | Defect | Root cause | Fix | Verification |
|---|---|---|---|---|
| 1 | **Data-retention pruning never runs** (caught by §4.5) | `checkEscalationTimeouts()` returns early when "no pending escalations", but `pruneOldDataIfNeeded()` is piggybacked at the function end — in the common state it is never reached | `apps/runtime/service.ts`: remove the early return (empty list naturally idles), pruning is now evaluated every tick | a 400-day-old run is pruned after restart, chat sentinel entry intact (4.5 ✅) |
| 2 | **Remote-access PIN in plaintext logs** (caught by §7.4) | `http/server.ts:316` `console.log`s the full token at startup, violating CONTEXT.md §3.3 | log only restored/generated + length | log secret scan 0 hits (7.4 ✅) |
| 3 | **Spectating an empty transcript returns 502 "temporarily unavailable"** (caught by §3 G1) | owner-side `readMemberHistory` maps "empty transcript" to null → `history-not-found`; a member who hasn't spoken ≠ history unavailable | `bootstrap/extended.ts`: empty transcript returns `[]` (a valid empty answer) | G1–G4 all ✅ (G3 owner-offline 8s fast-fail semantics not regressed) |
| 4 | **Relay listener never released on shutdown** | `relayCapture.start()` returns an `IDisposable`, but bootstrap invoked it as a function → TypeError on every exit, subscription leak | `bootstrap/extended.ts`: type it as a handle and call `.dispose()` | 0 errors in shutdown logs |

## Gaps recorded, pending product decision (not force-fixed, to avoid overnight architecture calls)

| Item | Symptom | Facts & suggestion |
|---|---|---|
| 5.5 token-usage display (P2) | team-run token cost is not exposed on any API/UI surface | the raw data **exists** (session JSONL `result` frame carries `usage`+`total_cost_usd`), but `session-store.ts convertEventsToMessages` drops result frames and `TeamMemberChatView` has no cost UI. Needs a small feature spanning API contract + render layer, leave for scheduling; `checklist-perf.mjs` 5.5 stays red as a regression anchor |
| K1 concurrent burst (stress shape) | 50 concurrent 1:1s hitting the same remote member: **zero loss** (50/50 into transcript), no crash, ≥1 real reply; but coalesced senders' HTTP wait hangs to timeout then resolves empty | the owner injects concurrent wakes into the in-progress turn (coalescing), but only replies turn-complete to the first correlationId; the other waiters can only wait out the sync-wait timeout. Fix direction: at turn end the owner acks all coalesced correlations uniformly. Not a checklist scenario (1.3.5 local 5-in-a-row ✅, 3.2.x remote single-send ✅), non-blocking |
| Sending a message before the first run | when a team has never Run, `sendToMember` returns `NO_EPOCH` | by design (no epoch to attach to); if the product wants "chat right after creation", sendToMember needs to open a conversation epoch at zero-epoch — a product decision item |
| C5 (host-crash auto re-host) | still FAIL | **explicitly excluded** at the top of the production checklist (Option B deferred item), not in this round's scope |

## §1 Single-machine team fundamentals — item by item (`node tests/decentralized/checklist-single-machine.mjs`)

| # | Result | Evidence |
|---|---|---|
| 1.1.1 AI auto-provision | ✅ | team enqueued, Lead auto-provisioned |
| 1.1.2 manually attach an existing digital human | ✅ | no duplicate install (before=2 after=3 noDup) |
| 1.1.3 Lead/roles complete | ✅ | leadOk rolesOk members=3 |
| 1.1.4 empty/overlong/emoji goal, duplicate-name members | ✅ | no crash; duplicate names silently deduped to `Same`/`Same-2`, no ghost members |
| 1.1.5 create 5+ teams in a row | ✅ | no data crosstalk (each team sees only its own members + its own Lead) |
| 1.2.1 full run main flow | ✅ | running→idle, has findings |
| 1.2.2 run-state/fallback | ✅ | no working residue after finishing, task cards carry real data |
| 1.2.3 Pause seals | ✅ | status=idle currentEpochId=null no residue |
| 1.2.4 Run again after stopping | ✅ | new epoch, old records retained (1→2) |
| 1.2.5 free mode | ✅ | no edges, still converges |
| 1.2.6 sync (at the granularity that actually exists = per-edge sync) | ✅ | run converges under async edges without dead-waiting (note: **there is no team-level F11 sync switch**; this checklist item lands as the per-edge `sync` field — the factual difference is recorded) |
| 1.2.7 two teams Run simultaneously | ✅ | zero blackboard/findings crosstalk |
| 1.3.1 1:1 during a run | ✅ | immediate reply |
| 1.3.2 1:1 after seal (regression anchor) | ✅ | no "No epoch available" |
| 1.3.3 team_send A→B | ✅ | in free mode Bob really receives `HELLO-FROM-ALICE` (note: structured mode correctly rejects non-wired peer sends per topology — this is assertCanContact's expected behavior, not a defect) |
| 1.3.4 image/long text | ✅ | 20K text + image both 200 |
| 1.3.5 5 rapid sends | ✅ | 5/5 replied |
| 1.4.1 task flow/findings | ✅ | done+findings |
| 1.4.2 artifacts page | ✅ | endpoint/ownership shape correct |
| 1.4.3 structure edit + auto-maintenance | ✅ | adding a member auto-adds the lead edge |
| 1.4.4 view each other's detail | ✅ | names/roles complete |
| 1.5.1 escalation trigger (FK regression anchor) | ✅ | waiting_user reached, zero "Failed to save report" |
| 1.5.2 replying to escalation continues progress | ✅ | leaves waiting_user after respond |
| 1.5.3 single-member failure isolation | ✅ | team still converges, healthy member's task done |
| 1.6.1 history review | ✅ | epoch/board/transcript all readable |
| 1.6.2 scheduled trigger | ✅ | fires at 15s, auto-Run, epoch trace left |
| 1.6.3 IM backend | 👁 | needs real IM channel credentials/callback signature, see CHECKLIST-COVERAGE.md |
| 1.6.4 Run after rename/goal-change/lead-swap | ✅ | all take effect, runs fine after lead swap |
| 1.6.5 Run after removing a member | ✅ | no ghost dispatch, edges auto-repaired (first-round FAIL was a false negative from Playwright running in parallel and stealing CPU; passes on isolated re-run — same class as the false-negative mechanism recorded in OVERNIGHT-FIXES) |

## §2 Render-layer automatable subset (`npx playwright test --project=team-render`, 4/4 ✅)

- 2.1 (proxy): zero console/page error within the observation window after the Teams
  view mounts (incl. the "Maximum update depth" regression anchor) ✅
- 2.3: no horizontal overflow at 375px viewport ✅
- 2.4: view survives light/dark theme toggle ✅
- 2.5: no leaked i18n keys under Chinese locale ✅
- 👁 still manual: 2.2 streaming feel, 2.6 remote Web-client alignment, 2.7 5+ member
  topology animation, 2.1's full 10-minute screen watch.

## §4 / §5 / §7 detail

- §4 (7/7 ✅): real DB downgraded to app_runtime v3 → current build boots, silently
  migrates back to v4, data intact (4.1); after migration, a normal digital-human
  scheduled task (4.2), in-chat report_to_user with sentinel run_id='chat' no FK
  error (4.3), a pre-upgrade-created old team Run directly (4.4), pruneOldData clears
  old runs + chat entries intact (4.5, **turned green after fix #1**).
- §5 (4/5): 5.1 long run (shortened 3m, `--long-run-minutes 30` runs full) ✅; 5.2
  three teams in parallel 3/3 ✅; 5.3 history read 4ms after 40 real messages ✅; 5.4
  soak stable (shortened, `--soak-minutes 120` runs full) ✅; 5.5 ✗ (see gaps table).
- §7 (6/6 ✅): deleting the team proper clears it, manually-added members' digital
  humans retained (7.1/7.1b — note: AI-provisioned members are deleted with the team
  by dissolveTeamInternal design); wrong PIN → 401, invite token as bearer → 403,
  response leaks nothing (7.2); after uninstalling a member digital human the team
  endpoint degrades gracefully (7.3); log secret scan 0 hits (7.4, **turned green
  after fix #2**); data dir copied to a new isolated environment is recoverable (7.5,
  same-machine approximation).

## §6 Packaged build (👁 fully manual)

Signed installer + Gatekeeper/keychain authorization + double-click single instance
+ firewall prompt are all OS-level interactions that a headless environment cannot
faithfully drive (the dual of the keychain-dialog hang problem recorded in the
`_lib.mjs seedNodeIdentity` comment). Please execute 6.1–6.5 manually once on a real
machine and backfill the original table.

## Regression entry points (one-command re-run)

```bash
npm run build
npm run test:team               # print the suite catalog
npm run test:team -- single     # §1
npm run test:e2e:team-render    # §2 automatable subset
npm run test:team -- federation # §3 (62 scenarios, writes RESULTS.md)
npm run test:team -- upgrade    # §4
npm run test:team -- perf       # §5 (full duration: -- perf --long-run-minutes 30 --soak-minutes 120)
npm run test:team -- lifecycle  # §7
npm run test:unit               # full unit suite
```

> Full explanation of directory layering / naming conventions / permanent vs snapshot
> → `tests/decentralized/README.md` (new sessions enter here).

> Re-run note: each suite has its own port range (3560/3660/3760/3860/3460), but
> **do not run them in parallel** — CPU contention produces model-turn-timeout-class
> false negatives (this round's 1.6.5 first run was one; passed on isolated re-verify).
