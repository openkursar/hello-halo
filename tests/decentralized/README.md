# tests/decentralized — Cluster Regression Suites (Digital Team / Remote Office)

> **What this directory is.** The third test tier of this repo, alongside
> `tests/unit` (vitest) and `tests/e2e` (Playwright). These are **cluster
> regression suites**: each `checklist-*.mjs` / `run-scenarios.mjs` file is a
> Node driver that boots one or more REAL Halo instances (real Electron main
> process, real SQLite, real HTTP/WS, real model turns) via
> `scripts/cluster/launch-nodes.mjs`, drives them over HTTP, and asserts
> real end-to-end outcomes. They are deliberately NOT vitest/Playwright:
> multi-process orchestration, multi-minute model turns, and fault injection
> (kill/revive nodes) do not fit either runner's worker/timeout model.

## Why bare `node` drivers (and the conventions that make them recognizable)

| Convention | Rule |
|---|---|
| File naming | `run.mjs` = the launcher (suite catalog + dispatcher); `checklist-<section>.mjs` = one production-checklist section; `run-scenarios.mjs` = the federation scenario catalog (SCENARIOS.md); `_lib.mjs` = shared harness (leading `_` = not runnable) |
| Entry points | One `package.json` script — `test:team` → `run.mjs`. Low-frequency specialist suites do not each get a top-level script; the launcher lists and dispatches them. |
| Verdicts | Every suite prints per-item ✅/❌/⚠️/⏭️ and exits non-zero on FAIL |
| Language | English only — code, comments, specs, and result/report `.md` files (repo open-source convention). The only Chinese in this repo lives under `local_docs/` (internal product docs). |
| Isolation | Each suite uses its own cluster dir + port range; node state lives in gitignored `.cluster*/` dirs |

## File taxonomy

```
tests/decentralized/
├── README.md                        ← this guide (start here)
│
│  PERMANENT — executable regression suites
├── run.mjs                          ← launcher: `npm run test:team` → prints catalog, dispatches to a suite
├── _lib.mjs                         ← shared harness: cluster lifecycle, HTTP, assertions, fault injection
├── run-scenarios.mjs                ← §3 federation catalog (62 scenarios; spec = SCENARIOS.md; writes RESULTS.md)
├── checklist-single-machine.mjs     ← §1 single-machine team fundamentals
├── checklist-upgrade-migration.mjs  ← §4 upgrade/migration compatibility
├── checklist-perf.mjs               ← §5 performance (accepts --long-run-minutes / --soak-minutes)
├── checklist-data-lifecycle.mjs     ← §7 data lifecycle & security
├── checklist-federation-scale.mjs   ← host+30: per-joiner inbound ∝ own + open + digest, read from each node's rx health line
│                                       (release-time confirmation; the same bounds are asserted in seconds during
│                                       development by tests/unit/apps/runtime/federation/_sim/traffic-bounds.sim.test.ts)
│
│  PERMANENT — specs & coverage docs (source of truth for AI regression)
├── SCENARIOS.md                     ← federation scenario spec (what run-scenarios.mjs implements)
├── CHECKLIST-COVERAGE.md            ← automation-boundary map: what is automated vs. forever-manual
│
│  SNAPSHOTS — dated evidence, not executables (archive after release)
├── RESULTS.md                       ← last full run-scenarios.mjs output (overwritten each run)
├── RESULTS-checklist.md             ← production-checklist execution results
├── OVERNIGHT-FIXES.md               ← historical fix/verification report
│
│  ARCHIVE — one-shot verification scripts whose assertions were absorbed
└── _archive/                        ← verify-*.mjs (dated, superseded by the suites above)
```

The §2 render-layer subset lives with the other renderer tests:
`tests/e2e/specs/team-render.spec.ts` (`npx playwright test --project=team-render`).

## Running

```bash
npm run build                        # once per code change (suites run the built app)

npm run test:team                    # print the suite catalog + prerequisites
npm run test:team -- workbench       # task conversation, collaboration, archive/resume and decisions
npm run test:team -- people          # independent decisions, workspace retention and self-awareness
npm run test:team -- single          # §1 single-machine fundamentals
npm run test:team -- federation      # §3 federation, all 62 scenarios (writes RESULTS.md)
npm run test:team -- upgrade         # §4 upgrade/migration
npm run test:team -- perf            # §5 performance (add --long-run-minutes / --soak-minutes for full length)
npm run test:team -- lifecycle       # §7 data lifecycle & security
npm run test:team -- scale           # host + 30 joiners (31 nodes; heavy — run alone)
                                     # (traffic bounds are first asserted in-process, in seconds, by
                                     #  tests/unit/apps/runtime/federation/_sim/traffic-bounds.sim.test.ts)
```

A single `npm run test:team` entry dispatches to all suites (see `run.mjs`), rather
than five top-level scripts — the launcher self-documents the catalog and forwards
any extra args (e.g. `-- federation --only G1,K1`) to the driver.

### Acceptance integration

The federation driver and the single-machine creation checks declare their
acceptance bindings beside their executable code. Discovery reads those exports;
it does not start a node or infer verification from a historical report:

```bash
npm run test:team -- federation --list
npm run test:team -- single --list
node --test tests/decentralized/acceptance-adapter.test.mjs
```

