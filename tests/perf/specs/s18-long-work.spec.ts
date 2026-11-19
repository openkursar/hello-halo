/**
 * S18 — Long work: one reply of 1,000 or 5,000 steps (`LONG_WORK_STEPS`).
 *
 * The deterministic mock (`mock-plan:` mode of tests/perf/mock/sse-server.mjs)
 * drives one real turn through the real engine: Read calls in batches of ten,
 * a sentence before each batch, a task list update every tenth of the way and
 * twenty image reads (PNGs). Read outputs follow the size distribution
 * of real tool outputs (log-normal around a median of ~800 characters, P90
 * ~8 KB, P99 ~50 KB). The images are 0.5–1.5 MB rather than 1–3 MB: twenty
 * images of 1–3 MB stay in the engine's context and push its requests past
 * the local model router's 50 MB request limit, which ends the turn with an
 * error before the plan finishes. Every number is measured inside the app:
 *
 * - memory of the main process and the window while the turn runs, and at its end;
 * - bytes sent to the window on each `agent:*` channel (JSON size of the payload);
 * - the end-of-turn save: the span of the conversation's file operations in the
 *   main process after the mock sent the answer (one synchronous block);
 * - the conversation's files on disk;
 * - after a cold relaunch, the time from clicking the reply's work process to
 *   its last step on screen.
 *
 * The second test continues a conversation that already holds a ~20 MB steps
 * file with a 50-step turn and measures that turn's end-of-turn save.
 *
 * The third runs the same workload as a digital human's chat turn and as an
 * automation run at once and, every 2 s while they run, reads them the way the
 * team workbench (`app:chat-session-state`) and the run detail page
 * (`app:get-session`) do — whole, and with the incremental `since` parameter —
 * recording bytes and round-trip time per read. A build that does not know
 * `since` is read once per poll, whole, as its own readers do.
 *
 * Opt-in (project `perf-long-work`): the 5,000-step arm runs for minutes.
 * Sub-agent tasks are not part of the workload: the mock cannot answer a
 * collaborator's own requests deterministically yet; see the round document.
 */

import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from '@playwright/test'
import { getAppEntryPath, createTestConfigDir, cleanupTestConfigDir, launchElectronApp, hasApiKey } from '../../e2e/fixtures/electron'
import { navigateToChat, sendMessage } from '../../e2e/fixtures/helpers'
import { seedLongConversation } from '../../e2e/fixtures/seed-conversation'
import { CdpMetricsCollector } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { installReloadGuard } from '../lib/reload-guard'
import { writeResult, beginScenario, currentLabel, currentThrottle } from '../lib/result-writer'
import { writeSkipResult } from '../lib/skip-record'
import { getBuildIdentity } from '../lib/build-identity'
import type { PerfResult } from '../types'
import type { TranscriptUpdate } from '../../../src/shared/transcript-update'
import type { TranscriptMessage } from '../../../src/shared/types/transcript'

const STEPS = Number(process.env.LONG_WORK_STEPS || 1000)
const IMAGES = 20
const BATCH = 10
const FINAL = 'All the long work is finished.'
const LAST_FILE = 'last-step.txt'

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Inverse normal CDF (Acklam), for exact log-normal quantiles. */
function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const q = Math.min(Math.max(p, 1e-9), 1 - 1e-9)
  if (q < 0.02425) {
    const r = Math.sqrt(-2 * Math.log(q))
    return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1)
  }
  if (q > 1 - 0.02425) return -normalQuantile(1 - q)
  const r = q - 0.5
  const s = r * r
  return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1)
}

/** Output sizes: log-normal, median 800 characters, σ 1.8, clamped to [40, 200,000]. */
function outputSizes(count: number, next: () => number): number[] {
  const sizes = Array.from({ length: count }, (_, i) => Math.round(Math.min(200_000, Math.max(40, 800 * Math.exp(1.8 * normalQuantile((i + 0.5) / count))))))
  for (let i = sizes.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[sizes[i], sizes[j]] = [sizes[j], sizes[i]]
  }
  return sizes
}

