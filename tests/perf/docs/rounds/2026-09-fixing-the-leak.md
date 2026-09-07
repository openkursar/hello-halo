# 2026-09 — fixing the leak

Follow-up to `2026-09-locating-the-leak.md`. That round found where the listener
growth came from; this one fixes it, and finds that the memory growth — the only
reason the leak was judged worth fixing — is a separate problem that none of the
fixes touched.

One macOS machine, one `electron-vite` production build per arm. Probe arms are
200 measured cycles after 8 warmup cycles (`perf-leak`); soak arms are 45 minutes
/ ~1,590 cycles (`perf-soak`).

---

## What changed

Two defects fixed and one bound added: the terminal library's `ScreenDprMonitor`
is now registered with the disposable store it was always meant to be in
(`patches/@xterm+xterm+5.5.0.patch`); the image viewer's cache-busting token
counts rewrites instead of mounts, so re-opening an unchanged image is a cache
hit again (`src/renderer/services/artifact-version.ts`); and the renderer's
mirror of terminal sessions now drops exited entries past the same bound the pty
host enforces, which is exported from `shared/types/terminal.ts` so the two
cannot drift. The soak no longer pins the terminal's DOM from the test side, and
it now refuses to report a run whose samples do not span its wall clock. The
`leak-locate` probe gained an idle arm, a slow-cadence arm, per-minute slopes
alongside per-cycle ones, and an arm that releases the debugger's own retention.

---

## Results, with the boundary on each

