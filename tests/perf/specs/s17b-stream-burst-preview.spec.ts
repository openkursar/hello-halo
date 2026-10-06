/**
 * S17b — S17's burst stream with a ~100-line Markdown preview open beside the
 * chat (#191: the process area kept repainting while a preview was open,
 * though nothing in it was new).
 *
 * `liveUpdates.panelMutationsWhileText` counts what changed in the live thought
 * panel once only reply text was left streaming; the target is 0. It counts DOM
 * changes, so it shows the panel staying still on screen — React work that
 * produced identical output is not visible to it. The S17 targets apply too.
 *
 * Needs the local SSE mock (run-perf starts it) and the generated fixtures.
 */

import { test, expect } from '@playwright/test'
import { getAppEntryPath, createTestConfigDir, cleanupTestConfigDir, launchElectronApp } from '../../e2e/fixtures/electron'
import { seedArtifact, beginOpenObservation, clickArtifactByName, waitForCanvasLoaded } from '../lib/open-artifact'
import { fixturePath } from '../lib/fixture-store'
import { runStreamShapeScenario } from '../lib/stream-shape-scenario'
import { burstPrecondition, BURST_PROMPT } from '../lib/burst-stream'
import { writeSkipResult } from '../lib/skip-record'

const SCENARIO = 's17b-stream-burst-preview'
const PREVIEW_FIXTURE = 'md-typical-5kb.md'

test('S17b stream a small-chunk burst beside an open Markdown preview', async () => {
  if (!process.env.HALO_TEST_API_KEY) {
    writeSkipResult(SCENARIO, 'no-api-key', 'Point HALO_TEST_* at tests/perf/mock/sse-server.mjs to run this.')
    test.skip(true, 'HALO_TEST_API_KEY not set (point it at tests/perf/mock/sse-server.mjs)')
    return
  }

  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const { name: artifactName } = seedArtifact(testConfigDir, fixturePath(PREVIEW_FIXTURE))
  const app = await launchElectronApp(appEntryPath, testConfigDir)

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    let previewOpened = false
    const result = await runStreamShapeScenario(app, window, {
      scenario: SCENARIO,
      prompt: BURST_PROMPT,
      countLiveUpdates: true,
      prepare: async (page) => {
        await beginOpenObservation(page)
        await clickArtifactByName(page, artifactName)
        await waitForCanvasLoaded(page, 60000)
        // The fixture's own heading (tests/perf/fixtures/generate.py gen_markdown), rendered.
        previewOpened = await page.evaluate(() =>
          Array.from(document.querySelectorAll('h1')).some((heading) => heading.textContent?.includes('Perf Fixture Markdown')))
      },
      precondition: async (page, _probe, liveUpdates) => {
        if (!previewOpened) return `The ${PREVIEW_FIXTURE} preview did not render beside the chat — this run measured S17 without a preview.`
        return burstPrecondition(page, liveUpdates)
      },
    })

    expect(result.durationMs).toBeGreaterThan(0)
  } finally {
    await app.close().catch(() => {})
    cleanupTestConfigDir(testConfigDir)
  }
})
