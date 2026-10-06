/**
 * S17 — Chat: a provider that streams small pieces fast, with a long thinking
 * phase: ~3.2K characters of reasoning, then ~20K characters of reply, 16
 * characters per delta, 200 deltas a second.
 *
 * Every delta used to reach the window on its own — an IPC message, a store
 * update and a render each, 200 times a second — and every thinking delta
 * re-derived the whole thought panel. Deltas are now merged where they are
 * produced and published about 33 times a second, and the panel re-derives
 * only the step that changed. Targets from the #229 decision:
 *
 * - `liveUpdates.deltaEvents.maxPerSecond` and `liveUpdates.commits.maxPerSecond`
 *   ≤ 60. These follow the code, not the machine (a slow machine can only merge
 *   more), so one run on a busy machine still says whether merging works.
 * - `longtask.maxMs` < 50. Timing: only meaningful against a baseline run on the
 *   same machine at a comparable load (measurement-practice.md §2), so it is
 *   recorded, not gated.
 *
 * Needs the local SSE mock (run-perf starts it): the prompt asks it for the
 * `burst` preset.
 */

import { test, expect, hasApiKey } from '../fixtures/perf-electron'
import { writeSkipResult } from '../lib/skip-record'
import { runStreamShapeScenario } from '../lib/stream-shape-scenario'
import { burstPrecondition, BURST_PROMPT } from '../lib/burst-stream'

test('S17 stream a small-chunk burst with long thinking', async ({ electronApp, window }, testInfo) => {
  if (!hasApiKey()) {
    writeSkipResult('s17-stream-burst', 'no-api-key', 'Point HALO_TEST_* at tests/perf/mock/sse-server.mjs to run this.')
    testInfo.skip(true, 'HALO_TEST_API_KEY not set (point it at tests/perf/mock/sse-server.mjs)')
    return
  }

  const result = await runStreamShapeScenario(electronApp, window, {
    scenario: 's17-stream-burst',
    prompt: BURST_PROMPT,
    countLiveUpdates: true,
    precondition: async (page, _probe, liveUpdates) => burstPrecondition(page, liveUpdates),
  })

  expect(result.durationMs).toBeGreaterThan(0)
})
