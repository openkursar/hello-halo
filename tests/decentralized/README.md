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
npm run test:team -- single          # §1 single-machine fundamentals
npm run test:team -- federation      # §3 federation, all 62 scenarios (writes RESULTS.md)
npm run test:team -- upgrade         # §4 upgrade/migration
npm run test:team -- perf            # §5 performance (add --long-run-minutes / --soak-minutes for full length)
npm run test:team -- lifecycle       # §7 data lifecycle & security
```

A single `npm run test:team` entry dispatches to all suites (see `run.mjs`), rather
than five top-level scripts — the launcher self-documents the catalog and forwards
any extra args (e.g. `-- federation --only G1,K1`) to the driver.

Rules that keep results trustworthy:

1. **Never run suites in parallel.** N Electron processes + N model streams
   starve the CPU and produce timeout-shaped false negatives (documented in
   OVERNIGHT-FIXES.md and reconfirmed since). Re-verify any red item in
   isolation (`run-scenarios.mjs --only <IDs>`) before treating it as real.
2. **Model config** comes from `.env.local` (`HALO_TEST_API_KEY/URL/MODEL/PROVIDER`);
   protocol-only scenarios run without a key and are marked `[no-model-ok]`.
3. **Stale nodes hold ports.** If a prior run died, `pkill -f out/main/index.mjs`
   before starting (launch-nodes `stop` only kills pids in the current manifest).
4. `.cluster*/` dirs contain node data + the seeded model key — never commit.

## What this tier can NEVER cover (do not fake it)

Per CHECKLIST-COVERAGE.md: packaged-build installs (keychain/Gatekeeper/firewall
dialogs), true multi-machine networks (partition/latency/NAT), clock skew, and
human visual judgment of the render layer. Those stay manual; record results in
`local_docs/features/数字团队/产品/投产测试清单.md` directly.
