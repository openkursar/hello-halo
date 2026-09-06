/**
 * Shared result schema for performance scenarios.
 *
 * Every scenario (S1..S10) must produce exactly this shape so
 * `compare.mjs` can diff a `before` and `after` run field-for-field.
 *
 * Hard rule: a failed measurement is represented as `null` plus a `warnings`
 * entry, never as a plausible-looking number. A scenario that hangs or crashes
 * is exactly the moment collection is most likely to fail partway through —
 * silently falling back to a default (0, or the start-of-scenario value) makes
 * the worst runs look the cleanest, which is the one failure mode this harness
 * exists to prevent.
 */

export type ProcessType = 'browser' | 'renderer' | 'gpu' | 'utility'

/** Which build output was measured. `out/main` and a packaged `.app` can share a commit yet differ in asar packing and signing. */
export type ArtifactKind =
  | 'electron-vite'
  | 'packaged-mac-arm64'
  | 'packaged-mac-x64'
  | 'packaged-win'
  | 'packaged-linux'

export interface BuildIdentity {
  sha: string
  dirty: boolean
  /** `null` when no build sidecar was found, i.e. the kind is unknown. */
  artifactKind: ArtifactKind | null
  /**
   * True only when a `.build-identity.json` sidecar proved which build was
   * launched. False means `sha` is the live HEAD, which may have moved since
   * the build — a gate should reject the run rather than read the numbers.
   */
  verified: boolean
}

export interface CpuStat {
  avg: number
  max: number
}

export interface MemStat {
  avgMB: number
  maxMB: number
  deltaMB: number
}

