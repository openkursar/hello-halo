# 2026-09 — turning the round's harness into checks that can fail

Follow-up to `2026-09-viewer-virtualization.md`. That round changed the product and
measured it; this one asks whether any of it would be *caught* if it regressed, and
fixes what the answer exposed.

Results label: `results/takeover-verify/` (nine gated scenarios plus S1/S3/S5-image/
S5-pdf/S7a/S7b; S2 and the two soaks did not run — see "Not established").
All on one macOS machine, `electron-vite` build, dirty tree.

---

## What changed

The measurement layer from the previous round was good and the gate layer did not
exist: the suite contained no performance assertion of any kind — no `toBeLessThan`
anywhere — and `compare.mjs` always exited 0. The pre-fix baseline it would have had
to catch is `report-snapshot/s4-markdown-preview.json`: 536,406 DOM nodes and a
7,688 ms longest task, against 1,289 and 75 ms after. Nothing read either number.

(A revert-and-rebuild run during the previous round reported a comparable blow-up
and a green suite. **That run left no result file** and is not cited here; the
frozen baseline above says the same thing and is traceable.)

This round adds the gate (`scripts/perf-gate/`, `scripts/precommit-gate.mjs`,
`scripts/typecheck-changed.mjs`), makes the fixtures portable (a generator plus a
sha256 manifest, replacing a hard-coded path into an ignored temp directory), and
then spends most of its effort on a single question that turned out to be the
productive one: **for each new check, construct the failure it claims to catch and
watch it catch it.** Four of the things below were found that way and by nothing
else.

---

## Results, with the boundary on each

| Result | Boundary that changes how to read it |
|---|---|
| **The 3-second measurement floor is gone; open durations are real for the first time.** The previous round could only say "below what this harness can resolve". Measured now: 2 MB markdown **738 ms**, 5 MB CSV 214 ms, 5 MB JSON 480 ms, 500 KB code 439 ms, 5 MB log 440 ms, 2 MB HTML 1,375 ms. <br>`takeover-verify/s4-markdown-preview.json`, `takeover-verify/s5-*.json` | Not comparable to the previous round's duration column, which was the floor. These are a *new* baseline, not a delta — there is no valid before value to subtract. Machine load at the time ranged 4.35–13.24 across these runs, which is high; treat them as upper bounds. |
| **Node counts reproduce the previous round's anchors on a different day.** 1,270 / 1,268 / 735 / 731 / 709 / 1,637 / 1,794 / 370 / 262,929 against frozen anchors of 1,289 / 1,278 / 749 / 751 / 746 / 1,651 / 1,810 / 397 / 262,937. <br>`takeover-verify/` vs `final-frozen/` | Worst divergence is 6.8% (s5-text, 397 → 370) on the smallest count, where a few nodes are a large percentage. This is the claim that node count is machine-independent holding up a second time, not a new measurement. |
| **The 5 MB CSV fix was real for one file shape and absent for the other.** `Math.max(...rows.map(r => r.length))` passes one argument per row and throws past ~100k rows. The 5 MB fixture that measured clean has 66,992 rows — half the limit. A 5 MB CSV of short rows has 268,776, and threw `RangeError` inside a `useMemo` whose nearest boundary is the renderer root, replacing the entire application with the error-boundary screen. <br>`s10-devirtualized-control/s10-csv-crash-loop.json` → `s10-fixed-control/s10-csv-crash-loop.json` | The previous round's "5 MB CSV from crashing to opening" is true as measured and was never true for the shape users are more likely to have. Column virtualization remains not done and is a third, still-uncovered dimension. |
| **That failure was invisible to every signal the harness collects.** In the control run `maxCrashCountObserved` is **0** and `everUnreachable` is **false** while the UI is gone: React caught the throw, so the process never died and the window stayed responsive. S10's original assertion would have passed. <br>`s10-devirtualized-control/s10-csv-crash-loop.json`, screenshot `t0094828ms.png` | Fixed by `tests/perf/lib/renderer-fatal.ts`, now checked by S10 and by every file-preview scenario. The check is verified in both directions: red on the unfixed build, green on the fixed one, same fixture, same machine. |
| **One real-document class was silently unvirtualized, and the check that should have caught it was excusing it.** `HTML_OPEN_RE` treated any word in angle brackets at column zero as a block-level HTML open tag, so a line beginning `<tool_call>` or `<webview>` stuck the guard for the rest of the file. Restricting the stack to CommonMark's HTML block type-6 tag list took the corpus from **3 collapsed documents to 1** — and the one that remains is the committed `footnotes.md` fixture, where collapsing is intended. <br>`npx tsx tests/perf/checks/markdown-chunking-corpus.ts` | The two documents that started splitting had been reported as "lone unclosed fence, no safe split point exists". That exemption was true of the documents and was masking a guard misfire — a machine-checkable exemption is still an exemption. The 449-chunk baseline for the 2 MB fixture is unchanged. |
| **The gate and the harness disagreed about skips, so the skip path had never run.** `writeSkipResult` wrote `skippedPrecondition: 'HALO_TEST_API_KEY'`; the gate read `skipReason` and matched against `'no-api-key'`. Every registered skip would have been rejected as unregistered. <br>`scripts/perf-gate/thresholds.mjs`, `tests/perf/lib/skip-record.ts` | Now pinned from both ends: the field name by `PerfResult` (a rename fails `typecheck:changed`), the vocabulary by a self-test case. Verified by watching each fail. No scenario in the current gate set can skip, which is exactly why this needed a self-test rather than a run. |
| **`tsc` reported 130 errors that its own configuration created.** Neither tsconfig set `target`, so tsc assumed ES5 and every `for...of` over a Map became a downlevel-iteration error. Node project 247 → 112. <br>`tsconfig.node.json`, `tsconfig.web.json` | This is why the previous round's `writeAsync` no-op survived: tsc *did* report it, in a list nobody could read. Separately, a stale `.tsbuildinfo` was replaying 47 of those errors after the fix had landed — `typecheck-changed.mjs` now runs cache-free. |
| **The perf harness itself was never typechecked.** No tsconfig covered `tests/`, and Playwright transpiles without checking. Adding `tsconfig.test.json` found a real type error in a file this work had just rewritten (`result-writer.ts:19`). <br>`tsconfig.test.json` | One error, harmless at runtime. The point is not the error; it is that the code producing every number in this directory had no type checking at all. `tests/` carries ~300 pre-existing errors, mostly vitest mock typing — the gate is scoped to changed files, so that backlog neither blocks nor gets laundered. |

