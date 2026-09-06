/**
 * thresholds.mjs — what the performance gate requires, and why each number is
 * what it is.
 *
 * ## The rule that matters most when this gate fails
 *
 * **Adding an entry to a skip or exemption list is never an acceptable way to
 * turn a failing check green.** Fix the criterion or fix the code. A gate that
 * gets exempted one scenario at a time stops being a gate; it becomes a file
 * that records which checks people found inconvenient. If a ceiling here is
 * genuinely wrong, change it deliberately with the measurement that justifies
 * the new number — not with an exemption for the case that tripped it.
 *
 * ## Why DOM node count, and nothing else, is the blocking metric
 *
 * The same scenario measured at machine load 4.4 and 23.5 differed by 0.01% in
 * DOM node delta and by 12-18% in duration. Node count is fixed by viewport
 * size and code structure, not by how fast or how busy the machine is, so it is
 * the one metric that means the same thing on somebody else's laptop. Duration,
 * CPU and memory are recorded on every run and never block: there is no
 * cross-machine standard for them.
 *
 * ## Why the ceilings are this loose
 *
 * Worst observed run-to-run spread on any scenario gated here is 3.3% (the 2MB
 * markdown, measured three times, once on a machine 6.6x more loaded). The
 * ceilings sit 4-10x above their anchors — roughly 150x that noise band — and
 * still land below the values a broken build produces, because the gap between
 * "virtualized" and "renders the whole file" is two orders of magnitude.
 *
 * Nothing useful lives in between. A tighter ceiling detects no additional real
 * regression and buys false positives, and a gate that fires falsely gets
 * loosened until it is decorative.
 *
 * Scenarios whose node delta is small enough that run-to-run noise exceeds the
 * signal (cold start, terminal, browser view, image, pdf: swings of +62%, -36%,
 * and sign flips between runs) are excluded outright rather than given wide
 * bands. A metric that cannot be gated at any number should not be gated at a
 * generous one.
 *
 * ## What this gate does not catch
 *
 * - **Partial regressions.** Virtualization still on but the render window
 *   tripled (1,289 -> ~3,900 nodes) passes. Accepted deliberately: the ceilings
 *   exist to catch de-virtualization, and CSV_SIZE_DECOUPLING below covers the
 *   mechanism itself. Tightening far enough to catch window tuning would put
 *   the threshold inside the noise band.
 * - **Windows.** Every number here was measured on macOS. Both release scripts
 *   produce Windows packages and there is zero Windows performance data. This
 *   gate never touches the platform most users run.
 * - **Anything outside the gated scenarios**, including the HTML viewer's
 *   actual behaviour — see NON_VIRTUALIZED below.
 */

/**
 * Ceilings on `nodes.delta`. `anchor` is the measured post-fix value the
 * ceiling was derived from; `broken` is the value a known-bad build produced,
 * kept so a future reader can re-derive the margin instead of trusting it.
 */
export const NODE_CEILINGS = {
  's4-markdown-preview': { ceiling: 8000, anchor: 1289, broken: 536406 },
  's5-markdown': { ceiling: 8000, anchor: 1278, broken: 536406 },
  's5-csv-50kb': { ceiling: 5000, anchor: 749, broken: 15484 },
  's5-csv-500kb': { ceiling: 5000, anchor: 751, broken: 144889 },
  's5-csv-5mb': { ceiling: 5000, anchor: 746, broken: null },
  's5-json': { ceiling: 8000, anchor: 1651, broken: null },
  's5-code': { ceiling: 8000, anchor: 1810, broken: null },
  's5-text': { ceiling: 4000, anchor: 397, broken: null },
  's5-html': { ceiling: 400000, anchor: 262937, broken: null }
}

/**
 * Scenarios that are gated while known NOT to be virtualized. Registered
 * explicitly rather than omitted: a reader who sees s5-html in the gate would
 * otherwise assume its 262,937 nodes were fixed. The ceiling only catches
 * further blow-up.
 */
export const NON_VIRTUALIZED = {
  's5-html': 'HTML preview still renders in-process; unchanged by the viewer work.'
}

/**
 * Virtualization's signature is that node count stops tracking file size. These
 * three read the same viewer across a 100x size range on one machine in one
 * run, so the ratio carries no cross-machine noise: measured 751/746 = 1.007.
 *
 * This is the sensitive check. A viewer that went size-linear at even 1% of
 * content would blow the ratio long before any absolute ceiling noticed.
 */
export const CSV_SIZE_DECOUPLING = {
  scenarios: ['s5-csv-50kb', 's5-csv-500kb', 's5-csv-5mb'],
  maxRatio: 3,
  /** Below this the ratio is noise, and a near-zero delta is class B's problem, not this check's. */
  minDelta: 100
}

/**
 * A viewer that opened something adds at least a container subtree. The
 * smallest delta among gated scenarios is 397 (s5-text), so this floor has 4x
 * margin while still catching the failure mode where a collector assigns the
 * end value from the start value and reports a flawless zero.
 */
export const MIN_NODE_DELTA = 100

/** A viewer "open" that returned this fast did not open anything. */
export const MIN_DURATION_MS = 100

/** Below this, avg/max are biased toward whatever part of the run happened to sample. */
export const MIN_SAMPLING_RATIO = 0.5

/**
 * Scenarios allowed to report `skipped` / `precondition-failed`, and the only
 * reasons accepted for each. A skip for any other reason is a failure, so a run
 * where nothing executed can never read as a clean run.
 *
 * This is not an exemption list for failing checks — see the rule at the top of
 * this file. It records preconditions the environment either has or does not.
 *
 * The values are the vocabulary `writeSkipResult` writes into `skipReason`, and
 * the two sides have to be read together: they were written independently once
 * and disagreed on both the field name and the vocabulary, so the entire skip
 * path was unreachable and every registered skip would have failed the gate.
 *
 * `s8-digital-human-run` is deliberately absent. It reaches
 * `precondition-failed` only *after* running, when its own self-check finds no
 * streaming ever happened — registering that would turn "nothing happened" back
 * into a clean result, which is the exact failure this file exists to prevent.
 * Only a precondition detected before the scenario acts belongs here.
 */
export const ALLOWED_SKIPS = {
  's2-long-stream': ['no-api-key', 'mock-unavailable'],
  's6-preview-plus-chat': ['no-api-key', 'mock-unavailable']
}

/** The release gate's blocking set: every scenario that must run and pass. */
export const RELEASE_GATE_SCENARIOS = Object.keys(NODE_CEILINGS)
