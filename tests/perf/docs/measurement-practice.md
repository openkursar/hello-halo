# Measurement practice

How to measure this client's performance without fooling yourself. Everything
here was paid for in a real round; the round's results live in `rounds/`.

---

## 1. The first assertion is "is this measurement trustworthy", not "is this number good"

A threshold check on an untrustworthy number is worse than no check, because it
produces a green result that raises confidence in a wrong conclusion.

A gate must assert, **in this order**:

1. **The collector actually ran.** Any collection failure reports `null` or
   `unsupported` — never a fallback to `0`. This is not hypothetical: a failure
   path once copied the run's *start* values over its *end* values, and the worst
   scenario in the suite — a renderer that was hanging — reported the best row in
   the table: `valid: true`, node delta 0, memory *down* 182 MB, longest task 0 ms.
   Every channel where "worse" can render as "better" has to be closed by
   construction.
2. **The scenario actually did the thing it claims.** A precondition assertion,
   not a threshold: e.g. node delta must be `> 0`, the tab must have opened, the
   stream must have produced a token. A scenario that silently did nothing passes
   every threshold in the suite.
3. **The run was not contaminated.** No silent renderer reload, no crash, load
   average recorded and comparable to the baseline. A reload is especially
   dangerous: it clears the injected observers and abandons the expensive render,
   so it makes CPU samples look *better*. Any run with a reload or crash is
   `valid: false` and does not enter a comparison table.

Only after all three do thresholds mean anything.

### When a check fails, adding an entry to a whitelist is never an acceptable way to make it pass

Not for a filename, not for a directory, not "just this one". A check that reports
false alarms and is softened instead of fixed becomes decorative, and a decorative
check is worse than none because people still trust it.

This is not a precaution — it was reached for once. The first version of a corpus
check treated "too few chunks" as an automatic false positive, which misjudged a
document that genuinely had nowhere to split (over a million characters with no
blank line). The correct fix was to sharpen the criterion. Exempting the document
would have made the check pass and stopped it from ever catching the real case.

---

## 2. Which metrics can be gated on

Structural metrics reproduce across machine loads. Timing and CPU do not. This is
not an opinion; it is visible in four runs of the *same build* of the same
scenario at different machine loads:

| Result file | 1-min load | DOM node delta | Longest-task total | Renderer CPU avg | Renderer peak mem | Duration |
|---|---|---|---|---|---|---|
| `results/report-snapshot/s4-markdown-preview.json` | 3.18 | 536,406 | 31,635 ms | 62.3% | 3,490 MB | 17,667 ms |
| `results/after-1/s4-markdown-preview.json` | 5.22 | 536,400 | 28,184 ms | 56.6% | 2,942 MB | 17,640 ms |
| `results/baseline-final1/s4-markdown-preview.json` | 6.70 | 536,403 | 36,121 ms | 65.3% | 3,463 MB | 17,874 ms |
| `results/dev/s4-markdown-preview.json` | 8.05 | 536,402 | 27,116 ms | 54.7% | 3,319 MB | 18,204 ms |

Spread across those four runs:

- **DOM node delta: 0.001%** (6 nodes out of 536,406).
- Longest-task total: **33%**. Renderer CPU average: **19%**. Renderer peak
  memory: **19%**. Duration: 3.2% — and see §3 on why that column was a trap.

So:

- **Gateable: DOM node count.** It is the only metric here that is stable enough
  to carry a hard threshold across machines. A regression that shows up as
  100× more nodes shows up identically on a busy machine and an idle one.
- **Not gateable: duration, CPU, longest task.** Meaningful only as a
  same-environment before/after comparison, on the same machine, in the same
  session, with the load recorded.
- **Memory: order of magnitude only.** It is grouped with "structural" metrics by
  intuition, and the data above says that is wrong — peak renderer memory moved
  19% between runs of an identical build. 3,490 MB → 261 MB is a real result.
  A 15% memory change is noise.

