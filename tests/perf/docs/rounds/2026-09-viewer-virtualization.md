# 2026-09 — viewer virtualization and main-process logging

> **Read `2026-09-harness-hardening.md` alongside this.** It is the follow-up round,
> and it revises three things stated below: the 5 MB CSV fix covered only one file
> shape, the one document reported here as collapsing did so because of a guard
> misfire rather than its unclosed fence, and the "open duration" column is no longer
> unmeasurable — the 3-second floor is gone and real numbers exist. Items 5, 7 and 9
> of "Not done" are closed there. Everything else below stands as recorded.

Before baseline: `results/report-snapshot/` · After baseline: `results/final-frozen/`
Both frozen. Twenty scenarios, run before and after; nineteen produced usable data.
All data collected on one macOS machine against an `electron-vite` production build.

CPU below is **percent of one core**. Read `../measurement-practice.md` first if you
intend to act on any of these numbers.

---

## What changed

Two defects, both found by measurement rather than review.

1. **Three content viewers put the whole file into the DOM at once** — markdown
   preview, CSV table, and the HTML source view. DOM size scaled with file size.
   Fixed by chunked/row virtualization and by routing every viewer's *source* view
   through the existing viewport-rendering editor. No new technique was introduced:
   the product already contained three correct patterns, and these viewers used none.
2. **Every main-process log line was a synchronous disk write.** The logging
   library's file transport defaults to synchronous, `console.*` is globally
   captured, and file level stays at `info` in production — so an unguarded
   `console.log` in the main process blocks the event loop, which freezes *every*
   window, not one. Fixed by enabling async writes and gating hot-path logging;
   paths that log and then immediately `exit()` were switched to an explicit
   synchronous helper so the last diagnostic line is not lost.

---

## Results, with the boundary on each

| Result | Boundary that changes how to read it |
|---|---|
| **2 MB markdown, longest UI freeze 7,688 → 75 ms.** Long tasks 94 / 31,635 ms → 1 / 75 ms. DOM node delta 536,406 → 1,289. Renderer peak memory 3,490 → 261 MB. Listener delta +9,011 → +40. Post-render CPU over the following 15 s: 115.9% → 0.8%. <br>`report-snapshot/s4-markdown-preview.json` → `final-frozen/s4-markdown-preview.json` | macOS only. An independent repeat of the same content reproduces it (536,406 → 1,278, `s5-markdown.json` both sides), so this is not a single lucky run — but it is one machine. The *open duration* for this row is not usable; see the invalid column below. |
| **5 MB CSV, from crashing to opening.** Before: renderer crash, `status: "error"`, `valid: false`, `crashCount: 1` — node and listener counts unobtainable because the process was gone. After: `status: "ok"`, node delta 746, renderer peak 233 MB, renderer CPU average 135.6% → 0.8%. <br>`report-snapshot/s5-csv-5mb.json` → `final-frozen/s5-csv-5mb.json` | The before-side CPU and memory come from an **invalid run** (sampled up to the crash). They are order-of-magnitude context, not a subtrahend. No percentage should ever be computed from that row. Rows only — column virtualization was not done, see below. |
| **Virtualization's signature: DOM size decoupled from file size.** 50 KB / 500 KB / 5 MB CSV → 749 / 751 / 746 nodes. Before: 15,484 / 144,889 / crash. <br>`final-frozen/s5-csv-{50kb,500kb,5mb}.json` | This is the strongest structural claim in the round, because node count is the one metric that reproduces across machine loads. It says nothing about wide tables. |
| **Preview plus chat, from not finishing to finishing.** Before: `status: "hung"`, `valid: false` — no streaming cursor within 10 s of sending, scenario abandoned. After: `status: "ok"`, completes, node delta 5,626, renderer peak memory 2,901 → 477 MB. <br>`report-snapshot/s6-preview-plus-chat.json` → `final-frozen/s6-preview-plus-chat.json` | **Qualitative only.** The durations (99,288 vs 109,867 ms) are not comparable — the first is "time until we gave up", the second is "time to complete". The before run also carries **no machine-load record** (collected before load recording existed). And one real-model observation runs against this result and was never explained; see "Not established" below. |
| **HTML preview: longest freeze 1,056 → 148 ms**, renderer peak 830 → 622 MB. Node delta essentially unchanged, 262,945 → 262,937. <br>`report-snapshot/s5-html.json` → `final-frozen/s5-html.json` | The node count did not change **and should not have**. The preview renders into a `srcDoc` iframe, which does *not* get its own process, so its DOM is counted in the same process total. The improvement here is the removal of a full-document synchronous highlight pass that ran whether or not the user opened the source view. |
| **Seven untouched paths did not move.** 500 KB code 1,812 → 1,810 nodes; 5 MB JSON 1,657 → 1,651; 5 MB log 396 → 397; 300-page PDF 66 → 42; 1 MB image 58 → 94; long stream 4,260 → 4,227; cold start reaches an identical end state (271 nodes both sides). <br>`s5-code`, `s5-json`, `s5-text`, `s5-pdf`, `s5-image`, `s2-long-stream`, `s1-cold-start` in both labels | This is what makes the improvements attributable rather than drift. Note the cold-start *delta* reads 198 → 3 only because the first sample lands at a different moment during startup; the end state is what is comparable, and it is identical. Two other unchanged paths (chat list scrolling, terminal) did fluctuate between runs and are not claimed either way. |

