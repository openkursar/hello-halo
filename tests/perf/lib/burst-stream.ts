import type { Page } from '@playwright/test'
import type { PerfResult } from '../types'

/** Asks the SSE mock for its `burst` preset: long reasoning, then ~20K characters in 16-character deltas, 200 a second. */
export const BURST_PROMPT = 'Write the burst report. mock-content:burst'

/** The reply renders as ~19K characters once Markdown markers are gone. */
const MIN_RENDERED_CHARS = 15_000
/** ~200 reasoning deltas; even merged at 30 ms they arrive as more than a handful of events. */
const MIN_THINKING_EVENTS = 5

/** Whether the settled reply and the live counters show the burst actually streamed: thinking first, then the long reply. */
export async function burstPrecondition(page: Page, liveUpdates: PerfResult['liveUpdates'] | null): Promise<string | undefined> {
  const chars = await page.evaluate(() => {
    const replies = document.querySelectorAll('.message-assistant:not(.message-working) [data-message-content]')
    return replies[replies.length - 1]?.textContent?.length ?? 0
  })
  if (chars < MIN_RENDERED_CHARS) {
    return `The settled reply has ${chars} rendered chars (need ≥${MIN_RENDERED_CHARS}) — the mock did not serve the burst preset, so this run did not measure a long small-chunk stream.`
  }
  if (!liveUpdates) return undefined
  if (liveUpdates.deltaEvents.thinking < MIN_THINKING_EVENTS) {
    return `Only ${liveUpdates.deltaEvents.thinking} thinking deltas reached the window (need ≥${MIN_THINKING_EVENTS}) — the reasoning phase did not stream as thinking, so the thought panel was not exercised.`
  }
  if (liveUpdates.panelMutationsWhileText === null) {
    return 'The live thought panel never appeared — the reasoning phase was not shown as a thinking step.'
  }
  return undefined
}