export interface PerfResult {
  scenario: string
  label: string
  build: BuildIdentity
  throttle: number
  durationMs: number
  cpu: { byProcessType: Partial<Record<ProcessType, CpuStat>> }
  mem: { byProcessType: Partial<Record<ProcessType, MemStat>> }
  /** How many of the planned 500ms ticks actually returned a sample — a low ratio means avg/max are biased toward the calm part of the run. */
  sampling: { plannedTicks: number; succeededTicks: number }
  /** `null` when the longtask PerformanceObserver never attached (entryType unsupported) — never a fabricated `{count: 0}`. */
  longtask: { count: number; totalMs: number; maxMs: number; p95Ms: number } | null
  /** `null` when the event-timing PerformanceObserver never attached. */
  eventLatency: { count: number; maxMs: number } | null
  heap: { startMB: number; endMB: number | null; deltaMB: number | null }
  /**
   * DOM node counts are only comparable *within the same kind of screen*.
   * Valid: S5's file types against each other (all "opened one file in the
   * canvas"). Invalid: S1 (Home page, 209 nodes) against S4 (chat+canvas view,
   * 446 nodes) — those are two different screens by definition, not a
   * virtualization regression. Never rank `nodes.end` across scenarios whose
   * screen isn't the same shape.
   */
  nodes: { start: number; end: number | null; delta: number | null }
  listeners: { start: number; end: number | null; delta: number | null }
  unresponsiveCount: number
  /**
   * Count of full page reloads observed during the measurement window.
   * `src/main/index.ts`'s `recoverRenderer()` silently reloads the renderer
   * on an 'unresponsive' event — if that fires mid-scenario, every buffer
   * this harness reads (window.__perf, CDP Nodes/JSEventListeners) resets
   * to empty, so the very content that caused the hang gets measured as if
   * it never happened. rendererReloads > 0 means the numbers in this file
   * are not trustworthy and `valid` must be false.
   */
  rendererReloads: number
  /**
   * Count of 'render-process-gone' events (renderer crash — e.g. OOM on an
   * unbounded DOM tree). `recoverRenderer()` reacts to this the same as
   * 'unresponsive', but a crash can tear down the CDP session before the
   * reload-guard's `page.on('load')` fires again, so this is tracked
   * separately rather than assumed to be covered by `rendererReloads`.
   */
  crashCount: number
  /**
   * Answers exactly one question: was this run's process contaminated
   * (rendererReloads/crashCount) and did the action itself complete
   * (`status === 'ok'`, where a status applies).
   *
   * It must NOT be downgraded just because one particular metric came back
   * `null` — that is a different failure mode, and conflating them means a
   * single null (e.g. S1's longtask, unmeasurable pre-first-paint) would drop
   * an otherwise-good run's duration/nodes/memory/CPU out of every comparison
   * table. Per-metric measurability lives in `unmeasuredMetrics` and the
   * `null` values themselves; `compare.mjs` already excludes those from %
   * deltas without help from this flag.
   */
  valid: boolean
  /** Which fields came back `null` this run (e.g. `["longtask", "eventLatency"]`) — so a reader can see at a glance what wasn't measured without hunting for nulls field by field. Empty/absent means everything measurable was measured. */
  unmeasuredMetrics?: string[]
  /**
   * Present when the scenario deliberately guards against a hang (e.g. S5
   * CSV extreme), was skipped, or — `'precondition-failed'` — completed
   * without error but its own self-check found it never actually did the
   * thing it claims to measure (e.g. S2 "streamed a long reply" resolving in
   * 1.4s with a near-empty assistant message is a broken completion detector,
   * not a fast AI). "Measured a plausible number" and "actually happened" are
   * different claims, and a scenario must prove the latter before its numbers
   * are allowed into a comparison table.
   */
  status?: 'ok' | 'hung' | 'error' | 'skipped' | 'precondition-failed'
  /**
   * Why the scenario did not run, drawn from a fixed vocabulary the release
   * gate matches against (`ALLOWED_SKIPS` in scripts/perf-gate/thresholds.mjs).
   * Set only when the precondition was detected *before* the scenario acted.
   *
   * It is deliberately not the env var name: an unrecognised value fails the
   * gate, so the two sides have to agree on one vocabulary or the check does
   * not run at all. Never set it on a `precondition-failed` that was decided
   * after the fact — that is the scenario reporting it did not work, and
   * giving it a registered reason is how such a run comes to read as clean.
   * `note` carries the human-facing detail.
   */
  skipReason?: string
  note?: string
  /**
   * Injected centrally by `writeResult`. `'mock'` only when the perf runner
   * started the local SSE mock itself; `'external'` is anything else with a key
   * configured, whose token count and timing vary run to run and so cannot be
   * compared against another run.
   */
  aiSource?: 'mock' | 'external' | 'none'
  /**
   * `os.loadavg()` at write time (1/5/15 min), injected centrally by
   * `writeResult`. A raw number can't be trusted without knowing how busy the
   * machine was — S4 alone swung 8.5s -> 23s max-longtask across two identical
   * runs purely from contention — so every result carries its own reading
   * rather than assuming a quiet machine.
   */
  loadAverage?: number[]
  /** Non-fatal data-quality caveats (e.g. "42/60 idle-CPU ticks failed to sample") — read before trusting a suspiciously clean number. */
  warnings?: string[]
  /** File-preview scenarios (S4/S5/S6): idle CPU after render settles. */
  idleCpu?: { avgPercent: number; maxPercent: number; first15AvgPercent: number; samples: number[]; failedTicks: number; totalTicks: number }
  /** Per-pid breakdown, used when a scenario spans more than one renderer (e.g. S5 pdf's BrowserView). */
  perProcess?: Array<{ pid: number; type: string; cpuAvg: number; cpuMax: number; memAvgMB: number; memMaxMB: number }>
  /**
   * Step-level checkpoints (ms since scenario start) for multi-phase
   * scenarios (e.g. S6's open-preview -> click-input -> fill-text ->
   * click-send -> first-token -> stream-complete). A bare total duration or
   * timeout tells you *that* something is slow, not *which* step is.
   */
  steps?: Array<{ label: string; tMs: number }>
}