### The "open duration" column is invalid — do not use it

The harness waits up to 3 s for a loading indicator to appear before it starts
timing (`tests/perf/lib/open-artifact.ts:58`, which swallows the timeout and
continues). When rendering is fast enough that the indicator never appears, that
full 3 s lands inside the reported duration. Every fast post-fix scenario therefore
reports the same number regardless of what it opened:

| 300-page PDF | 1 MB image | 5 MB JSON | 5 MB CSV | 2 MB markdown | 50 KB CSV |
|---|---|---|---|---|---|
| 3,150 ms | 3,145 ms | 3,150 ms | 3,158 ms | 3,133 ms | 3,143 ms |

That is a floor, not an achievement. The only defensible statement is qualitative:
opening a 2 MB markdown document went from **17.7 s to below what this harness can
resolve**. The true value was not measured. Removing the 3 s wait and re-running is
listed under "Not done".

### Continuous use still degrades — not fixed

Two 45-minute soaks, ~780 open/close cycles each, before and after
(`report-snapshot/s9-soak.json`, `final-frozen/s9-soak.json`):

| | Before (786 cycles) | After (782 cycles) |
|---|---|---|
| Event listeners, start → end | 236 → 1,000 | 216 → 996 |
| Listeners, first-quarter → last-quarter average | 443 → 916 | 449 → 916 |
| DOM nodes, first-quarter → last-quarter average | 6,668 → 8,181 | 2,349 → 4,098 |
| DOM nodes, peak | 20,204 | 6,351 |

The DOM side improved (peak down 69%). **The listener curve did not move at all** —
916 versus 916. That is not "improvement was small"; it is unchanged, as expected,
since nothing in this round touched that path.

It is a real leak, not deferred collection: a third soak forcing GC before every
sample still grew 216 → 928 over 772 cycles
(`final-frozen/s9-soak-forcedgc.json`). Net growth divides out to **~1 leaked
listener per open/close cycle** in all three runs (0.97 / 1.00 / 0.92).

An isolation experiment reported the same 1-per-cycle rate for two viewers with
entirely different implementations, which would place the leak in the shell code
common to every file open rather than inside any viewer. **That experiment left no
result file** and is recorded here as unverified — it is consistent with the soak
arithmetic above, which is traceable, but it has not been re-derived from raw data.

**Roughly a quarter of the growth is attributed, and that share is itself derived
from the unverified isolation figures — treat it as an estimate.** The mechanism,
however, is verifiable directly in the dependency. The terminal library's
`CoreBrowserService` constructor registers four disposables through `this.register`
and then attaches two more listeners with bare `addEventListener` (focus and blur
on its textarea), outside the registry that `dispose()` walks:

```bash
python3 -c "import re;s=open('node_modules/@xterm/xterm/lib/xterm.js',encoding='utf8',errors='replace').read();print(re.search(r't\.CoreBrowserService=void 0.{0,760}',s,re.S).group(0))"
```

Twelve `removeEventListener` calls exist in that file; none of them targets the
textarea's focus or blur. So `dispose()` cannot reach these two by design — the fix
is to wrap them in `register`, not to add a `removeEventListener` elsewhere. The
round also reported a runtime count of `add=15 / remove=0` over 15 terminal cycles
with full retention after five forced GCs; **that count has no result file** and is
listed as unverified. The code-level fact above stands on its own.

