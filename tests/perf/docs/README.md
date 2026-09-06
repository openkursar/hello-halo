# Performance documentation

Permanent home for what the performance work on this client has established, what
it has *not* established, and how to measure the next time.

| File | Read it when |
|---|---|
| `measurement-practice.md` | Before you design a check, a gate, or a measurement. Round-independent. |
| `rounds/` | One file per measurement round: what was changed, what was measured, and the boundary on every number. |

Start with `measurement-practice.md`. The round files are evidence; the practice
file is the part that keeps you from misreading them.

## The one rule for round files

**Every number must be traceable to a raw result file under `tests/perf/results/`,
not to prose in another document.** If a number cannot be traced, either omit it or
mark it unverified. A number that is repeated often enough starts to look
established; repetition is not evidence.

Round files therefore cite results by path, e.g. `results/final-frozen/s4-markdown-preview.json`.

## Running the suite

```bash
python3 tests/perf/fixtures/generate.py     # ~29 MB, reproduced from the manifest
npm run build
npm run test:perf:record-build              # ties the results to a binary
PERF_LABEL=<label> npm run test:perf
npm run test:perf:verify -- <label>         # did everything actually run?
npm run perf:gate -- --results tests/perf/results/<label> --require-fresh-build
node tests/perf/compare.mjs <before-label> <after-label> --summary
```

The fixtures are generated, not committed; `manifest.json` is. Every fixture is
verified against it by sha256 before use, and generation is deterministic — a
fixture that fails verification means the generator changed, not the machine.

### Three projects, and why

| Project | npm script | Contents | Cost |
|---|---|---|---|
| `perf-release` | `perf:release-check` | The scenarios with a ceiling, plus the crash observation | ~14 min |
| `perf` | `test:perf` | Everything except the soaks | ~20 min |
| `perf-soak` | `test:perf:soak` | The two leak scenarios | 10 min each |

`perf:release-check` is what the release scripts call, and it is a sequence rather
than a test run: generate/verify fixtures → record build identity → measure →
`verify-run --set=release` → apply thresholds against a build proven fresh. One
entry point so that no two release scripts can drift into running different
things.

The release set is narrower than `perf` on purpose. Cold start, terminal, browser
view and the streaming scenarios have node deltas small enough that run-to-run
noise exceeds the signal — they cannot be gated at any number, so making a release
wait for them buys nothing and costs the six minutes that make people reach for
`SKIP_PERF_GATE=1`.

They are split because they answer different questions at different costs. The
soaks measure growth *per open/close cycle*, so their price is wall time.
Measured: the 10-minute default (295 cycles) shows the leak unmistakably but
reports 1.19 listeners/cycle where the 45-minute baseline reports 0.997 — the
startup transient weighs more in a short run. **Detect with the short run,
compare rates only with `S9_DURATION_MS=2700000`.** Nothing that takes 45 minutes
belongs in a path anyone is expected to run before shipping.

Streaming scenarios (S2/S6/S8) need a deterministic local mock — fixed token
count, fixed interval — at `tests/perf/mock/sse-server.mjs`. Every `test:perf*`
script goes through `scripts/run-perf.mjs`, which starts that mock on a free port
and points `HALO_TEST_*` at it before Playwright loads. This is not a
convenience: `tests/playwright.config.ts` loads `.env.local` for every project,
so without it these scenarios silently measure whatever provider that file
happens to name, at a response rate nobody controls. That is how S2, S6 and S8
produced no usable evidence for two rounds.

`PERF_REAL_API=1` keeps `.env.local` instead — correct when the question is about
a real provider, wrong for any before/after comparison. Either way every result
records its `aiSource`, and `verify-run` fails a label directory whose files
disagree, since that means it holds more than one run.

## What is kept in git, and what is not

`tests/perf/results/` is gitignored. Run output is per-run residue and must not
accumulate in a public repository's history. A baseline worth keeping is added
deliberately with `git add -f`.

Retained baselines are `.json` only. Screenshot directories are never committed:
they are ~24 MB of near-duplicate frames across the working set, they cannot be
diffed, and a screenshot of a running client is a standing desensitization risk
even when the frame that was reviewed happened to be clean.

A round is worth freezing into history when a later round would otherwise have
nothing to compare against. That is a small set — the before baseline, the after
baseline, and any run that is the sole evidence for a *negative* result, since
negative results are the ones a later round will otherwise redo.

## Adding a round

Add `rounds/<yyyy-mm>-<short-subject>.md`. Structure it as:

1. **What changed**, in one paragraph.
2. **Results, each with its boundary in the same row.** Not a results table
   followed by a caveats section — the caveat has to be unskippable.
3. **What was not established.** Measurement gaps and product gaps, labelled
   separately. "We could not measure it" and "we measured it and it is bad" are
   different facts and get read as the same one if you let them.
4. **What is not done**, ordered.

Then update `measurement-practice.md` if the round taught something that will
outlive it. Most rounds will not.