`scripts/acceptance/adapters/cluster.mjs` exposes `discoverClusterTests(root)` and
`executeClusterTests(root, tests, { outputDirectory, eventFile, environment,
timeoutMs })`. The latter validates the complete selected declarations, expands
their prerequisite checks and runs groups sequentially. Node topology is part of
the group: the two-node minority case cannot share a three-node office fixture.
The shared acceptance runner owns the build identity, run budget and live-model
broker. Protocol-only groups clear model credentials and signed-in sources,
including names that `.env.local` could otherwise restore. Live groups require
the explicitly supplied local budget broker.

These bindings are `integration` evidence, never UI end-to-end evidence. Native
`PARTIAL` is a failure; `SKIP` remains skipped; missing records establish no pass.
Prerequisite failures also fail the dependent acceptance case. Structured
`begin`/`test`/`end` events carry the actual bindings and native check evidence.
Per-case duration is omitted where the original driver shares setup; the final
event records the measured group duration.

Acceptance execution writes reports to its ignored run directory and never
overwrites the tracked `RESULTS.md`. Node profiles contain ephemeral credentials
and are removed after owned-process cleanup. New and revived nodes inherit the
acceptance process group so a timeout can stop them even during startup, before
the cluster manifest exists. Ordinary standalone cluster runs retain their
existing detached behavior and report location.

Only cases with executable assertions are bound. Permanently skipped, obsolete
or insufficiently asserted historical scenarios remain outside this manifest
until their executable contract is reconciled; listing a scenario is not a
claim that it has run successfully.

A suite keeps its previous run's cluster dir as `<dir>.prev` (one generation), so a
red run can still be diffed after the next one starts; stale nodes from that run are
stopped before the dir is moved.

Rules that keep results trustworthy:

1. **Never run suites in parallel.** N Electron processes + N model streams
   starve the CPU and produce timeout-shaped false negatives (documented in
   OVERNIGHT-FIXES.md and reconfirmed since). Re-verify any red item in
   isolation (`run-scenarios.mjs --only <IDs>`) before treating it as real.
2. **Model config** comes from `.env.local` (`HALO_TEST_API_KEY/URL/MODEL/PROVIDER`);
   protocol-only scenarios run without a key and are marked `[no-model-ok]`.
3. **Stale nodes hold ports.** If a prior run died, `pkill -f "out/main/index"`
   before starting (launch-nodes `stop` only kills pids in the current manifest).
4. `.cluster*/` dirs contain node data + the seeded model key — never commit.

## What this tier can NEVER cover (do not fake it)

Per CHECKLIST-COVERAGE.md: packaged-build installs (keychain/Gatekeeper/firewall
dialogs), true multi-machine networks (partition/latency/NAT), clock skew, and
human visual judgment of the render layer. Those stay manual; record results in
`local_docs/features/数字团队/产品/投产测试清单.md` directly.

### Task workbench verification

`npm run test:team -- workbench` creates one disposable node under the system
temporary directory and drives real model turns through the public HTTP API.
It verifies distinct task identities, creator grouping, per-member transcript
isolation and provenance, directed coordination, archive/resume history, and two
independent questions for one member across tasks. The node is stopped and its
credential-bearing test data removed in `finally`. Supply the model through the
existing test environment variables. Run it after renderer checks, not alongside
another Electron suite. A missing model response fails the prerequisite; it is
not counted as a passed collaboration check.

For an endpoint that must bypass the host's system proxy, set
`HALO_TEST_NO_PROXY=1`; only the disposable cluster Electron processes receive
`--no-proxy-server`. This does not alter the user's application or OS settings.

### Live-turn review regression

`npm run test:team -- live-turn` creates a disposable space conversation and asks
its real model to coordinate three specialist reviewers. Each reviewer generates
a fresh receipt unknown to the coordinator, reviews a small code fixture, and
sends its finding through the production team-message route. The coordinator
runs separate slow validation commands meanwhile. The suite checks that the
original turn incorporates all three receipts, that reports are reflected in the
next command after a tool boundary, and that completion notices do not cause a
sequence of follow-up turns. It keeps only sanitized timing/count evidence and
removes the credential-bearing node directory on every exit.

Select a configured backend explicitly; the test refuses an engine fallback:

```bash
npm run test:team -- live-turn --engine codex --model <configured-gpt-model> --api-type responses --env-file /path/to/.env.local --output /tmp/live-turn-gpt.json
npm run test:team -- live-turn --engine anthropic --model <configured-claude-model> --env-file /path/to/.env.local --output /tmp/live-turn-claude.json
```

The endpoint and credential come from the normal test environment, not model
names. Use `--api-type anthropic_passthrough` only when the configured provider
expects native Anthropic requests. The launcher also accepts
`HALO_TEST_SDK_ENGINE` and `HALO_TEST_API_TYPE`; omitting them preserves the
existing default engine and Chat Completions source. Run model cases sequentially.
The result records observed cost; it does not assert a dollar threshold, since
provider pricing and independent review work vary. See
[LIVE-TURN-COVERAGE.md](./LIVE-TURN-COVERAGE.md) for the deterministic coverage.
