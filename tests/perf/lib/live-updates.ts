import type { Page } from '@playwright/test'
import type { PerfResult } from '../types'

/**
 * How often the live turn changed while a reply streamed, counted in the page:
 *
 * - streamed deltas the renderer received (reply text and thinking, one IPC
 *   message each — the rate the main process publishes at);
 * - commits that changed the transcript (one MutationObserver delivery per task
 *   that mutated its DOM — the rate the screen actually changed at);
 * - mutation records inside the live thought panel after only reply text was
 *   left streaming, when nothing in the panel had anything new to show.
 *
 * Rates are the busiest one-second window. These counts follow the code, not
 * the machine: a slower machine can only merge more deltas, never fewer.
 */

/** Text deltas this soon after the first one may still meet the thinking step's completion. */
const TEXT_PHASE_SETTLE_MS = 250
const PANEL_POLL_MS = 50

declare global {
  interface Window {
    __liveUpdates?: {
      text: number[]
      thinking: number[]
      commits: number[]
      panel: number[]
      panelFound: boolean
      scrollerFound: boolean
      stop: () => void
    }
  }
}

type DeltaListener = (callback: (data: { delta?: unknown; isToolInput?: boolean }) => void) => () => void

/** Starts counting. Call right before sending the message; read with `readLiveUpdates` once the reply settled. */
export async function installLiveUpdateCounters(page: Page): Promise<void> {
  await page.evaluate(({ pollMs }) => {
    const state = { text: [] as number[], thinking: [] as number[], commits: [] as number[], panel: [] as number[], panelFound: false, scrollerFound: false, stop: () => {} }
    const halo = (window as unknown as { halo: { onAgentMessage: DeltaListener; onAgentThoughtDelta: DeltaListener } }).halo
    const offText = halo.onAgentMessage((data) => { if (typeof data?.delta === 'string') state.text.push(performance.now()) })
    const offThinking = halo.onAgentThoughtDelta((data) => {
      if (typeof data?.delta === 'string' && !data.isToolInput) state.thinking.push(performance.now())
    })

    const commits = new MutationObserver(() => { state.commits.push(performance.now()) })
    const panel = new MutationObserver((records) => {
      const at = performance.now()
      for (let i = 0; i < records.length; i++) state.panel.push(at)
    })
    // Both appear only after the send: the transcript replaces the empty state with the user's
    // message, and the live panel (the only one in a fresh conversation) opens with the first step.
    const poll = window.setInterval(() => {
      const scroller = state.scrollerFound ? null : document.querySelector('[data-testid="transcript-scroller"]')
      if (scroller) {
        state.scrollerFound = true
        commits.observe(scroller, { childList: true, characterData: true, subtree: true })
      }
      const box = state.panelFound ? null : document.querySelector('.thought-content')?.parentElement
      if (box) {
        state.panelFound = true
        panel.observe(box, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] })
      }
      if (state.scrollerFound && state.panelFound) window.clearInterval(poll)
    }, pollMs)

    state.stop = () => {
      offText()
      offThinking()
      commits.disconnect()
      panel.disconnect()
      window.clearInterval(poll)
    }
    window.__liveUpdates = state
  }, { pollMs: PANEL_POLL_MS })
}

function busiestSecond(times: number[]): number {
  let max = 0
  for (let start = 0, end = 0; end < times.length; end++) {
    while (times[end] - times[start] >= 1000) start++
    max = Math.max(max, end - start + 1)
  }
  return max
}

function perSecond(count: number, from: number, to: number): number {
  const span = to - from
  return span > 0 ? Math.round((count / span) * 1000 * 10) / 10 : 0
}

export async function readLiveUpdates(page: Page): Promise<NonNullable<PerfResult['liveUpdates']>> {
  const raw = await page.evaluate(() => {
    const state = window.__liveUpdates
    if (!state) throw new Error('live update counters were never installed')
    state.stop()
    return { text: state.text, thinking: state.thinking, commits: state.commits, panel: state.panel, panelFound: state.panelFound, scrollerFound: state.scrollerFound }
  })
  // No transcript means the commit counter never attached: its zero would read as "no updates".
  if (!raw.scrollerFound) throw new Error('the transcript never appeared, so commits were not counted')

  const deltas = [...raw.text, ...raw.thinking].sort((a, b) => a - b)
  const first = deltas[0] ?? 0
  const last = deltas[deltas.length - 1] ?? 0
  // The streaming window: commits outside it are the send and the settled reply, not the stream.
  const streamingCommits = raw.commits.filter((t) => t >= first && t <= last)
  const textPhaseFrom = (raw.text[0] ?? Infinity) + TEXT_PHASE_SETTLE_MS
  const textPhaseTo = raw.text[raw.text.length - 1] ?? -Infinity

  return {
    deltaEvents: {
      text: raw.text.length,
      thinking: raw.thinking.length,
      maxPerSecond: busiestSecond(deltas),
      avgPerSecond: perSecond(deltas.length, first, last),
    },
    commits: {
      total: streamingCommits.length,
      maxPerSecond: busiestSecond(streamingCommits),
      avgPerSecond: perSecond(streamingCommits.length, first, last),
    },
    panelMutationsWhileText: raw.panelFound
      ? raw.panel.filter((t) => t >= textPhaseFrom && t <= textPhaseTo).length
      : null,
  }
}