The larger share — the ~1 per file open/close cycle — is **not located**. Two
investigation routes were spent and both returned negative results worth not
repeating: an A/B run bypassing the third-party file-tree component still leaked
linearly (`results/probe-a-tree/`, `results/probe-b-card/` — traceable), and a
`getEventListeners()` diff put `window` and `document` together at only ~15% of the
growth (no result file; unverified). The next step has to be heap snapshots and
retainer paths, not per-object queries.

---

## Not established

Separated deliberately: a thing we could not measure and a thing we measured and
found bad get read as the same thing if they sit in one list.

### Measurement gaps — no data, no finding either way

- **Windows was never measured.** All data is macOS. User reports come
  predominantly from Windows. The mechanism identified (main-thread blocking) is
  OS-independent, and Windows plausibly has less CPU headroom and so surfaces it
  sooner — but that is reasoning, not measurement. **No number in this document
  has been reproduced on Windows.**
- **The digital-human execution path produced no data at all.** The deterministic
  local mock cannot make tool calls, so the scenario recorded
  `status: "precondition-failed"` (`final-frozen/s8-digital-human-run.json`). This
  is a limitation of the measurement setup, **not** a finding about the feature.
  Nothing about that path's performance — good or bad — is established here.
- **The main-process logging fix produced no measurable CPU improvement.** Across
  every scenario that could be run, main-process CPU moved inconsistently and
  within run-to-run noise: long stream 5.3% → 4.9% average, preview+chat 1.7% →
  2.0%, markdown 1.4% → 0.9% (peaks moved in both directions, 30.8% → 46.8% on the
  last). The reason is knowable: the most expensive gated log serializes each
  message with indentation, and its cost scales with tool-call payloads — which the
  deterministic mock never produces. **The claim for this fix is code-level only**
  (the library defaults, the global console capture, the production log level are
  each verifiable by reading), and no performance benefit is claimed.
- **Wide tables are uncovered and unmeasured.** Row virtualization was implemented;
  column virtualization was not. Every visible row still renders every column
  (`CsvViewer.tsx:320`, `:338`). A fixture exists —
  `tests/perf/fixtures/regression/wide-columns.csv`, 3,577,493 bytes, 2,000 columns
  × 200 rows — and arithmetic on those two code sites predicts ~62,000 cell
  elements for a ~30-row viewport, i.e. back into the pre-fix range. **That is
  arithmetic, not a measurement**, and it is the only number in this document of
  that kind.
- **The crash/self-recovery loop was never directly triggered.** The chain
  (unresponsive → silent reload → relaunch) is read from code, not observed.

### One observation that runs against the headline and was not explained

During post-fix hands-on verification on the fixed build, opening a 2 MB markdown
document and then sending a message produced **no first token within 30 seconds** —
the symptom this round claims to have fixed.

It neither refutes the controlled result nor is refuted by it, because they are not
the same path: the controlled scenario uses a deterministic local mock, and the
hands-on check used a real model service whose latency is not ours. But **no
control group was run** — nobody measured "send a message without opening a large
file" on the same service at the same time — so it cannot be attributed. It is
recorded here unexplained rather than dropped. Getting a control group for it is
listed below.

### Known behaviour changes from virtualization

Not defects, but users will notice: manual text selection and browser in-page
search only reach content currently mounted in the viewport (the toolbar copy
action still copies the full text). A document containing an unterminated code
fence, or one HTML container wrapping the entire file, degrades to a single chunk —
it renders correctly but gets no benefit, with no indication.

That degradation is live today, not theoretical. Running the current splitter over
this machine's full markdown corpus, one real document (142,996 characters,
containing an odd number of code-fence markers, i.e. one unterminated fence) is
rendered as a single chunk.

---

## The corpus check, and a number that is not a constant

The most valuable check in this round was not a unit test — it was running the
splitter over the repository's real markdown documents. That is what caught the
worst regression, when guards tuned on synthetic fixtures silently disabled
virtualization for a large fraction of real documents.

Measured on this machine at the time of writing, with the threshold read from the
source (`MarkdownViewer.tsx:36`, 128,000 characters):

- **4,428** markdown files scanned.
- **44** exceed the threshold — but only **29 distinct contents**: fifteen of the
  forty-four are byte-identical copies in a mirrored directory. Any "N of 44"
  ratio computed over that set double-counts.
