# 2026-09 — locating the leak

Follow-up to `2026-09-degradation-instrumentation.md`. That round measured what
the leak costs; this one asks where it comes from, and finds that a majority of
it comes from the test.

Results labels: `results/leak-1/` and `results/leak-4-pinned-repeat/` (arm A),
`results/leak-3-term-nohandle/` and `results/leak-5-nopin-repeat/` (arm B),
`results/leak-2-noterm/` (arm C). One macOS machine, one `electron-vite`
production build, 60 measured cycles per arm after 8 unmeasured warmup cycles,
a terminal opened every 5th cycle in arms A and B.

---

## What changed

Three probes, none of which existed:

1. **A listener call-site tracker** (`lib/listener-tracker.ts`). Wraps
   `EventTarget.prototype` and keeps the stack of whatever registered each
   listener. Targets are held through `WeakRef`, so a listener whose target was
   later collected is reported separately and not counted as a leak — that
   distinction turns out to decide the whole round.
2. **An attached-DOM census** (`lib/dom-census.ts`). CDP's `Nodes` counts
   detached-but-referenced nodes too, so comparing the two splits "a container
   accumulates children" from "something holds detached subtrees".
3. **Heap snapshot capture and a diff/retainer tool** (`lib/heap-snapshot.ts`,
   `analyze-heap.mjs`), which reports what grew and walks the reverse edge index
   back to a retaining root.

They are driven by `specs/leak-locate.spec.ts` in a new `perf-leak` project.
It writes no `PerfResult` and has no threshold: it produces evidence, and
belongs outside `perf` so that a suite people run for numbers does not pay for
it.

**The instrument was checked against a known answer before being believed.** The
terminal library's unregistered listeners were established in an earlier round by
reading the dependency, not by measuring. They had to appear here, and they did.

---

## Results, with the boundary on each

| Result | Boundary that changes how to read it |
|---|---|
| **The leak is in the terminal, not in opening files.** Per cycle, CDP listener growth is 0.80 with a terminal every fifth cycle and **0.10 with no terminal at all**. Opening and closing a file is very nearly clean. <br>`leak-1/` vs `leak-2-noterm/` | The soaks mix both, and all four historical soak figures (0.97/1.00/0.92/0.986 per cycle) are that mixture. The earlier round's reading — that the leak lives "in the shell code common to every file open" — came from an isolation experiment that left no result file, and it is contradicted here. |
| **Half the terminal's listener growth and three quarters of its node growth belong to the test harness.** `waitForSelector('.xterm')` returns an `ElementHandle` the soaks never dispose, and an undisposed handle pins the terminal's DOM from outside the renderer. Removing it: listeners 0.80 → 0.40 per cycle, CDP nodes 3.37 → 1.17, detached `HTMLDivElement` +106 → +33, detached `HTMLTextAreaElement` +12 → **0**. <br>`leak-1/` vs `leak-3-term-nohandle/` | One line differs between the two arms; everything else is identical. Both arms were repeated and reproduced their counts exactly (`leak-4-pinned-repeat/`, `leak-5-nopin-repeat/`), which is what makes a single-run comparison usable here — these are counts, not timings. |
| **The genuine defect: `ScreenDprMonitor` is constructed and never registered.** `CoreBrowserService`'s constructor does `this._screenDprMonitor = new ScreenDprMonitor(this._window)` — a plain assignment, while five siblings on the same lines go through `this.register(...)`. So its `dispose()` never runs, and the `resize` listener it puts on `window`, plus the `matchMedia` list and listener from `_updateDpr`, stay for the life of the window. Measured: exactly one leaked `resize` listener per terminal open, 12 opens → 12 listeners, stack naming `_setWindowResizeListener` inside the monitor's constructor. <br>`leak-3-term-nohandle/leak-locate.json`, `listenerDump.groups` | Verifiable without any measurement, by reading `node_modules/@xterm/xterm/lib/xterm.js`. The measurement's role is to show it actually fires once per terminal, and that nothing else in the terminal path does. |
| **The textarea `focus`/`blur` pair named in the previous round is not a leak in practice.** Both appear only in the pinned arm. Unpinned, their target is collected and the tracker reports them under `targetCollected` (574 → 598, exactly the 24 of them). <br>`leak-1/` vs `leak-3-term-nohandle/` | The code-level fact stands — they are outside the registry `dispose()` walks. What is corrected is the consequence: the textarea dies with the terminal, and a listener on a dead target costs nothing. They were visible as a leak only because the test kept the textarea alive. |
| **The leaked DOM is detached, not accumulating in a container.** Attached node count grew by **0** in every arm while CDP's counter grew, so no container is filling up. <br>All five labels, `nodes.attachedGrowth` | Rules out a whole class of cause, and rules out the cheap fix that would go with it. Says nothing about which JS object holds the detached subtrees. |

