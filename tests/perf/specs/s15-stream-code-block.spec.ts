/**
 * S15 — Chat: a streamed reply that is one 150-line code block.
 *
 * A streaming code block used to be re-highlighted in full on every delta, and
 * every intermediate prefix's tokens were kept in an unbounded module cache
 * (9.5 s of main thread and 80 MB retained for 120 lines in the audit). Now
 * streaming code renders monochrome and the finished message highlights once
 * (`MarkdownRenderer`, `lib/shiki-code-plugin.ts`). Asserted here: no
 * highlighted token ever appears in the live bubble, and the settled message
 * is highlighted. Heap delta and longtask are compared against a baseline run.
 *
 * Needs the local SSE mock (run-perf starts it): the prompt asks it for the
 * `code150` preset.
 */

import { test, expect, hasApiKey } from '../fixtures/perf-electron'
import { writeSkipResult } from '../lib/skip-record'
import { runStreamShapeScenario } from '../lib/stream-shape-scenario'

const MIN_CODE_LINES = 150

test('S15 stream a 150-line code block', async ({ electronApp, window }, testInfo) => {
  if (!hasApiKey()) {
    writeSkipResult('s15-stream-code-block', 'no-api-key', 'Point HALO_TEST_* at tests/perf/mock/sse-server.mjs to run this.')
    testInfo.skip(true, 'HALO_TEST_API_KEY not set (point it at tests/perf/mock/sse-server.mjs)')
    return
  }

  const result = await runStreamShapeScenario(electronApp, window, {
    scenario: 's15-stream-code-block',
    prompt: 'Reply with the module. mock-content:code150',
    probes: {
      streamingCodeLines: '.message-working [data-streamdown="code-block-body"] code > span',
      streamingHighlightedTokens: '.message-working [data-streamdown="code-block-body"] span[style*="--shiki-dark"]',
    },
    precondition: async (page, probe) => {
      const settled = await page.evaluate(() => {
        const blocks = document.querySelectorAll('.message-assistant:not(.message-working) [data-streamdown="code-block-body"]')
        const last = blocks[blocks.length - 1]
        return {
          lines: last?.querySelectorAll('code > span').length ?? 0,
          highlighted: last?.querySelectorAll('span[style*="--shiki-dark"]').length ?? 0,
        }
      })
      if (settled.lines < MIN_CODE_LINES) {
        return `The settled code block has ${settled.lines} lines (need ≥${MIN_CODE_LINES}) — the mock did not serve the code150 preset.`
      }
      if ((probe.streamingCodeLines ?? 0) < MIN_CODE_LINES / 2) {
        return `The live bubble never showed more than ${probe.streamingCodeLines ?? 0} code lines — the block did not stream progressively.`
      }
      if ((probe.streamingHighlightedTokens ?? 0) > 0) {
        return `${probe.streamingHighlightedTokens} highlighted tokens appeared while streaming — streaming code must stay monochrome.`
      }
      if (settled.highlighted === 0) {
        return 'The settled code block has no highlighted tokens — the finished message was not highlighted.'
      }
      return undefined
    },
  })

  expect(result.durationMs).toBeGreaterThan(0)
})
