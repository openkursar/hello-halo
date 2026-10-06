/**
 * S13 — Five conversations stream in the background while the user looks at
 * a sixth.
 *
 * Measures what the main window's renderer is sent while background agents
 * work. The window declares only the conversation on screen, so for the five
 * background conversations it must receive status events (turn start,
 * complete, error) and no streaming detail (messages, thoughts, deltas, tool
 * events). Before visibility filtering every token of every conversation was
 * forwarded.
 *
 * The count is taken at the source — every `webContents.send` of the main
 * window is tallied in the main process by (channel, visible|background) — so
 * it is a structural number (message counts), stable across machine load.
 *
 * Validity, in order (measurement-practice.md §1):
 *   1. the collector ran: the send hook reports its own installation;
 *   2. the scenario happened: all five background turns reached
 *      `agent:complete` (status arrives regardless of visibility), and the
 *      visible turn streamed detail;
 *   3. no reload or crash.
 * Only then is `backgroundDetailEvents` meaningful. Target: 0.
 *
 * Needs a model source: point HALO_TEST_* at tests/perf/mock/sse-server.mjs.
 * Writes its own JSON next to the other results (not the S1–S9 PerfResult shape).
 */

import { test, expect, hasApiKey } from '../fixtures/perf-electron'
import { navigateToChat, sendMessage } from '../../e2e/fixtures/helpers'
import { waitForStreamComplete } from '../lib/wait-for-stream-complete'
import { installReloadGuard } from '../lib/reload-guard'
import { installUnresponsiveTracker, readCrashCount } from '../lib/unresponsive'
import { beginScenario, currentLabel, writeResult } from '../lib/result-writer'
import { writeSkipResult } from '../lib/skip-record'
import { getBuildIdentity } from '../lib/build-identity'

const SCENARIO = 's13-background-streams'
const BACKGROUND = 5
const SPACE_ID = 'halo-temp'
const PROMPT =
  'Write a detailed, multi-section explanation of how a hash map works, with a fenced code example. ' +
  'Do not use any tools.'
const STATUS_CHANNELS = ['agent:turn-start', 'agent:complete', 'agent:error', 'agent:ask-question', 'agent:goal-updated']

interface Tally {
  installed: boolean
  byChannel: Record<string, { visible: number; background: number }>
  completedBackground: string[]
}

test('S13 background streams', async ({ electronApp, window }, testInfo) => {
  beginScenario(SCENARIO)
  if (!hasApiKey()) {
    writeSkipResult(SCENARIO, 'no-api-key', 'Point HALO_TEST_* at tests/perf/mock/sse-server.mjs or a real source to run this.')
    testInfo.skip(true, 'HALO_TEST_API_KEY not set')
    return
  }

  await navigateToChat(window)
  await installUnresponsiveTracker(electronApp)
  const reloadGuard = installReloadGuard(window)

  // Background conversations, created through the app's own API.
  const background: string[] = await window.evaluate(async ({ spaceId, count }) => {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const res = await (window as any).halo.createConversation(spaceId, `bg-${i}`)
      if (res?.success && res.data?.id) ids.push(res.data.id)
    }
    return ids
  }, { spaceId: SPACE_ID, count: BACKGROUND })
  expect(background).toHaveLength(BACKGROUND)

  // Tally every send to the main window by channel, split by whether the
  // conversation is one of the background ones.
  await electronApp.evaluate(({ BrowserWindow }, ids) => {
    const set = new Set(ids)
    const tally = { installed: false, byChannel: {} as Record<string, { visible: number; background: number }>, completedBackground: [] as string[] }
    ;(globalThis as any).__s13 = tally
    const main = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().includes('index.html'))
      ?? BrowserWindow.getAllWindows()[0]
    const wc = main.webContents
    const original = wc.send.bind(wc)
    wc.send = (channel: string, ...args: any[]) => {
      const conversationId = args[0]?.conversationId
      if (typeof conversationId === 'string' && (channel.startsWith('agent:') || channel.startsWith('toolsets:'))) {
        const row = tally.byChannel[channel] ??= { visible: 0, background: 0 }
        if (set.has(conversationId)) {
          row.background += 1
          if (channel === 'agent:complete' && !tally.completedBackground.includes(conversationId)) {
            tally.completedBackground.push(conversationId)
          }
        } else {
          row.visible += 1
        }
      }
      return original(channel, ...args)
    }
    tally.installed = true
  }, background)

  const t0 = Date.now()
  // Start the five background turns without opening them.
  await window.evaluate(async ({ spaceId, ids, prompt }) => {
    await Promise.all(ids.map((conversationId: string) =>
      (window as any).halo.sendMessage({ spaceId, conversationId, message: prompt })))
  }, { spaceId: SPACE_ID, ids: background, prompt: PROMPT })

  // And one in the conversation on screen.
  await sendMessage(window, PROMPT)
  await waitForStreamComplete(window, 120000)

  const deadline = Date.now() + 120000
  let tally: Tally = { installed: false, byChannel: {}, completedBackground: [] }
  while (Date.now() < deadline) {
    tally = await electronApp.evaluate(() => (globalThis as any).__s13 as Tally)
    if (tally.completedBackground.length >= BACKGROUND) break
    await new Promise(r => setTimeout(r, 500))
  }
  const durationMs = Date.now() - t0

  const sum = (pick: (row: { visible: number; background: number }, channel: string) => number) =>
    Object.entries(tally.byChannel).reduce((total, [channel, row]) => total + pick(row, channel), 0)
  const isStatus = (channel: string) => STATUS_CHANNELS.includes(channel)
  const backgroundDetailEvents = sum((row, ch) => (isStatus(ch) ? 0 : row.background))
  const backgroundStatusEvents = sum((row, ch) => (isStatus(ch) ? row.background : 0))
  const visibleDetailEvents = sum((row, ch) => (isStatus(ch) ? 0 : row.visible))

  const reloads = reloadGuard.getReloadCount()
  const crashes = await readCrashCount(electronApp).catch(() => 0)
  const problems: string[] = []
  if (!tally.installed) problems.push('send hook never installed')
  if (tally.completedBackground.length < BACKGROUND) problems.push(`only ${tally.completedBackground.length}/${BACKGROUND} background turns completed`)
  if (visibleDetailEvents === 0) problems.push('the visible conversation received no streaming detail — the visible turn did not stream')
  if (reloads > 0 || crashes > 0) problems.push(`contaminated: reloads=${reloads} crashes=${crashes}`)
  const valid = problems.length === 0

  const result = {
    scenario: SCENARIO,
    label: currentLabel(),
    build: getBuildIdentity(),
    loadAverage: (await import('os')).loadavg(),
    durationMs,
    valid,
    problems,
    backgroundConversations: BACKGROUND,
    backgroundDetailEvents,
    backgroundStatusEvents,
    visibleDetailEvents,
    backgroundDetailEventsPerSecond: durationMs > 0 ? backgroundDetailEvents / (durationMs / 1000) : null,
    byChannel: tally.byChannel,
    target: 'backgroundDetailEvents = 0; backgroundStatusEvents ≈ 5 × (turn-start + complete)',
  }
  const resultPath = writeResult(result)
  console.log(`[perf] S13 result written to ${resultPath} (valid=${valid})`)

  expect(valid, problems.join('; ')).toBe(true)
  expect(backgroundDetailEvents).toBe(0)
})