---

## What this implies about the frozen soak numbers

The 45-minute baseline ran 1,326 cycles with a terminal every fifth, i.e. **265
terminal opens**, each holding an undisposed handle. At the per-open cost
measured here — 2 CDP listeners and 11 CDP nodes — that is ~530 of its 925
listeners and ~2,915 of its 3,891 nodes.

**This is arithmetic carried across runs of different length, not a measurement.**
It is enough to say the frozen numbers are contaminated and roughly how much; it
is not enough to publish a corrected rate. The corrected rate needs the soak
re-run with the handle gone.

---

## Not established

### Measurement gaps

- **Nothing here measures memory.** The probe counts listeners and nodes; the
  0.20 MB per cycle of working-set growth comes from the soak, whose terminal
  handles are now known to pin DOM. Whether the memory curve survives removing
  the pin is **unknown**, and it is the one number that made this leak worth
  fixing. Settling it costs one 45-minute soak.
- **The residue on file-only cycles is unattributed.** Arm C still grows 0.10
  listeners and ~1.75 nodes per cycle. Retainer paths for the remaining detached
  divs terminate at CDP global handles, so an unknown share of even that residue
  may be the automation client rather than the product. A renderer under
  automation cannot prove its own absence of automation effects.
- **The tracker only sees `EventTarget.prototype`.** CDP's counter consistently
  reports ~11 more listeners than the tracker attributes in every arm. That gap
  is stable and small, but it is unexplained.
- **The tracker perturbs the heap it is measured in.** It retains one record and
  one captured stack string per registration — visible in the snapshot diff as
  ~1,579 `WeakRef` objects and several hundred stack strings. It does not retain
  targets, so the detached counts stand, but the class-level diff should not be
  read as the product's allocation profile.
- **macOS only, one build, 60 cycles.** The historical rates come from 45-minute
  runs; a 60-cycle probe locates a cause, it does not establish a rate.

### Product gaps found and not closed

- **`ScreenDprMonitor` is never disposed** (above). `patch-package` and a
  `patches/` directory already exist, so the mechanism for fixing a dependency is
  in place. The fix is to register the monitor, not to remove a listener
  elsewhere.
- **`src/renderer/stores/terminal.store.ts` never deletes from its `sessions`
  Map.** Exiting a terminal rewrites the entry's state to `'exited'`. Unbounded
  by reading; its cost was not measured here, and it is small per entry.

---

## Not done, in order

1. **Re-run the 45-minute soak with the terminal handle disposed**, and compare
   the working-set slope against `results/instrumented-45min/s9-soak.json`. This
   is the only way to learn how much of the memory growth is real, and every
   decision about whether the leak is worth further work depends on the answer.
   It means editing `specs/s9-soak.spec.ts`, which is the frozen baseline script
   — the change is one line and the baseline it invalidates is one this round
   already shows to be contaminated, but it is a deliberate break and needs to be
   recorded as one.
2. **Patch `ScreenDprMonitor` registration.** Judge it by whether the leaked
   `resize` listener count goes to zero in arm B, which is a 3-minute run, not by
   whether the code looks right. Hands-on verification of the terminal (focus,
   IME, copy/paste, window resize across displays with different DPR) before it
   merges.
3. **Delete the entry in `terminal.store.ts` when a session exits.**
4. Carried over: wide-table scenario, the unresolving `close()`, S6/S8 through
   the mock, the digital-human path, Windows, HTML preview isolation, the two
   unreachable viewers.
