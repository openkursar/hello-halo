# 2026-09 — Instrumenting for degradation

Follow-up to `2026-09-harness-hardening.md`. That round asked whether a regression
would be *caught*. This one asks a question it could not answer: the listener leak
is real and unbounded, but **does it cost the user anything?** The soak recorded
heap, nodes and listeners — and nothing else. CPU, interaction latency and process
memory, the three quantities that would show sustained use getting worse, were
never sampled at all.

Two harness defects had to be closed first, because both let a scenario report
nothing while looking fine.

Results label: `results/instrumented-45min/` (S9 soak, 45 min, macOS,
`electron-vite` build, dirty tree). Supporting controls cited inline.

---

## What changed

**A scenario that dies now says so.** Every spec wrote its result on its last
line, so anything that threw earlier produced no file — and an absent file is
indistinguishable from a scenario that was never scheduled. `beginScenario()`
leaves a marker on disk, `writeResult` clears it, and a Playwright reporter
(`tests/perf/reporter/in-flight.ts`) sweeps what is left and writes a
`status: 'error'` record naming the failure.

**Streaming scenarios measure a known source.** `tests/playwright.config.ts`
loads `.env.local` for every project, so S2/S6/S8 had been measuring whatever
provider that file happened to name. `scripts/run-perf.mjs` now starts the
deterministic local SSE mock on a free port and points `HALO_TEST_*` at it before
Playwright loads; every result records its `aiSource`, and `verify-run` fails a
label directory whose files disagree.

**The soak measures degradation, not just accumulation.** Per cycle it now also
records the window's CPU and working set (by pid), the whole app's summed working
set, longtasks, interactions past the 100 ms threshold, and the file-open
duration — which the loop was already computing and discarding.

---

## Results, with the boundary on each

| Result | Boundary that changes how to read it |
|---|---|
| **S2 produced a valid measurement for the first time: 44,585 ms, `status: ok`, `valid: true`.** <br>`results/mock-verify/s2-long-stream.json` | Deterministic by construction, not by luck: 2,000 tokens × 20 ms is 40 s, and the rest is fixed setup. It measures the mock's pacing, so it is a regression detector for Halo's rendering of a stream, **not** a statement about any real provider's speed. |
| **A scenario that dies now leaves a record naming the cause.** Injected a throw before the soak's write; got `status: 'error'`, `valid: false`, note carrying the thrown message, and `verify-run` reporting `s9-soak status=error` instead of silence. <br>`results/inflight-control/s9-soak.json` | Reverse control, not an inference: the same run's `s9-soak-probe` succeeded and correctly got **no** error record. Freshness, not mere existence, decides — a result file left by an earlier run into the same label does not suppress the record. |
| **The leak costs memory, and only memory.** 45 min, 1,326 open/close cycles. The window's working set rose 298.8 → 436.9 MB and the whole app's 693 → 846 MB, while CPU, longtasks, slow interactions and open duration all stayed flat or improved. <br>`results/instrumented-45min/s9-soak.json` | Machine load *fell* over the run (1-min average 2.82 → 2.32), which flatters the CPU and open-duration series and works against the memory series. So "memory grows" is the conservative reading and "responsiveness holds" is the generous one. macOS only. |
| **The JS heap is not a memory measurement here.** Heap went 26.5 → 30.3 MB and visibly converges (per-octile deltas 1.6, 0.7, 0.6, 0.4, 0.2, 0.2, 0.1) while the working set it sits inside grew by 138 MB and did not. | This is the trap the earlier rounds walked into: `heapMB` is V8's JS heap, and retained DOM lives in native memory outside it. A flat `heapMB` says nothing about whether the app's memory is growing. |
| **Nothing degrades within 45 minutes.** Zero longtasks and zero interactions over the 100 ms threshold for the entire run; open duration went 373.6 → 348.8 ms, i.e. slightly *faster*. `unresponsiveCount` and `crashCount` stayed 0. | Absence of a signal, not proof of its absence: the observers were attached and reported (1,592 samples, 5,386 of 5,387 process ticks succeeded), so this is a real zero rather than a broken probe — but 45 minutes at 30 opens/minute is not a week at human pace. |
| **Per-cycle leak rate reproduces the historical baselines.** 0.986 listeners/cycle, against 0.97 / 1.00 / 0.92 from the three uninstrumented 45-minute runs. | Worth more than it looks: it shows the added instrumentation did not perturb the quantity the previous rounds measured, so this run can be read alongside them. |