---

## Not established

### Measurement gaps

- **S2 (long stream) produced no result file at all.** It ran and wrote nothing;
  `verify-run.ts` reports it as missing, which is the correct behaviour, but the
  cause was not investigated. `HALO_TEST_*` was set from `.env.local` to a real
  provider, so it was not a skip.
- **S6 and S8 are not evidence in this run.** Same cause: they ran against a real
  provider rather than the deterministic mock, and recorded `hung` and
  `precondition-failed`. Nothing about those paths is claimed here.
- **The listener leak is untouched by this round**, and the short soak is a
  weaker instrument than the long one. The soaks moved out of the default suite
  into a `perf-soak` project and their default dropped from 45 to 10 minutes, so
  nothing on a release path costs 45 minutes. Running the 10-minute default once
  (`soak-10min/s9-soak.json`, 295 cycles) reproduces the leak's *existence*
  clearly — 233 → 585 listeners — but reads **1.19 per cycle against the
  45-minute baseline's 0.997** (`final-frozen/s9-soak.json`, 782 cycles), a 20%
  overestimate. Excluding the first quarter narrows it to 1.05 vs 0.80, so the
  gap is the startup transient carrying more weight in a shorter run, not noise.
  **Use the short run to detect a leak, never to compare a rate against the
  frozen baselines**; `S9_DURATION_MS=2700000` reproduces those.
- **Windows, still zero data.** Every number here is macOS.
- **The exact row count at which the CSV spread throws was measured on Node
  (fine at 100k, throws at 125k), not in the renderer.** The renderer evidence is
  binary: 268,776 rows throws, 66,992 does not.

### Product gaps this round found and did not close

- **Column virtualization.** Unchanged from the previous round, and now the only
  CSV dimension still uncovered.
- **`window.halo` is declared nowhere**, leaving 351 renderer call sites untyped.
  Found while wiring the typecheck; not touched, because a 351-site change has no
  business landing next to this.

---

## Not done, in order

1. **Find out why S2 writes no result file.** It is not in the release set, so it
   blocks nothing, but a scenario that runs and records nothing is the shape this
   whole round exists to catch.
2. **Point `HALO_TEST_*` at the local mock for measurement runs**, or teach the
   specs to prefer it, so S2/S6/S8 stop depending on what `.env.local` happens to
   hold.
3. **Add a wide-table scenario** — carried over unchanged; the fixture is ready.
4. Everything else carried over from the previous round: locate the listener leak,
   measure on Windows, measure the digital-human path, control group for the
   first-token observation, flush the log queue on exit, HTML preview isolation,
   delete the two unreachable viewers.

Items 5, 7 and 9 of the previous round's list are closed by this one (the 3-second
floor, the corpus check into `tests/`, the last ungated hot-path log).

## Where the checks are wired

Neither gate is useful until something calls it, and both now do:

- **Commit** — `.claude/skills/code-commit` §2.1 runs `npm run precommit:gate`
  before anything else and treats a non-zero exit as blocking. A script rather
  than a git hook, because `--no-verify` exists and because the checks have to be
  selected from what the commit touched.
- **Release** — Step 4b of both release scripts runs `npm run perf:release-check`,
  after `npm run build` and before packaging, skippable only by setting
  `SKIP_PERF_GATE=1` explicitly. Measured end to end at **14 minutes**, and
  verified to fail on a stale build (`src/` newer than `out/main/index.mjs`).