| Result | Boundary that changes how to read it |
|---|---|
| **The listener leak is closed.** With a terminal every fifth cycle, CDP listener growth is 0.40/cycle before the patch and **0.00/cycle** after; the 12 leaked `resize` listeners from 12 terminal opens become 0, and the outstanding set goes from 13 to 1. Over 45 minutes the slope goes from 0.799 to **−0.002**/cycle, ending at 440 listeners where the untouched baseline ended at 1,540. <br>`results/leak-3-term-nohandle/` vs `results/leak-6-patched/`; `results/instrumented-45min/` vs `results/soak-patched/` | Only the patch differs between the two probe arms, so the attribution is theirs; the soak arms also differ by the harness pin and cannot attribute on their own. These are counts, not timings, so one comparison of each is enough. |
| **Half the original listener growth was the harness, half was the defect, and they add up.** 0.799/cycle unpinned drops to 0.404, and patching drops it to −0.002. <br>`results/instrumented-45min/`, `results/soak-nohandle/`, `results/soak-patched/` | Three runs at three different machine loads (2.05, 1.67, 3.19); the agreement is not evidence that load does not matter, only that this metric does not care, which §2 of `measurement-practice.md` already establishes. |
| **The image viewer was rewriting its URL on every mount**, so each open was a fresh entry in Chromium's resource cache rather than a hit. Image-only workload: **0.51 → 0.09 MB/cycle**, which is the level the other viewers already sit at (markdown 0.081, PDF 0.090). <br>`results/mem-only-image/` vs `results/mem-image-fixed/`, with `results/mem-only-md/` and `results/mem-only-pdf/` for scale | `results/mem-image-stabletoken/` is the mechanism control: holding the token constant by hand gives 0.107, so the token is the cause and not something else that changed with it. On the mixed workload the fix is nearly invisible (0.139 → 0.135) because images are one file in eight — an isolation result, correctly sized. |
| **The memory result reported by the last soak of the previous session is an artifact of the machine, not a fix.** `soak-fixed` reports a window RSS slope of **−0.075 MB/cycle** — both convergence criteria apparently met. Its trajectory is point-for-point identical to the unfixed arm for the first five eighths, then falls 86 MB across two consecutive samples at minute 24, as the 1-minute load average reaches 8.0. Slope up to that point: **0.105 MB/cycle**, against the untouched baseline's 0.118. <br>`results/soak-fixed/s9-soak.json`, samples at cycle 711–712 | This is the number that would have been published as "the leak is fixed". It survived because a slope was read without its trajectory. See `measurement-practice.md` §3. |
| **Memory growth is caused by opening files, not by the process being alive.** Same build, same automation, same 1.97 s/cycle, run back to back: opening files **+0.077 MB/cycle**, doing nothing for the same wall-clock time **−0.167 MB/cycle**. <br>`results/mem-5-mixed-files/` vs `results/mem-6-idle/` | The control that every per-cycle memory figure recorded before this round was missing. It separates the work from the clock; it does not separate the product's share of that work from the automation's. |
| **It is not Blink's resource cache.** Raising critical memory pressure in the renderer at the end of a run — the same signal the operating system raised on its own during `soak-fixed`, which returned 86 MB — releases **−0.1 MB**, twice. <br>`results/mem-11-purge/`, `results/mem-12-gc/`, field `rss.purgeOutcome` | Closes the category the image-viewer bug belonged to, which was the leading hypothesis going in. The purge is verified to have run (`v8: ok`, `pressure: ok`), and it is sequenced last in the run precisely because it can take the renderer down with it — the first attempt did, and cost that run's other measurements. `Memory.prepareForLeakDetection` is unusable in this renderer; it fails outright. |
| **Most of what a running loop accumulates is collected the moment the loop stops.** Across three runs the working set ends the loop at 205–210 MB and sits at 192–198 MB after the end-of-run collection, below the run's own first sample (210–215). <br>Same three labels, `rss.firstSampleMB` vs `rss.beforePurgeMB` | Says the in-loop level includes uncollected garbage, not that nothing is retained: these runs are 200 cycles, and it is the 1,591-cycle soaks that show the growth this round set out to explain. Forcing collection every tenth cycle gave 0.011 MB/cycle, which is inside the unforced spread rather than clearly below it. |
| **The debugger's own retention explains none of it.** Releasing the console object group before every sample leaves node growth identical **to the node** (1,650 in both, over 200 cycles) and RSS within noise (0.067 vs 0.077 MB/cycle). <br>`results/mem-7-noconsole/` vs `results/mem-5-mixed-files/` | A negative result, and it contradicts the reading the previous round drew from retainer paths ending at `(Global handles) / DevTools console`. Those paths are real; releasing the group they name does not free anything, so they do not mean what they appeared to mean. |
| **The cost is per file opened, not per unit time.** Four file arms give 0.077, 0.067, 0.057 and 0.092 MB/cycle; the last two ran at **3.55 s/cycle** against the first two's 1.97. Nearly halving the cadence leaves the per-cycle figure inside the same band and halves the per-minute one (2.33/2.05 → 0.97/1.55 MB/min). <br>`results/mem-5-mixed-files/`, `results/mem-7-noconsole/`, `results/mem-9-slowcadence/` | **The spread is ±25% around 0.073, and only three of the four arms are traceable** — the two slow-cadence runs used the same `PERF_LABEL`, so the second overwrote the first, and 0.057 survives only in a console log. Read the direction and the order of magnitude, not the third digit. What carries the claim is the gap to the idle arm (−0.167), which is far outside that spread. Loads were 2.5, 2.6, 2.3. |
| **Terminal opens now cost essentially nothing.** 200 of them against the idle baseline: 0.027 MB/cycle overall, 0.006 over the tail, with zero node and zero listener growth. <br>`results/mem-8-terminals/` | Ran at load 5.0, the busiest of the probe arms, which under-reports rather than over-reports growth. It measures the terminal path after the patch, and says nothing about what it cost before. |
| **The growth decelerates, but it has not been shown to stop.** Each file arm rises ~15–20 MB over 200 cycles with the second half clearly shallower than the first; the three tail slopes are 0.093, 0.023 and 0.065 MB/cycle. <br>Same three labels | They do not agree well enough to call it a plateau, and 200 cycles is 7–12 minutes against the soaks' 45. This is the row most likely to be over-read. |
| **Absolute working set is not comparable between sessions.** The identical workload on the identical build measured 272–307 MB one evening and 179–202 MB the next morning. <br>`results/mem-2-no-terminal/` vs `results/mem-5-mixed-files/` | Only arms run back to back on the same machine state may be compared. Every cross-session RSS comparison in the previous round's arithmetic inherits this, including its estimate of how much of the frozen baseline was contamination. |
| **A soak could spend half its wall clock doing nothing and still write a result that read as complete.** The post-fix soak was disturbed by an unrelated rebuild at minute 22, stopped producing samples, and spun to its 45-minute deadline. It reported `durationMs` 45.0 min, 763 cycles, and a memory curve flat to 0.0008 MB/cycle — the best row any soak has ever produced. Its last sample is at **21.8 minutes**: 48% coverage. <br>`results/_invalid-soak-clean/` (quarantined, not used for any claim) | Every failure inside the loop is caught so one bad cycle cannot end a 45-minute run — correct, and exactly what let this through. The four earlier soaks were checked against the same expression and all cover 100%, so their numbers stand. The scenario now records `sampleCoverage` and the failure counts, marks the result `valid: false` below 95%, and throws after writing it. |
| **The terminal scenario's DOM node delta grew about tenfold at some point before this round**, from 333 to 3,415, and it is not this round's doing. <br>`results/final-frozen/s7a-terminal-streaming.json` (333) vs `results/takeover-verify/…` (3,415, sha `1db661d`) vs `results/patch-verify/…` (4,463, patched) | `takeover-verify` predates the patch, so the patch is exonerated; 3,415 → 4,463 is inside the spread this scenario already shows (`final-repro1` 334 vs `final-repro2` 54 on one build), so nothing can be read into it either. The regression itself is unlocated and unowned. |

