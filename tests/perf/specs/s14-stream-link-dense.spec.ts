/**
 * S14 — Chat: a 20K-character streamed reply dense with links and bold.
 *
 * Streaming preparation (completing unterminated Markdown, splitting into
 * blocks) used to run over the whole reply on every delta, quadratic on
 * link-dense text: ~107 ms per delta at 20K in the audit. It now follows the
 * open tail (`lib/streaming-markdown.ts`), so the longest task while streaming
 * should not grow with the reply. Compare `longtask` against a baseline run on
 * the same machine; node count is the gateable number.
 *
 * Needs the local SSE mock (run-perf starts it): the prompt asks it for the
 * `links` preset.
 */

import { test, expect, hasApiKey } from '../fixtures/perf-electron'
import { writeSkipResult } from '../lib/skip-record'
import { runStreamShapeScenario } from '../lib/stream-shape-scenario'

// Rendered text, not source: link URLs are not text, so the ~20K-character
// preset renders as ~9.5K characters of text around its 288 links.
const MIN_RENDERED_CHARS = 8_000
const MIN_LINKS = 200

test('S14 stream a link-dense 20K reply', async ({ electronApp, window }, testInfo) => {
  if (!hasApiKey()) {
    writeSkipResult('s14-stream-link-dense', 'no-api-key', 'Point HALO_TEST_* at tests/perf/mock/sse-server.mjs to run this.')
    testInfo.skip(true, 'HALO_TEST_API_KEY not set (point it at tests/perf/mock/sse-server.mjs)')
    return
  }

  const result = await runStreamShapeScenario(electronApp, window, {
    scenario: 's14-stream-link-dense',
    prompt: 'Reply with the link report. mock-content:links',
    probes: { streamingLinks: '.message-working a[href]' },
    precondition: async (page, probe) => {
      const shape = await page.evaluate(() => {
        const replies = document.querySelectorAll('.message-assistant:not(.message-working) [data-message-content]')
        const last = replies[replies.length - 1]
        return { chars: last?.textContent?.length ?? 0, links: last?.querySelectorAll('a[href]').length ?? 0 }
      })
      if (shape.chars < MIN_RENDERED_CHARS || shape.links < MIN_LINKS) {
        return `The settled reply has ${shape.chars} chars and ${shape.links} links (need ≥${MIN_RENDERED_CHARS} rendered / ≥${MIN_LINKS}) — the mock did not serve the links preset, so this run did not measure a link-dense stream.`
      }
      if ((probe.streamingLinks ?? 0) < MIN_LINKS / 2) {
        return `Only ${probe.streamingLinks ?? 0} links were ever visible in the live bubble — the stream did not render progressively as a long link-dense reply.`
      }
      return undefined
    },
  })

  expect(result.durationMs).toBeGreaterThan(0)
})