Every result file records the machine load at collection time, so nobody can read
a number without also seeing how busy the machine was. Keep it that way.

CPU is reported as **percent of one core**. Electron's `percentCPUUsage` is
normalized by total core count, so it differs from `ps` by a factor of the core
count. That trap was hit once and nearly produced a conclusion in the wrong
direction.

---

## 3. Lessons

Each of these cost a round to learn. They are ordered by how much they change what
you would otherwise do.

### Numbers adding up is not the same as numbers meaning anything

Two independent fact-checks were run over the same report and the same data. The
first was **mechanical** — every number traced back to the raw JSON. Over forty
numbers, all matched, zero problems. The second was **semantic** — asking of each
number "does this measure what it claims to measure". It immediately found that an
entire column was meaningless: the "open duration" column was pinned to the
measurement harness's own 3-second wait, so every fast scenario reported ~3.15 s
regardless of what it opened.

A purely mechanical check is blind to this class of failure, and worse, it emits a
clean report that makes the wrong conclusion *more* credible. Budget for the
semantic pass; it is the one that finds things.

### A slope is not a result until you have looked at the trajectory under it

A 45-minute soak reported its working-set slope as **−0.075 MB/cycle** — memory
going down, on the run that was meant to confirm a fix. Both of the round's
convergence criteria were satisfied and the fix would have been declared good.

The trajectory says otherwise. It is point-for-point identical to the unfixed arm
for the first five eighths of the run, then drops 86 MB across two consecutive
samples at minute 24, as the machine's 1-minute load average reaches 8.0. That is
the operating system reclaiming pages under memory pressure. The slope up to that
point is 0.105 MB/cycle, against 0.118 for the arm with no fix at all — the fix
did nothing, and a single least-squares number over the whole run said it did
something excellent (`results/soak-fixed/s9-soak.json`).

**A regression line over a run that contains a step is a description of the step,
not of the run.** Print the trajectory next to every slope, and print the load
average next to the trajectory. This generalizes past memory: any metric the
environment can move in one jump can produce a slope with the wrong sign.

The corollary is that a *falling* memory curve is not automatically good news, and
is the one direction nobody double-checks.

### A per-action rate needs an arm that holds the clock and drops the action

"0.09 MB per file open" and "0.09 MB per 1.9 seconds of being alive" are the same
measurement until something separates them. Four soaks and nine probes reported
per-cycle memory growth before anyone ran a cycle that opened nothing.

When that arm was finally run — same build, same automation, same cycle duration,
back to back — opening files gave **+0.077 MB/cycle** and doing nothing gave
**−0.167 MB/cycle** (`results/mem-5-mixed-files/`, `results/mem-6-idle/`). The
growth was real and it was the work, but nothing before that arm could have said
so, and the idle arm's *decline* is a second thing no per-cycle figure would have
revealed: the process gives memory back when left alone, so every per-cycle cost
had been measured against a baseline that was itself moving.

Applies to any metric attributed to an action inside a loop. Record wall-clock
elapsed time alongside cycle count so both rates can be computed, and keep an arm
that spends the time without doing the work.

### The synthetic tests all passed; the real corpus found the regression

The round's worst regression was that correctness guards, tuned on clean synthetic
fixtures, misfired on ordinary real documents and silently switched virtualization
off for a large fraction of the repository's over-threshold markdown. Every
synthetic unit test passed. The
triggers were things no synthetic fixture contains: a self-closing `<script … />`
at line start, JSX quoted inside inline code, `<anonymous>` inside a pasted JS
stack trace, a regex character class `[^a-z]`.

Run the real thing through the code. The current unit tests
(`tests/unit/renderer/lib/markdown-chunks.test.ts`, 22 cases, all passing as of
this writing) are all synthetic small inputs — they are a regression net, not a
discovery tool, and they are exactly what failed to find this.

### Verification tooling breaks, and broken output looks like a real result

This happened at least seven times in one round, across collection, criteria,
tests, and monitoring:

| Failure | What it looked like |
|---|---|
| Collector assigned start values to the end values on a failure path | The worst scenario produced the best row in the table |
| Criterion counted "document has no valid split point" as a guard misfire | Nearly rejected a correct fix |
| Test documents did not cross the threshold under test | Three cases "passed" having exercised nothing |
| Counter-proof script forgot an argument and used a default threshold | Counter-proof showed the cases were decorative; the counter-proof was broken |
| Proxy metric (total chunk count) stood in for the real property (is the container intact) | Conflated a legal split *before* a container with a split *through* it |
| Characters and bytes used interchangeably | Number and narrative both wrong, conclusion accidentally right |
| `git diff` hashing used to monitor code changes | Completely blind to new untracked files, while "hash unchanged" looked healthy |

The countermeasure that works: **next to every criterion, keep an input that
ought to fail it. If that input passes too, the criterion is broken, not the
subject.** In practice: after writing a regression test, revert the code to its
pre-fix logic and confirm the test actually goes red. A green that has never been
shown capable of going red only means it did not fail — not that it measured
anything.

One-line form: **a criterion whose author cannot say what input would break it has
not been verified.**

### Distinguish "renders too much once" from "leaks over time" before investigating

These present identically to a user — the app is slow — and demand completely
different investigations. Single-pass rendering is found by opening one large file
and measuring one moment. A leak is only visible in a long soak with the sample
count and the cycle count both recorded, and it is only *confirmed* by forcing GC
before each sample. Getting this backwards wastes the whole investigation.

The related trap: **"how much of the current total is collectable" and "how much
non-collectable growth accrued over 45 minutes" are different quantities.** A
26-cycle experiment measured the first and was used to answer a question about the
second, producing a conclusion in the wrong direction that stood internally until a
full forced-GC soak overturned it. Only the second quantity is a leak.

The same discipline applies to attribution. Differencing adjacent soak samples to
get a per-action cost does not work here: one sample-to-sample delta spans
*closing the previous artifact and opening the next one*, so the same transition
gets charged to two different labels — in one run the same data yielded +27 per
cycle for one type and −21 for another. Per-action costs have to come from an
isolation experiment that performs one action repeatedly, not from slicing a mixed
workload.

### The debt was concentrated, and the missing thing was a mechanism

The product already contained three correct patterns for rendering large content —
viewport-based editor rendering, handing content to a separate process, and a
bounded scrollback. The round did not invent anything. Three viewers had simply
adopted none of them, and there was nothing in the process that would have caught
that.

Two consequences worth keeping:

- The strongest single comparison in the round is two 5 MB files. One routed to
  the viewport-rendering viewer: 397 nodes, zero long tasks
  (`results/final-frozen/s5-text.json`). The other routed to a viewer that
  rendered every row: the renderer process crashed
  (`results/report-snapshot/s5-csv-5mb.json`, `status: "error"`, `crashCount: 1`).
  The difference was not the file. It was which viewer opened it.
- Fixing the three viewers does not fix the cause. **Any component that renders
  user-supplied content must use virtualization or a separate process — one or the
  other**, and something has to enforce it, or the next viewer added will repeat
  this.

### Optimizing upstream of a library can disable that library's own guards

Splitting a document into chunks before handing it to the renderer bypassed two
protections the rendering library already implemented internally (do not split a
document containing footnotes; merge tokens across an unclosed HTML tag stack).
Reading only our own code could not have shown this — it was found by reading the
dependency's shipped bundle. When an optimization changes what a library receives,
check what the library was doing with the original input.

### A correctness guard may only cost performance, never correctness

Chunking guards will sometimes misfire. Design so that a misfire degrades to
"slower", never to "wrong". A wrongly split code fence renders as two boxes
instead of one — ugly. A wrongly split `<details>`, HTML comment, or raw-text block
makes content that was supposed to be hidden *visible*. That asymmetry is why the
give-up fallback applies only to code fences. Anyone tidying this up without
knowing the reason will "unify" it back.