**The transferable number is per cycle, not per minute.** This run did 1,326 cycles
in 45 minutes — about 30 file opens a minute, far above any human rate. Per
open/close cycle: **+0.99 listeners, +6.8 DOM nodes, +0.20 MB of window working
set**, none of them reclaimed.

---

## Not established

### Measurement gaps

- **The two soak baselines are not strictly comparable to this one.** The
  instrumented run adds a 500 ms `getAppMetrics` poll and two
  `PerformanceObserver`s. Neither registers a DOM listener, so `nodes` and
  `listeners` stay comparable; CPU sits slightly above an uninstrumented run.
- **The soak's app now boots with the mock configured as its AI source** rather
  than whatever `.env.local` held. The soak never chats, so this affects only
  boot-time config, but it is a difference from the recorded baselines.
- **`aiSource` distinguishes two runs only when they used different sources.**
  Two mock runs into one label directory still merge undetected.
- **Two Playwright suites running at once can corrupt the in-flight record.**
  `PERF_LABEL` defaults to `dev` for every project, so an e2e run started while a
  perf scenario is mid-flight would sweep the live marker: a bogus error record
  now, and a later genuine death unrecorded. Accepted rather than fixed —
  concurrent suites already invalidate any measurement through CPU contention —
  but it is a real hole, not an impossible one.
- **`beginScenario` writes its marker under `currentLabel()` while `writeResult`
  clears it under the result's own `label`.** Every caller passes the same value
  today. If one ever diverges, the result is an error record for a scenario that
  succeeded.

### Product gaps

- **`ElectronApplication.close()` does not resolve after a completed AI turn.**
  Reproduced four times. The app is measured, writes its result, and then
  teardown burns the full 240 s timeout and reports the test as failed even
  though the result on disk is valid.

  | Stream | Result | Teardown |
  |---|---|---|
  | none (S1, S5, S9, S10) | ok | seconds |
  | 5 tokens, never completed | error record written | seconds |
  | 400 tokens, completed in 9.7 s (`results/mock-probe5/s2-long-stream.json`) | ok, valid | 240 s timeout |
  | 2,000 tokens, completed in 44.6 s (`results/mock-verify/s2-long-stream.json`) | ok, valid | 240 s timeout |

  **Not the product hanging, and not caused by the mock.** Sampling the process
  table during the hang shows the app and every process it spawned are gone
  within ~50 s; `close()` simply never settles. The short-stream control rules
  out stream length, and the never-completed control rules out the mock's socket
  (also tested directly with `Connection: close`, which changed nothing). What
  distinguishes the two affected scenarios is that S2 and S8 are the only ones
  that delegate `app.close()` to a fixture instead of calling it themselves.

  **Left unfixed deliberately.** Both fixtures live in `tests/e2e/fixtures/`,
  shared with every e2e project — several of which also run real AI turns and
  would hit the same path. That is a shared wall, and bounding the close there
  needs a decision, not a patch slipped in with a measurement change.

---

## Not done, in order

1. **Locate the listener leak — now with a convergence criterion.** The previous round could
   only judge a fix by whether the listener count stopped climbing. There is now a
   second, independent series that has to move with it: the window's working set,
   at +0.20 MB per cycle. A patch that flattens listeners but not memory did not
   fix what matters.
2. **Decide what to do about the unresolving `close()`.** It costs ~4 minutes and
   one false red per streaming scenario, and "a check that is always red is a
   check people learn to ignore" is the standing reason not to leave it.
3. **Point S6 and S8 at the mock's evidence.** S2 is now deterministic; S6 and S8
   run through the same runner but have not been re-measured, and S8 still cannot
   complete because the mock emits no tool calls.
4. **Add a wide-table scenario** — carried over unchanged; the fixture is ready.
5. Carried over: measure on Windows, measure the
   digital-human path, HTML preview isolation, delete the two unreachable
   viewers.