function textOfSize(size: number, seed: number): string {
  const next = random(seed)
  const words = ['state', 'render', 'value', 'config', 'session', 'stream', 'thought', 'output', 'record', 'window']
  let text = ''
  while (text.length < size) {
    let line = ''
    while (line.length < 72) line += `${words[Math.floor(next() * words.length)]} `
    text += `${line.trimEnd()}\n`
  }
  return text.slice(0, size)
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer: Buffer): number {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** An RGB noise PNG of about `bytes` (noise does not compress). */
function noisePng(bytes: number, seed: number): Buffer {
  const width = 800
  const height = Math.max(1, Math.round(bytes / (width * 3 + 1)))
  let state = (seed * 2654435761) >>> 0 || 1
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 1; x <= width * 3; x++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      raw[row + x] = state & 0xff
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

interface Plan {
  batch: number
  calls: Array<{ name: string; arguments: Record<string, unknown> }>
  final: string
}

/** Writes the files the turn reads and the plan the mock follows; returns the plan path and what it contains. */
function preparePlan(root: string, steps: number, images: number, seed: number) {
  const files = path.join(root, 'long-work-files')
  fs.mkdirSync(files, { recursive: true })
  const next = random(seed)
  const reads = steps - images - Math.ceil(steps / (steps / 10))
  const sizes = outputSizes(reads, next)
  const calls: Plan['calls'] = []
  const imageAt = new Set(Array.from({ length: images }, (_, i) => Math.floor(((i + 0.5) * steps) / images)))
  const todoEvery = Math.max(1, Math.floor(steps / 10))
  let read = 0
  let image = 0
  let imageBytes = 0
  for (let index = 0; index < steps; index++) {
    if (index > 0 && index % todoEvery === 0) {
      const done = index / todoEvery
      calls.push({ name: 'TodoWrite', arguments: { todos: Array.from({ length: 10 }, (_, i) => ({ content: `Part ${i + 1} of the long task`, activeForm: `Working on part ${i + 1}`, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' })) } })
      continue
    }
    if (imageAt.has(index) && image < images) {
      const file = path.join(files, `image-${String(image).padStart(2, '0')}.png`)
      const png = noisePng(500_000 + Math.floor(random(seed + image)() * 1_000_000), seed + image)
      fs.writeFileSync(file, png)
      imageBytes += png.length
      image++
      calls.push({ name: 'Read', arguments: { file_path: file } })
      continue
    }
    const isLast = index === steps - 1
    const file = path.join(files, isLast ? LAST_FILE : `t-${String(read).padStart(5, '0')}.txt`)
    fs.writeFileSync(file, textOfSize(sizes[read % sizes.length], seed * 7919 + read))
    read++
    calls.push({ name: 'Read', arguments: { file_path: file } })
  }
  const planPath = path.join(root, 'long-work-plan.json')
  const plan: Plan = { batch: BATCH, calls, final: FINAL }
  fs.writeFileSync(planPath, JSON.stringify(plan))
  const sorted = [...sizes].sort((x, y) => x - y)
  const quantile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return {
    planPath,
    workload: {
      toolCalls: calls.length,
      reads: calls.filter(call => call.name === 'Read').length,
      imageReads: image,
      imageBytes,
      todoUpdates: calls.filter(call => call.name === 'TodoWrite').length,
      textOutputChars: { p50: quantile(0.5), p90: quantile(0.9), p99: quantile(0.99), max: sorted[sorted.length - 1] },
    },
  }
}

/** Counts bytes per `agent:*` channel and times the conversation's file operations, inside the main process. */
async function instrumentMain(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as { __longWork?: unknown }
    if (g.__longWork) return
    const ipc: Record<string, { bytes: number; count: number }> = {}
    const fsOps: Array<{ op: string; path: string; start: number; end: number }> = []
    g.__longWork = { ipc, fsOps }
    const window = BrowserWindow.getAllWindows()[0]
    const contents = window.webContents
    const send = contents.send.bind(contents)
    contents.send = (channel: string, ...args: unknown[]) => {
      if (typeof channel === 'string' && channel.startsWith('agent:')) {
        let bytes = 0
        try { bytes = JSON.stringify(args).length } catch { bytes = -1 }
        const entry = (ipc[channel] ??= { bytes: 0, count: 0 })
        entry.bytes += bytes
        entry.count++
      }
      return send(channel, ...args)
    }
    const nodeFs = (process as unknown as { getBuiltinModule(name: string): typeof import('fs') }).getBuiltinModule('fs')
    for (const op of ['readFileSync', 'writeFileSync', 'renameSync'] as const) {
      const original = nodeFs[op] as (...args: unknown[]) => unknown
      ;(nodeFs as unknown as Record<string, unknown>)[op] = function (this: unknown, ...args: unknown[]) {
        const target = typeof args[0] === 'string' ? args[0] : ''
        if (!target.includes(`${'conversations'}`)) return original.apply(this, args)
        const start = Date.now() + (performance.now() % 1)
        try {
          return original.apply(this, args)
        } finally {
          fsOps.push({ op, path: target, start, end: Date.now() + (performance.now() % 1) })
        }
      }
    }
  })
}

async function readMain(app: ElectronApplication) {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __longWork: { ipc: Record<string, { bytes: number; count: number }>; fsOps: Array<{ op: string; path: string; start: number; end: number }> } }
    const memory = process.memoryUsage()
    return { ipc: g.__longWork.ipc, fsOps: g.__longWork.fsOps, heapUsedMB: memory.heapUsed / 1048576, rssMB: memory.rss / 1048576 }
  })
}

async function mockProgress(planPath: string) {
  const base = process.env.HALO_TEST_API_URL!.replace(/\/+$/, '').replace(/\/v1.*$/, '')
  const response = await fetch(`${base}/__longwork?plan=${encodeURIComponent(planPath)}`)
  return await response.json() as { next: number; total: number; requests: number; batches: number; compactions: number; startedAt: number; finalSentAt: number | null; maxRequestBytes: number } | null
}

/** Waits until the mock sent the answer and the window shows it as a finished reply; fails fast if the turn ends early. */
async function waitForTurn(window: Page, planPath: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let idleSince: number | null = null
  for (;;) {
    const progress = await mockProgress(planPath)
    if (progress?.finalSentAt) break
    if (Date.now() > deadline) throw new Error(`The long turn did not finish within ${timeoutMs} ms (${progress?.next ?? 0}/${progress?.total ?? '?'} steps served)`)
    const working = progress ? await window.locator('.message-working').count() > 0 : true
    idleSince = working ? null : idleSince ?? Date.now()
    if (idleSince !== null && Date.now() - idleSince > 15000) {
      const error = await window.locator('.message-assistant').last().innerText().catch(() => '')
      throw new Error(`The turn ended before the plan finished (${progress?.next ?? 0}/${progress?.total ?? '?'} steps served): ${error.slice(0, 300)}`)
    }
    await window.waitForTimeout(1000)
  }
  await window.waitForFunction((final) => !document.querySelector('.message-working')
    && [...document.querySelectorAll('.message-assistant [data-message-content]')].some(node => node.textContent?.includes(final)), FINAL, { timeout: 120000 })
}

function conversationFiles(testConfigDir: string) {
  const dir = path.join(testConfigDir, '.halo', 'temp', 'conversations')
  const sizeOf = (file: string) => fs.existsSync(file) ? fs.statSync(file).size : 0
  const dirSize = (folder: string) => fs.existsSync(folder) ? fs.readdirSync(folder).reduce((sum, name) => sum + fs.statSync(path.join(folder, name)).size, 0) : 0
  const ids = fs.readdirSync(dir).filter(name => name.endsWith('.json') && !name.endsWith('.thoughts.json') && name !== 'index.json').map(name => name.slice(0, -5))
  return ids.map(id => ({
    id,
    conversationBytes: sizeOf(path.join(dir, `${id}.json`)),
    thoughtsBytes: sizeOf(path.join(dir, `${id}.thoughts.json`)),
    imagesBytes: dirSize(path.join(dir, `${id}.images`)),
    thoughtsPath: path.join(dir, `${id}.thoughts.json`),
  }))
}

/** The span of conversation file work in main after the answer was sent: the synchronous end-of-turn save. */
function saveSpan(fsOps: Array<{ op: string; path: string; start: number; end: number }>, after: number, conversationId: string) {
  const ops = fsOps.filter(op => op.start >= after && op.path.includes(conversationId))
  if (!ops.length) return null
  const start = Math.min(...ops.map(op => op.start))
  const end = Math.max(...ops.map(op => op.end))
  const writes = ops.filter(op => op.op !== 'readFileSync')
  return { spanMs: end - start, ops: ops.length, writes: writes.length, ioMs: ops.reduce((sum, op) => sum + (op.end - op.start), 0) }
}

/** The folded line of a reply's work: "Work process" in the current view, "Already thought" in the one before it. */
const WORK_HEADER = /^(Work process|Already thought)/

/**
 * Opens the reply's work process: milliseconds from the click until it shows
 * what it opens to. The view before the folded timeline showed every step, so
 * there it waits for the last step's file; the folded timeline shows one line
 * per stretch, so it waits for the first of those.
 */
async function expandTime(window: Page): Promise<{ ms: number | null; view: 'timeline' | 'every-step' }> {
  const button = window.getByRole('button', { name: WORK_HEADER }).last()
  await button.waitFor({ state: 'visible', timeout: 60000 })
  const handle = await button.elementHandle()
  if (!handle) return { ms: null, view: 'timeline' }
  return window.evaluate(async ({ element, marker }) => {
    const header = element as HTMLElement
    const row = header.closest('[data-transcript-index]') ?? document.body
    const everyStep = /^Already thought/.test(header.textContent ?? '')
    const start = performance.now()
    header.click()
    const ms = await new Promise<number | null>((resolve) => {
      const limit = start + 120000
      const check = () => {
        const shown = everyStep
          ? (row as HTMLElement).innerText.includes(marker)
          : Array.from(row.querySelectorAll('button[aria-expanded]')).some(candidate => candidate !== header)
        if (shown) resolve(performance.now() - start)
        else if (performance.now() > limit) resolve(null)
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    })
    return { ms, view: everyStep ? 'every-step' as const : 'timeline' as const }
  }, { element: handle, marker: LAST_FILE })
}

/** Opens the first stretch of the open work process: milliseconds until its steps are drawn; null where there is none to open. */
async function openFirstStretch(window: Page): Promise<number | null> {
  const row = window.locator('[data-transcript-index]').filter({ has: window.getByRole('button', { name: WORK_HEADER }) }).last()
  const stretch = row.locator('button[aria-expanded="false"]').first()
  if (!await stretch.count()) return null
  const handle = await stretch.elementHandle()
  if (!handle) return null
  return window.evaluate(async (element) => {
    const stretchLine = element as HTMLElement
    const container = stretchLine.parentElement as HTMLElement
    const start = performance.now()
    stretchLine.click()
    return await new Promise<number | null>((resolve) => {
      const limit = start + 60000
      const check = () => {
        if (stretchLine.getAttribute('aria-expanded') === 'true' && container.querySelectorAll('button').length > 1) resolve(performance.now() - start)
        else if (performance.now() > limit) resolve(null)
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    })
  }, handle)
}

/** Page size after a forced collection, so garbage not yet collected does not read as held memory. */
async function settledView(cdp: CdpMetricsCollector) {
  await cdp.collectGarbage()
  const { heapMB, nodes, listeners } = await cdp.snapshot()
  return { heapMB, nodes, listeners }
}

/** The app's own logs of a failed arm, kept beside the test output before the profile is removed. */
function keepAppLogs(testConfigDir: string, testInfo: { outputPath(...parts: string[]): string }) {
  const logs = path.join(testConfigDir, '.halo', 'logs')
  if (!fs.existsSync(logs)) return
  const target = testInfo.outputPath('app-logs')
  fs.mkdirSync(target, { recursive: true })
  for (const name of fs.readdirSync(logs)) fs.copyFileSync(path.join(logs, name), path.join(target, name))
  console.log(`[perf] app logs kept in ${target}`)
}

function writeFailure(scenario: string, failures: string[], extra: Record<string, unknown>) {
  console.log(`[perf] ${scenario} failures: ${failures.join(' | ')}`)
  return extra
}

test.describe.configure({ mode: 'serial' })

test(`S18 long work (${STEPS} steps)`, async ({}, testInfo) => {
  const scenario = `s18-long-work-${STEPS}`
  beginScenario(scenario)
  if (!hasApiKey()) {
    writeSkipResult(scenario, 'no-api-key', 'Run through scripts/run-perf.mjs so the local mock drives the turn.')
    testInfo.skip(true, 'HALO_TEST_API_KEY not set')
    return
  }
  test.setTimeout(STEPS >= 5000 ? 3_600_000 : 1_200_000)
  const failures: string[] = []
  const warnings: string[] = []
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const { planPath, workload } = preparePlan(testConfigDir, STEPS, IMAGES, 18)
  const steps: Array<{ label: string; tMs: number }> = []
  let app = await launchElectronApp(appEntryPath, testConfigDir)
  const t0 = Date.now()
  try {
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await navigateToChat(window)
    await installUnresponsiveTracker(app)
    const reloadGuard = installReloadGuard(window)
    const cdp = new CdpMetricsCollector(window)
    await cdp.connect()
    const throttle = currentThrottle()
    await cdp.setCpuThrottlingRate(throttle)
    await instrumentMain(app)
    const heapStart = await cdp.snapshot()
    const mainStart = await readMain(app)
    const sampler = new ProcessMetricsSampler(app)
    sampler.start()

    await sendMessage(window, `Please work through the long task. mock-content:longwork mock-plan:${planPath}`)
    steps.push({ label: 'sent', tMs: Date.now() - t0 })
    await waitForTurn(window, planPath, STEPS >= 5000 ? 3_000_000 : 900_000)
    steps.push({ label: 'turn-finished', tMs: Date.now() - t0 })
    sampler.stop()
    await window.waitForTimeout(1500)
    const progress = await mockProgress(planPath)
    const heapEnd = await cdp.snapshot()
    const mainEnd = await readMain(app)
    const { cpu, mem } = sampler.summarize()
    const files = conversationFiles(testConfigDir)
    const conversation = files.sort((a, b) => b.thoughtsBytes - a.thoughtsBytes)[0]
    const save = conversation && progress?.finalSentAt ? saveSpan(mainEnd.fsOps, progress.finalSentAt, conversation.id) : null
    let savedSteps = 0
    if (conversation && fs.existsSync(conversation.thoughtsPath)) {
      const thoughtsFile = JSON.parse(fs.readFileSync(conversation.thoughtsPath, 'utf8')) as { messages: Record<string, unknown[]> }
      savedSteps = Math.max(0, ...Object.values(thoughtsFile.messages).map(list => list.length))
    }
    if (!progress || progress.next !== progress.total) failures.push(`The mock served ${progress?.next ?? 0} of ${workload.toolCalls} tool calls.`)
    if (savedSteps < workload.toolCalls) failures.push(`The saved reply has ${savedSteps} steps, fewer than the ${workload.toolCalls} tool calls served.`)
    if (!save) failures.push('No end-of-turn save was observed in the main process.')
    const rendererReloads = reloadGuard.getReloadCount()
    const crashCount = await readCrashCount(app).catch(() => 0)
    const unresponsiveCount = await readUnresponsiveCount(app)

    // The turn's own view, folded as it ends; then the work opened with one stretch
    // open. Last, so what opening reads from disk is not counted in the end-of-turn
    // save or the bytes above.
    const liveFolded = await settledView(cdp)
    const liveExpand = await expandTime(window)
    const liveStretchMs = await openFirstStretch(window)
    const liveExpanded = await settledView(cdp)

    await app.close()
    steps.push({ label: 'closed', tMs: Date.now() - t0 })
    app = await launchElectronApp(appEntryPath, testConfigDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await navigateToChat(window)
    const reopenCdp = new CdpMetricsCollector(window)
    await reopenCdp.connect()
    const reopenedHeap = await reopenCdp.snapshot()
    const reopenedFolded = await settledView(reopenCdp)
    const { ms: expandMs, view: workView } = await expandTime(window)
    const expandedHeap = await reopenCdp.snapshot()
    const stretchMs = await openFirstStretch(window)
    const reopenedExpanded = await settledView(reopenCdp)
    if (expandMs === null) failures.push(`After relaunch the reply's work process did not open within 120 s.`)
    steps.push({ label: 'expanded', tMs: Date.now() - t0 })

    const status: PerfResult['status'] = failures.length ? 'precondition-failed' : 'ok'
    const valid = rendererReloads === 0 && crashCount === 0 && status === 'ok'
    const ipcTotal = Object.values(mainEnd.ipc).reduce((sum, entry) => sum + entry.bytes, 0)
    const result: PerfResult & Record<string, unknown> = {
      scenario,
      label: currentLabel(),
      build: getBuildIdentity(),
      throttle,
      durationMs: (progress?.finalSentAt ?? Date.now()) - (progress?.startedAt ?? t0),
      cpu,
      mem,
      sampling: sampler.getSamplingStats(),
      longtask: null,
      eventLatency: null,
      heap: { startMB: heapStart.heapMB, endMB: heapEnd.heapMB, deltaMB: heapEnd.heapMB - heapStart.heapMB },
      nodes: { start: heapStart.nodes, end: heapEnd.nodes, delta: heapEnd.nodes - heapStart.nodes },
      listeners: { start: heapStart.listeners, end: heapEnd.listeners, delta: heapEnd.listeners - heapStart.listeners },
      unresponsiveCount,
      rendererReloads,
      crashCount,
      valid,
      status,
      unmeasuredMetrics: ['longtask', 'eventLatency'],
      note: failures.join(' '),
      warnings: warnings.length ? warnings : undefined,
      steps,
      longWork: {
        requestedSteps: STEPS,
        workload,
        savedSteps,
        mock: progress,
        main: { heapStartMB: mainStart.heapUsedMB, heapEndMB: mainEnd.heapUsedMB, rssStartMB: mainStart.rssMB, rssEndMB: mainEnd.rssMB },
        ipcBytes: { total: ipcTotal, byChannel: mainEnd.ipc },
        endOfTurnSave: save,
        files: conversation ? { conversationBytes: conversation.conversationBytes, thoughtsBytes: conversation.thoughtsBytes, imagesBytes: conversation.imagesBytes } : null,
        reopen: { heapAfterOpenMB: reopenedHeap.heapMB, heapAfterExpandMB: expandedHeap.heapMB, expandMs, cold: true },
        // Page size after a forced collection, in the two states of the work process.
        workView: {
          view: workView,
          liveEnd: { folded: liveFolded, expanded: liveExpanded, expandMs: liveExpand.ms, openStretchMs: liveStretchMs },
          reopened: { folded: reopenedFolded, expanded: reopenedExpanded, expandMs, openStretchMs: stretchMs },
        },
      },
    }
    const filePath = writeResult(result)
    console.log(`[perf] ${scenario} result written to ${filePath}`)
    writeFailure(scenario, failures, {})
    expect(failures, failures.join('\n')).toEqual([])
    expect(valid).toBe(true)
  } catch (error) {
    keepAppLogs(testConfigDir, testInfo)
    throw error
  } finally {
    await app.close().catch(() => {})
    cleanupTestConfigDir(testConfigDir)
  }
})

test('S18 end-of-turn save with a 20 MB steps file', async ({}, testInfo) => {
  const scenario = 's18-long-work-save-20mb'
  beginScenario(scenario)
  if (!hasApiKey()) {
    writeSkipResult(scenario, 'no-api-key', 'Run through scripts/run-perf.mjs so the local mock drives the turn.')
    testInfo.skip(true, 'HALO_TEST_API_KEY not set')
    return
  }
  test.setTimeout(600_000)
  const failures: string[] = []
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const seeded = seedLongConversation(testConfigDir, { messageCount: 2, title: 'S18 existing work' })
  const dir = path.join(testConfigDir, '.halo', 'temp', 'conversations')
  const mainPath = path.join(dir, `${seeded.conversationId}.json`)
  const conversation = JSON.parse(fs.readFileSync(mainPath, 'utf8')) as { messages: Array<Record<string, unknown>> }
  const replyId = seeded.messageIds[1]
  const thoughts = Array.from({ length: 2000 }, (_, i) => ({
    id: `seed-${i}`, type: 'tool_use', content: '', timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    toolName: 'Read', toolInput: { file_path: `/seed/file-${i}.txt` },
    toolResult: { output: textOfSize(10_000, i), isError: false, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() },
  }))
  const reply = conversation.messages.find(message => message.id === replyId)!
  reply.thoughts = null
  reply.thoughtsSummary = { count: thoughts.length, types: { tool_use: thoughts.length }, duration: 2000 }
  fs.writeFileSync(path.join(dir, `${seeded.conversationId}.thoughts.json`), JSON.stringify({ version: 1, conversationId: seeded.conversationId, messages: { [replyId]: thoughts } }))
  fs.writeFileSync(mainPath, JSON.stringify(conversation, null, 2))
  const seededThoughtsBytes = fs.statSync(path.join(dir, `${seeded.conversationId}.thoughts.json`)).size
  const { planPath, workload } = preparePlan(testConfigDir, 50, 0, 1820)
  const app = await launchElectronApp(appEntryPath, testConfigDir)
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await navigateToChat(window)
    await window.getByText('S18 existing work').first().click().catch(() => {})
    await instrumentMain(app)
    await sendMessage(window, `Continue with a short task. mock-content:longwork mock-plan:${planPath}`)
    await waitForTurn(window, planPath, 300_000)
    await window.waitForTimeout(1500)
    const progress = await mockProgress(planPath)
    const mainEnd = await readMain(app)
    const save = progress?.finalSentAt ? saveSpan(mainEnd.fsOps, progress.finalSentAt, seeded.conversationId) : null
    const files = conversationFiles(testConfigDir).find(file => file.id === seeded.conversationId)
    if (!save) failures.push('No end-of-turn save was observed for the seeded conversation (the turn may have gone to another conversation).')
    if (seededThoughtsBytes < 19_000_000) failures.push(`The seeded steps file is ${seededThoughtsBytes} bytes, not ~20 MB.`)
    const rendererReloads = 0
    const crashCount = await readCrashCount(app).catch(() => 0)
    const status: PerfResult['status'] = failures.length ? 'precondition-failed' : 'ok'
    const result: Record<string, unknown> = {
      scenario,
      label: currentLabel(),
      build: getBuildIdentity(),
      throttle: currentThrottle(),
      durationMs: (progress?.finalSentAt ?? 0) - (progress?.startedAt ?? 0),
      rendererReloads,
      crashCount,
      valid: crashCount === 0 && status === 'ok',
      status,
      note: failures.join(' '),
      longWork: { seededThoughtsBytes, workload, mock: progress, endOfTurnSave: save, files: files ? { conversationBytes: files.conversationBytes, thoughtsBytes: files.thoughtsBytes, imagesBytes: files.imagesBytes } : null },
    }
    writeResult(result as unknown as PerfResult)
    expect(failures, failures.join('\n')).toEqual([])
  } catch (error) {
    keepAppLogs(testConfigDir, testInfo)
    throw error
  } finally {
    await app.close().catch(() => {})
    cleanupTestConfigDir(testConfigDir)
  }
})

interface PollSample { bytes: number; ms: number }

function pollSummary(samples: PollSample[]) {
  if (!samples.length) return null
  const sorted = (values: number[]) => [...values].sort((a, b) => a - b)
  const bytes = sorted(samples.map(sample => sample.bytes))
  const ms = sorted(samples.map(sample => sample.ms))
  const at = (values: number[], p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))]
  return { polls: samples.length, bytes: { median: at(bytes, 0.5), p90: at(bytes, 0.9), max: bytes[bytes.length - 1], total: bytes.reduce((a, b) => a + b, 0) }, ms: { median: at(ms, 0.5), p90: at(ms, 0.9), max: ms[ms.length - 1] } }
}

type Halo = Record<string, (...args: unknown[]) => Promise<{ success: boolean; data?: unknown; error?: string }>>

test(`S18 polling a long digital-human turn and run (${STEPS} steps)`, async ({}, testInfo) => {
  const scenario = `s18-long-work-polling-${STEPS}`
  beginScenario(scenario)
  if (!hasApiKey()) {
    writeSkipResult(scenario, 'no-api-key', 'Run through scripts/run-perf.mjs so the local mock drives the turn.')
    testInfo.skip(true, 'HALO_TEST_API_KEY not set')
    return
  }
  test.setTimeout(STEPS >= 5000 ? 3_600_000 : 1_500_000)
  const failures: string[] = []
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const chatPlan = preparePlan(path.join(testConfigDir, 'chat'), STEPS, IMAGES, 1801)
  const runPlan = preparePlan(path.join(testConfigDir, 'run'), STEPS, IMAGES, 1802)
  // The run's last step is its report, which ends an automation run.
  const runPlanFile = JSON.parse(fs.readFileSync(runPlan.planPath, 'utf8')) as Plan
  runPlanFile.calls.push({ name: 'mcp__halo-report__report_to_user', arguments: { type: 'run_complete', message: 'The long run is finished.' } })
  fs.writeFileSync(runPlan.planPath, JSON.stringify(runPlanFile))
  // A build without incremental reads has no shared module; its reads are all whole.
  const shared = await import('../../../src/shared/transcript-update').catch(() => null)
  const app = await launchElectronApp(appEntryPath, testConfigDir)
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await navigateToChat(window)
    await expect.poll(() => window.evaluate(() => (window as unknown as { halo: Halo }).halo.appList({ type: 'automation' }).then(result => result.success))).toBe(true)
    const install = (name: string, prompt: string) => window.evaluate(({ name, prompt }) => (window as unknown as { halo: Halo }).halo.appInstall({
      spaceId: 'halo-temp',
      spec: { spec_version: '1.0', version: '1.0.0', name, author: 'perf', type: 'automation', description: 'Long work', system_prompt: prompt, subscriptions: [], requires: {}, config_schema: [], permissions: [] },
    }), { name, prompt })
    const chatApp = await install('Long chat worker', 'Do the work you are asked to do.')
    const runApp = await install('Long run worker', `Work through the long task. mock-content:longwork mock-plan:${runPlan.planPath}`)
    if (!chatApp.success || !runApp.success) throw new Error(`Could not install the digital humans: ${chatApp.error ?? runApp.error}`)
    const chatAppId = (chatApp.data as { appId: string }).appId
    const runAppId = (runApp.data as { appId: string }).appId
    // Both calls answer when their work has finished, so they are started
    // without waiting; the default chat of a digital human is `app-chat:<id>`.
    const conversationId = `app-chat:${chatAppId}`
    await window.evaluate(({ chatAppId, runAppId, message }) => {
      const halo = (window as unknown as { halo: Halo }).halo
      const started: Record<string, unknown> = {}
      ;(window as unknown as { __s18Started: Record<string, unknown> }).__s18Started = started
      void halo.appChatSend({ appId: chatAppId, spaceId: 'halo-temp', message }).then(result => { started.chat = result })
      void halo.appTrigger(runAppId).then(result => { started.run = result })
    }, { chatAppId, runAppId, message: `Please work through the long task. mock-content:longwork mock-plan:${chatPlan.planPath}` })

    // The readers run in the window, as the workbench and the run detail page
    // do: every 2 s, a whole read and an incremental one of each, timed there.
    // The window keeps only the workbench's current steps, as the workbench
    // does; a run update goes back to the test, which applies it to its copy.
    await window.evaluate(() => {
      (window as unknown as { __s18: unknown }).__s18 = {
        samples: { stateFull: [], stateDelta: [], sessionFull: [], sessionDelta: [] },
        revision: '', held: [], stateMismatches: 0, stateCompared: 0, chatSeen: false, runId: null, cursor: '',
      }
    })
    const pollOnce = () => window.evaluate(async ({ chatAppId, conversationId, runAppId, incremental }) => {
      type Sample = { bytes: number; ms: number }
      const st = (window as unknown as { __s18: {
        samples: { stateFull: Sample[]; stateDelta: Sample[]; sessionFull: Sample[]; sessionDelta: Sample[] }
        revision: string; held: Array<{ id: string }>; stateMismatches: number; stateCompared: number; chatSeen: boolean; runId: string | null; cursor: string
      } }).__s18
      const halo = (window as unknown as { halo: Halo }).halo
      let runUpdate: unknown = null
      const timed = async (call: () => Promise<{ success: boolean; data?: unknown }>) => {
        const start = performance.now()
        const value = await call()
        return { value, ms: performance.now() - start, bytes: JSON.stringify(value).length }
      }
      // A build without incremental reads answers both the same; read it once, as its workbench does.
      const delta = await timed(() => halo.appChatSessionState(chatAppId, conversationId, st.revision))
      const full = incremental ? await timed(() => halo.appChatSessionState(chatAppId, conversationId)) : delta
      const read = delta.value.data as { isActive: boolean; thoughts: Array<{ id: string }>; thoughtsRevision?: string; thoughtsDelta?: { total: number; at: number[] } } | undefined
      const whole = full.value.data as { isActive: boolean; thoughts: Array<{ id: string }> } | undefined
      if (read?.isActive && whole?.isActive && read.thoughts.length + whole.thoughts.length > 0) {
        st.chatSeen = true
        st.samples.stateDelta.push({ bytes: delta.bytes, ms: delta.ms })
        st.samples.stateFull.push({ bytes: full.bytes, ms: full.ms })
        if (read.thoughtsDelta) {
          const next = st.held.slice(0, read.thoughtsDelta.total)
          read.thoughtsDelta.at.forEach((at, index) => { next[at] = read.thoughts[index] })
          st.held = next
        } else {
          st.held = read.thoughts
        }
        st.revision = read.thoughtsRevision ?? ''
        // The whole read came after: it holds at least what was placed, in the same
        // order. Steps older than the newest few no longer change, so those must
        // match in full; the newest may have moved on between the two reads.
        const shorter = Math.min(st.held.length, whole.thoughts.length)
        const settled = shorter - 5
        if (st.held.length > whole.thoughts.length) st.stateMismatches++
        for (let index = 0; index < shorter; index++) {
          const same = index < settled
            ? JSON.stringify(st.held[index]) === JSON.stringify(whole.thoughts[index])
            : st.held[index]?.id === whole.thoughts[index].id
          if (index < settled) st.stateCompared++
          if (!same) { st.stateMismatches++; st.revision = ''; break }
        }
      }
      const runs = await halo.appGetRuns({ appId: runAppId, options: { limit: 5 } })
      const list = (runs.data ?? []) as Array<{ runId: string; status: string }>
      st.runId ??= list[0]?.runId ?? null
      const runStatus = list.find(run => run.runId === st.runId)?.status ?? null
      if (st.runId) {
        const runId = st.runId
        const sessionDelta = await timed(() => halo.appGetSession({ appId: runAppId, runId, since: st.cursor }))
        const sessionFull = incremental ? await timed(() => halo.appGetSession({ appId: runAppId, runId })) : sessionDelta
        if (runStatus === 'running') {
          st.samples.sessionDelta.push({ bytes: sessionDelta.bytes, ms: sessionDelta.ms })
          st.samples.sessionFull.push({ bytes: sessionFull.bytes, ms: sessionFull.ms })
        }
        const data = sessionDelta.value.data as { cursor?: string } | unknown[] | undefined
        st.cursor = Array.isArray(data) ? '' : data?.cursor ?? ''
        // A build without incremental reads has nothing to check here.
        if (incremental) runUpdate = data ?? null
      }
      return { chatActive: !!read?.isActive, chatSeen: st.chatSeen, runId: st.runId, runStatus, statePolls: st.samples.stateFull.length, runPolls: st.samples.sessionFull.length, ms: { stateDelta: delta.ms, stateFull: full.ms }, runUpdate }
    }, { chatAppId, conversationId, runAppId, incremental: !!shared })

    const t0Poll = Date.now()
    const deadline = Date.now() + (STEPS >= 5000 ? 3_000_000 : 1_200_000)
    let last: Awaited<ReturnType<typeof pollOnce>> | null = null
    const trace: Array<Record<string, unknown>> = []
    // The run transcript as the run detail page holds it, rebuilt from its updates.
    let runHeld: TranscriptMessage[] = []
    let runFits = true
    for (;;) {
      const pollStart = Date.now()
      last = await pollOnce()
      const { runUpdate, ...numbers } = last
      if (shared && runUpdate) {
        const applied = Array.isArray(runUpdate) ? runUpdate as TranscriptMessage[] : shared.applyTranscriptUpdate(runHeld, runUpdate as TranscriptUpdate)
        if (applied) runHeld = applied
        else runFits = false
      }
      trace.push({ at: pollStart - t0Poll, took: Date.now() - pollStart, ...numbers })
      const chatMock = await mockProgress(chatPlan.planPath)
      const runMock = await mockProgress(runPlan.planPath)
      if (chatMock?.finalSentAt && runMock?.finalSentAt && !last.chatActive && last.runStatus && last.runStatus !== 'running') break
      if (Date.now() > deadline) {
        failures.push(`Polling stopped at the deadline: ${JSON.stringify(last)}.`)
        break
      }
      await window.waitForTimeout(2000)
    }
    const polled = await window.evaluate(async ({ runAppId }) => {
      const st = (window as unknown as { __s18: { samples: unknown; stateMismatches: number; stateCompared: number; held: unknown[]; runId: string | null } }).__s18
      const started = (window as unknown as { __s18Started: { chat?: { success: boolean; error?: string }; run?: { success: boolean; error?: string } } }).__s18Started
      const halo = (window as unknown as { halo: Halo }).halo
      const finalWhole = st.runId ? (await halo.appGetSession({ appId: runAppId, runId: st.runId })).data : null
      return { samples: st.samples as Record<'stateFull' | 'stateDelta' | 'sessionFull' | 'sessionDelta', PollSample[]>, stateMismatches: st.stateMismatches, stateCompared: st.stateCompared, heldThoughts: st.held.length, runId: st.runId, finalWhole, started }
    }, { runAppId })
    if (polled.started.chat && !polled.started.chat.success) failures.push(`The chat turn failed: ${polled.started.chat.error}`)
    if (polled.started.run && !polled.started.run.success) failures.push(`The run failed: ${polled.started.run.error}`)

    // Every run update applied in order must give what a whole read gives now.
    let runMatches: boolean | null = null
    if (shared && polled.runId) {
      runMatches = runFits && JSON.stringify(runHeld) === JSON.stringify(polled.finalWhole)
      if (!runMatches) failures.push('The run transcript built from its updates differs from a whole read.')
    }
    if (polled.samples.stateFull.length < 3) failures.push(`Only ${polled.samples.stateFull.length} polls saw the chat turn running.`)
    if (polled.samples.sessionFull.length < 3) failures.push(`Only ${polled.samples.sessionFull.length} polls read the run.`)
    if (polled.stateMismatches) failures.push(`${polled.stateMismatches} incremental session-state reads did not line up with the whole read.`)
    if (shared && polled.stateCompared === 0) failures.push('No settled workbench step was compared in full.')
    const crashCount = await readCrashCount(app).catch(() => 0)
    const chatMock = await mockProgress(chatPlan.planPath)
    const runMock = await mockProgress(runPlan.planPath)
    if (chatMock?.next !== chatMock?.total || runMock?.next !== runMock?.total) failures.push('The mock did not serve the whole plan of both turns.')
    const status: PerfResult['status'] = failures.length ? 'precondition-failed' : 'ok'
    const result: Record<string, unknown> = {
      scenario,
      label: currentLabel(),
      build: getBuildIdentity(),
      throttle: currentThrottle(),
      durationMs: Math.max(chatMock?.finalSentAt ?? 0, runMock?.finalSentAt ?? 0) - Math.min(chatMock?.startedAt ?? 0, runMock?.startedAt ?? 0),
      rendererReloads: 0,
      crashCount,
      valid: crashCount === 0 && status === 'ok',
      status,
      note: failures.join(' '),
      polling: {
        requestedSteps: STEPS,
        incrementalReads: !!shared,
        heldThoughtsAtLastPoll: polled.heldThoughts,
        settledStepsComparedInFull: polled.stateCompared,
        runMatchesWholeRead: runMatches,
        workbench: { full: pollSummary(polled.samples.stateFull), incremental: pollSummary(polled.samples.stateDelta) },
        runDetail: { full: pollSummary(polled.samples.sessionFull), incremental: pollSummary(polled.samples.sessionDelta) },
        mock: { chat: chatMock, run: runMock },
        trace: trace.slice(0, 200),
      },
    }
    writeResult(result as unknown as PerfResult)
    expect(failures, failures.join('\n')).toEqual([])
  } catch (error) {
    keepAppLogs(testConfigDir, testInfo)
    throw error
  } finally {
    await app.close().catch(() => {})
    cleanupTestConfigDir(testConfigDir)
  }
})