---

## Not established

### Measurement gaps

- **No valid soak of the fixed build exists.** The one that ran was disturbed and
  is quarantined (above). Every soak figure in this file therefore describes a
  build with at most the xterm patch and the image fix, and nothing here says
  what a full 45 minutes of the current code does.
- **The probe and the soak disagree, and the disagreement is unresolved.** Seven
  minutes of file opens flattens after ~20 MB; 45 minutes of the same work with
  terminals grows 220 MB in a straight line. Both cannot be describing the same
  curve. The candidates not separated are run length, the terminal cadence, and
  what the soak itself installs and samples every cycle.
- **The per-cycle memory slope is not measurable on a busy machine.** Six runs
  of the same configuration gave −0.026, 0.011, 0.033, 0.057, 0.067, 0.077 and
  0.092 MB/cycle. The three tightest (0.057–0.092) all ran at load 2.2–2.6; the
  outliers all ran at 3.3–5.0. Slopes measured above load ~3 in this round
  should be read as "not measured", not as "small". The within-run purge delta
  is not affected by this, which is why it is the one number quoted above from
  the busy runs.
- **A repeated `PERF_LABEL` silently destroys the earlier run.** Two runs of the
  slow-cadence arm went to the same directory; the second overwrote the first,
  and the only surviving trace of a 12-minute measurement is a console line. The
  in-flight marker machinery detects a *failed* run, not a *replaced* one, and
  the round-file rule that every number be traceable to a result file has no
  teeth if a result file can be quietly replaced.
- **Measurements were taken while another change was in flight.** The working
  tree acquired unrelated modifications to `apps/runtime/team`, `platform/turn-gate`
  and the team components at 11:35, and a rebuild followed at 11:36. Runs before
  that are unaffected; the soak that straddled it is the quarantined one.
- **Build identity does not capture what actually varied.** `build.sha` is the
  same commit for the patched and unpatched arms, because a `patches/` entry and
  an uncommitted `src/` change both register only as `dirty: true`. The arms are
  distinguishable by their labels and by nothing in the result files.
- **The residual detached-node growth is unattributed.** 1,650 nodes per 200
  cycles, reproduced to the node across five runs — a determinism that says it is
  not noise and nothing more. Not the console object group (above), not attached
  to `document` (previous round).
- **Nothing here measures Windows, and nothing measures a real user's cadence.**
  The soaks open ~30 files per minute.

### Product gaps found and not closed

- **File opens still cost memory** — the fixes in this round moved the listener
  slope to zero and left the memory slope where it was.
- **The terminal scenario's node delta regression** (above) is a real change in
  the product between two builds, unlocated.

---

## Not done, in order

0. **Re-run the 45-minute soak on an undisturbed machine.** It is the only
   remaining thing that would say whether this round changed the memory curve at
   all, and the guard added here means a repeat of the disturbance will now be
   visible instead of publishable.
1. **Locate the memory cost of a file open.** It is now isolated to opening
   files, has survived three fixes, and is the last thing on this list that is
   both unbounded and the product's.
2. **Resolve the probe/soak disagreement**, which decides whether item 1 is worth
   anything: a 45-minute probe arm with no terminals separates run length from
   the terminal cadence for the price of one run.
3. **Locate the s7a node-delta regression** by bisecting between the frozen
   baseline and `1db661d`.
4. **Decide what a repeated label should do.** Overwriting is sometimes what the
   operator wants and sometimes destroys the comparison they were building;
   right now it always happens and never says so. Refusing, or archiving the
   displaced result, are both defensible — silence is not.
4. Carried over: wide-table scenario, the unresolving `close()`, S6/S8 through
   the mock, the digital-human path, Windows, HTML preview isolation, the two
   unreachable viewers.