- **3** currently collapse to a single chunk. Two of those are the same duplicated
  file; one is the committed `footnotes.md` fixture, where collapsing is the
  intended behaviour. So: **one real document, one expected fixture.**

**Do not carry the count forward as a constant.** It is a property of one
machine's working tree at one moment — most of those documents are generated
conversation logs that keep growing, and files cross the threshold over time. Three
different values appear in the source report for this reason. Any future statement
about it must be re-measured, and the measurement command must be part of the check
rather than a number in prose.

**Reproducibility caveat, and it is a large one:** of the 44, thirty-seven are not
tracked by git. The only over-threshold documents present in a clean clone are the
seven committed regression fixtures — all synthetic. **The corpus check as run
here cannot be reproduced from this repository.** Any attempt to automate it must
first answer what corpus it runs against.

Byte-versus-character units: the threshold counts characters; file-size tools
report bytes, and CJK-heavy documents differ by 1.8×–2.58×. The error is one-way —
under UTF-8 `bytes >= chars`, so a byte-based filter is always a superset and
cannot miss a genuinely over-threshold document. Past selections made in bytes
admitted noise; they did not hide problems.

---

## Not done, in order

1. **Locate the listener leak before patching anything.** Heap snapshot and
   retainer path first. Forced GC does not release the retained listeners, which
   means something external still holds them — so patching the terminal library
   alone may cut one path and leave the residue, while looking like a fix. Then:
   (a) `src/renderer/stores/terminal.store.ts` never deletes from its `sessions`
   Map — exiting a terminal only rewrites the entry's state to `'exited'`, so the
   map grows without bound. This is small, inside `src/`, unbounded growth on its
   own merits, and a plausible external holder. (b) Only then decide on patching
   `CoreBrowserService` to wrap those two listeners the way the other five in the
   same constructor already are; this repo already uses `patch-package` and has a
   `patches/` directory, so the mechanism exists. A terminal patch needs hands-on
   verification (focus, IME, copy/paste) before it can merge. Judge each step by
   whether net growth per cycle actually falls, on the same forced-GC soak — not by
   whether the code looks right.
2. **Measure on Windows.** The largest single gap between what was measured and
   where the complaints come from.
3. **Measure the digital-human execution path.** Requires a deterministic mock that
   can produce tool calls. This also unblocks measuring the main-process logging
   fix, whose most expensive case only occurs on tool-call payloads.
4. **Add a wide-table scenario, then decide on column virtualization.** The fixture
   is ready; adding the scenario is one case in `tests/perf/specs/`. The prediction
   says it regresses to pre-fix scale — but a prediction is not a result, and the
   priority depends on whether users actually hit wide tables.
5. **Remove the 3-second measurement floor and re-run.** Wait on the viewer's own
   mount signal instead of a loading indicator. This is the only improvement in the
   round whose size is unknown.
6. **Get a control group for the first-token observation** — same real model, same
   moment, without a large file open. It is the one unexplained result pointing the
   wrong way.
7. **Put the real-corpus check into `tests/` and into CI**, resolving first what
   corpus it runs against in a clean clone. Criteria: a collapsed document must be
   explainable by its own content, chunk count must scale roughly with length, and
   the correctness counterexamples must hold. **When it fails, fix the criterion or
   the code — never add a filename to a whitelist.**
8. **Flush the log queue on normal exit.** The paths that log and immediately exit
   are covered; earlier entries in the queue and other exit paths can still be lost
   in async mode. A `before-quit` flush covers the case that is actually
   recoverable. Force-kill is not recoverable by any asynchronous mechanism and is
   not worth complexity.
9. **Gate one remaining hot-path log** in the streaming processor
   (`src/main/services/agent/stream-processor.ts:550`), which fires on every message
   after a result and has no development-mode guard. Its worst cost — blocking the
   main process — is already removed by async writes; what remains is string
   assembly and queueing.
10. **Move the HTML preview to a separate process.** This buys crash and memory
    isolation, not fewer nodes. It crosses viewer-shared lifecycle code and a
    deliberate architectural boundary, so it is its own piece of work, not a
    performance tidy-up.
11. **Delete two unreachable viewers.** `TextViewer.tsx` and `JsonViewer.tsx` are
    unreachable — every content type has an explicit branch at the dispatch site, so
    the `default` branch cannot be entered. A static review once flagged them as
    high-priority performance problems; deleting them prevents a repeat.
