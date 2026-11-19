# 2026-11 — long work: baseline and the first two fixes

The first in-app measurement of one reply that runs for 1,000 and 5,000 steps,
taken on the released code and on a build with two changes: images a tool returns
are kept as files instead of base64 text in the work process, and the three views
that re-read a running turn every few seconds (a run's detail page, the team
workbench, and the cross-machine copy of a member's transcript) read only what
changed since their previous read.

One macOS machine (Apple silicon), a second user account with its own desktop
session, production `electron-vite` builds of `a7658b03` (base) and of the same
commit with the change applied (after), each in its own checkout. Scenario
`specs/s18-long-work.spec.ts`, project `perf-long-work`; the turn is driven by the
local mock's plan mode (`mock/sse-server.mjs`), so every arm sends the same tool
calls with the same outputs. Base and after arms were interleaved
(base r1, after r1, base r2, after r2, then 5,000 steps). **The machine was busy**:
one-minute load averages ranged from 3 to 82 (recorded in every result file);
timings are only comparable within a row whose loads are given. MB in this file
is 2^20 bytes.

---

## What changed

`services/agent/tool-result-images.ts` writes each image a tool returns to a file
named by its content and puts an `image_file` reference in the work process's copy
of the result; what the engine receives is unchanged. `session-store` exposes
`readSessionUpdate` (a cursor-based read of what changed) and
`readSessionMessagesFrom` (a transcript from a message on, parsed from the last
turn boundary instead of the file start); `control.getSessionState` takes an
optional `since` that returns only the thoughts changed since the previous read.
Every new parameter is optional and an old caller gets the old answer.

---

## Workload

| | 1,000 steps | 5,000 steps |
|---|---|---|
| Tool calls served | 1,000 | 5,000 |
| Steps saved in the reply | 1,104 | 5,504 |
| Text reads: output characters p50 / p90 / p99 / max | 802 / 8,076 / 53,428 / 200,000 | same distribution |
| Image reads | 20 PNG of 0.5–1.5 MB, 18.5 MB in all | 20 |
| Task-list updates | 9 | 9 |
| Largest model request | 7.0 MB | 22.6 MB |

`results/long-work-base-r1/s18-long-work-1000.json`, field `longWork.workload`;
`…-5000.json` likewise.

Images are 0.5–1.5 MB instead of the planned 1–3 MB. With 1–3 MB images the
engine's requests passed the local model router's 50 MB request limit
(`openai-compat-router/server/router.ts`) after ~930 steps and the turn ended with
an error before the plan finished; that is a property of the test model setup,
not of what was measured, and the router was not changed.

---

## Results, with the boundary on each

| Result | Boundary |
|---|---|
| **Bytes sent to the window during the turn: 57.7 MB → 8.4 MB (1,000 steps), 91.8 MB → 42.5 MB (5,000 steps).** Almost all of it is tool output, sent twice: `agent:thought-delta` 28.7 → 4.1 MB and `agent:tool-result` 28.3 → 3.7 MB at 1,000 steps; every other `agent:*` channel together is 0.6 MB. <br>`results/long-work-{base,after}-r{1,2}/s18-long-work-1000.json`, `results/long-work-{base,after}-r1/s18-long-work-5000.json`, field `longWork.ipcBytes` | JSON size of each `webContents.send` payload, counted in the main process. Identical in both repetitions to the byte, as it should be for a deterministic workload. The remaining 42.5 MB at 5,000 steps is text output sent twice; sending it once is a later stage. |
| **The conversation's steps file: 28.6 MB → 3.9 MB (1,000 steps), 44.7 MB → 20.0 MB (5,000 steps).** The images now live beside it as 18.5 MB of files, written once each. <br>Same files, field `longWork.files` | 18.5 MB is exactly the 20 PNGs; the steps file shrinks by more than that because the base64 text was 4/3 of the image bytes. |
| **End-of-turn save: 131 / 92 ms → 23 / 17 ms (1,000 steps); 236 → 91 ms (5,000 steps).** <br>Same files, field `longWork.endOfTurnSave.spanMs` | The span of the conversation's synchronous file operations in the main process after the answer was sent. Loads 21 / 19 (base) and 82 / 8 (after) at 1,000 steps; 12 and 3 at 5,000. The direction is consistent with a file 7× smaller; the exact values are not. |
| **Opening the reply's work process after a cold restart, until its last step is on screen: 105 / 116 ms → 34 / 33 ms (1,000 steps), 167 → 102 ms (5,000 steps).** Window heap after opening it: 51 / 53 MB → 29 / 29 MB (1,000), 79 → 54 MB (5,000). <br>Same files, field `longWork.reopen` | Measured from the click inside the window. One cold start per arm. |
| **Team workbench polling a running digital-human turn: a read was 18.9 / 20.2 MB (median) on the base build; on the after build 2.9 / 2.8 MB whole and 170 / 200 KB as an incremental read.** Over the 1,000-step turn: 319 / 326 MB → 4.0 MB transferred; round trip 9.0 / 9.3 ms → 0.6 / 0.6 ms median. At 5,000 steps (after only): whole 14.7 MB vs incremental 86 KB median; 2,265 MB vs 20 MB over the turn. <br>`results/long-work-{base,after}-r{1,2}/s18-long-work-polling-1000.json`, `results/long-work-after-r1/s18-long-work-polling-5000.json`, field `polling.workbench` | Read from the window every 2 s (the workbench itself polls every 3 s). On the after build each poll makes both reads so they see the same moment; the incremental reader's thoughts are checked against the whole read every poll (`stateMismatches` 0). The drop from 19 MB to 2.9 MB for a *whole* read is the image change alone. |
| **A run's detail page polling a running automation run: 2.3 MB → 156 / 160 KB median per read; 44.5 / 45.2 MB → 3.9 MB over the turn; 2.6 / 3.1 ms → 1.6 / 1.6 ms median.** At 5,000 steps (after): 13.8 MB whole vs 94 KB incremental median. After the run settles, the transcript rebuilt from the incremental reads equals a whole read (`runMatchesWholeRead: true`, both sizes). <br>Same files, field `polling.runDetail` | The run transcript never carried image base64 to the page (its reader kept text blocks only), so here the whole read is the same size on both builds and the difference is the incremental read alone. |
| **With the corrected probe the polling result stands, and now compares content.** 1,000 steps: workbench read 19.7 MB (base) → 2.8 MB whole / 177 KB incremental (after) median; run detail 2.2 MB → 162 KB. 5,000 steps: workbench 30.3 MB (base) → 14.8 MB whole / 82 KB incremental; run detail 12.9 MB → 90 KB; over the turn 5,480 MB → 20 MB (workbench) and 2,394 MB → 20 MB (run detail). After the run settles, the transcript rebuilt from the incremental reads equals a whole read (`runMatchesWholeRead: true`); 13,808 (1,000 steps) and 620,509 (5,000 steps) settled workbench steps were compared in full content with no mismatch. <br>`results/long-work-{base,after}-p1/s18-long-work-polling-{1000,5000}.json`, fields `polling`, `settledStepsComparedInFull` | Loads 35 / 19 (1,000 steps), 4 / 4 (5,000). Settled means older than the newest five steps, which can still move between the two reads. The base build's incremental column is its whole read (it has no incremental one), counted once per poll. |
| **Memory of the window during the turn did not measurably change.** Peak 858 / 1,014 MB → 974 / 1,083 MB, average 683 / 766 → 671 / 753 MB at 1,000 steps; JavaScript heap at the end of the turn 103 / 111 → 93 / 91 MB. At 5,000 steps: peak 3,084 → 2,657 MB, average 1,318 → 1,803 MB, heap 334 → 317 MB. <br>Same files, fields `mem.byProcessType.renderer`, `heap` | Memory is order-of-magnitude only (`measurement-practice.md` §2), and the 5,000-step arms are one run each at loads 12 and 3. What can be read: removing ~25 MB of image text did not move the window's memory, and **a live 5,000-step turn holds 2.6–3.1 GB in the window and ~320 MB of JavaScript heap**, while the steps themselves arrive as 1.4 MB of `agent:thought` events (~260 bytes each). Heap figures are not GC-forced. The next row says what holds it. |
| **What holds it is the live panel's DOM: about 79 nodes and 3.6 listeners per step, on both builds.** DOM nodes 446 → 79,355 / 82,164 (base) and 78,800 / 81,342 / 80,178 (after) at 1,000 steps; 446 → 393,246 (base) and 392,885 (after) at 5,000. Listeners 650 → 4,210 / 4,250 and → 18,573 / 18,613. <br>Same files, fields `nodes`, `listeners` | The released live panel opens itself during a turn and draws every step. A counter, not a timing, so the agreement across five runs and two builds is the evidence. A work-process view that keeps live work folded and builds the timeline only when opened would change this; that has to be measured on such a build, folded and opened. |
| **A third repetition on the final code (1,000 steps) agrees:** 8.4 MB to the window, 3.9 MB steps file, save 17.4 ms, reopen 33.2 ms, window peak 935 MB. <br>`results/long-work-after-r3/s18-long-work-1000.json` | Load 14. The image view component changed between r1/r2 and r3 (it renders the image itself instead of through the chat's image gallery); the numbers do not move. |
| **Main process: no measurable change.** Heap at the end of the turn 253 / 178 → 179 / 155 MB (1,000), 82 → 57 MB (5,000); RSS 562 / 613 → 526 / 723 MB (1,000), 543 → 689 MB (5,000). <br>Same files, field `longWork.main` | `process.memoryUsage()` at two moments, not GC-forced; the spread between repetitions of one build is larger than any difference between builds. |
| **A conversation that already holds a ~20 MB steps file takes 141 / 106 ms to save the end of a 50-step turn on the base build, and 101 ms on the after build** (r2). <br>`results/long-work-{base,after}-r{1,2}/s18-long-work-save-20mb.json`, field `longWork.endOfTurnSave` | Unchanged by design: this work rewrites the whole steps file at the end of every turn, and these fixes do not touch it. It is the baseline for that later change. The after r1 value (948 ms) ran at load 64 and is not read as a result. |

---

## Not established

### Measurement gaps

- **The base build's 5,000-step polling arm failed twice with the first probe and
  completed with the corrected one**, which supports that the probe, not the
  product, lost the page. The first probe kept every run-detail response in the
  window to check them afterwards; on the base build each response is the whole
  transcript (up to ~20 MB at 5,000 steps), so the page held gigabytes the
  product never holds. The corrected probe keeps only the current state in the
  window, applies run updates in the test as they arrive, and compares settled
  workbench steps in full content rather than by id. Its results are in
  `results/long-work-{base,after}-p1/`; the failures are in
  `results/long-work-base-r1/s18-long-work-polling-5000.json`. The polling rows
  above were taken with the first probe, which changes what the test held, not
  what was sent; the corrected arms below repeat them.
- **No heap figure is GC-forced and no heap snapshot was taken.** The DOM counts
  account for the growth in proportion to steps; how much of the 2.6–3.1 GB they
  account for is an inference from their size, not a measurement.
- **Sub-agent work is not part of the workload.** The mock cannot answer a
  collaborator's own model requests deterministically yet. Sub-agent results go
  through the same display copy (covered by unit tests), but their cost at scale
  was not measured.
- **5,000 steps ran once per build**, on a machine whose load moved between 3
  and 34 during the round. The byte counts do not depend on load; nothing else in
  the 5,000-step rows should be read beyond its order of magnitude.
- **The cross-machine transcript read is not measured here.** It reads a
  member's transcript from the last turn boundary instead of from the file start
  only for files above the 32 MB single-parse limit; its equality with a whole
  read is held by a unit test (`tests/unit/apps/runtime/session-transcript-incremental.test.ts`)
  and the cluster tier, not by a timing.

### Product gaps

- A long live turn costs the window memory in proportion to its steps (about
  3 GB at 5,000) because the live panel draws every step. These fixes do not
  address it.
- Every tool output still reaches the window twice during the turn.
- Remote web and the mobile app see a one-line description instead of an image
  saved as a file; they cannot read the file yet.

---

## Not done, in order

1. Repeat the 1,000- and 5,000-step arms on a build whose work-process view keeps
   live work folded, in two states (folded; opened with one segment open),
   recording `nodes`, `listeners` and a GC-forced heap. A heap snapshot only if
   the count still grows with steps.
2. Measure page nodes, listeners and GC-forced heap on a build with the folded
   work-process view (see 1).
3. A repetition of both 5,000-step arms on a quiet machine.
