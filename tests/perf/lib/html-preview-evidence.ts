import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import type { CDPSession, ElectronApplication, Frame, Page } from '@playwright/test'
import type { HtmlPreviewEvidence, PerfResult } from '../types'
import { resultPath } from './result-writer'

const { PNG } = createRequire(import.meta.url)('pngjs') as { PNG: { sync: { read(bytes: Buffer): { width: number; height: number; data: Buffer } } } }
type Baseline = HtmlPreviewEvidence['baseline']

export class HtmlPreviewVerificationError extends Error {
  readonly failure: NonNullable<PerfResult['htmlPreviewFailure']>
  constructor(stage: string, observed: Record<string, unknown>, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`HTML ${stage}: ${detail}`, { cause })
    const json = JSON.stringify(observed)
    this.failure = { stage, message: detail.slice(0, 4000), observed: json.length <= 16000 ? JSON.parse(json) : { truncated: true, rawJsonPrefix: json.slice(0, 16000) } }
  }
}

async function bounded<T>(promise: Promise<T>, label: string, timeout = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`HTML evidence ${label} exceeded ${timeout} ms`)), timeout)
    })])
  } finally { clearTimeout(timer) }
}

async function withSession<T>(page: Page, subject: Page | Frame, operation: (session: CDPSession) => Promise<T>): Promise<T> {
  const acquiring = page.context().newCDPSession(subject)
  let session: CDPSession
  try { session = await bounded(acquiring, 'CDP attachment') }
  catch (error) {
    void acquiring.then(late => late.detach()).catch(cleanup => console.warn('[perf] Late HTML evidence CDP attachment cleanup failed', cleanup))
    throw error
  }
  try { return await operation(session) }
  finally { await bounded(session.detach(), 'CDP detach') }
}

async function nativeTopology(app: ElectronApplication, window: Page) {
  return bounded(app.evaluate(({ app, webContents }, pageUrl) => {
    const canonical = (url: string) => url.replace(/^file:\/\/\/private\/var\//, 'file:///var/')
    const contents = webContents.getAllWebContents().filter(contents => canonical(contents.getURL()) === canonical(pageUrl))
    if (contents.length !== 1) throw new Error('HTML evidence cannot identify one owning window')
    const owner = contents[0]
    const metrics = app.getAppMetrics()
    const describe = (frame: Electron.WebFrameMain) => {
      const process = metrics.filter(metric => metric.pid === frame.osProcessId)
      if (process.length !== 1 || !Number.isFinite(process[0].creationTime) || frame.osProcessId <= 0) throw new Error('HTML frame has unknown or ambiguous native process identity')
      return { pid: frame.osProcessId, creationTime: process[0].creationTime, contentsId: owner.id, frameTreeNodeId: frame.frameTreeNodeId, processId: frame.processId, routingId: frame.routingId, frameToken: typeof frame.frameToken === 'string' ? frame.frameToken : null, url: frame.url }
    }
    const allFrames = webContents.getAllWebContents().flatMap(contents => contents.mainFrame.framesInSubtree)
    return { parent: describe(owner.mainFrame), previews: owner.mainFrame.framesInSubtree.filter(frame => frame.url.startsWith('halo-preview:')).map(describe), allFrames: allFrames.map(frame => ({ pid: frame.osProcessId, frameTreeNodeId: frame.frameTreeNodeId })), rendererPids: metrics.filter(metric => metric.type === 'Tab').map(metric => metric.pid) }
  }, window.url()), 'native frame topology')
}

/** No preview exists at this boundary; a later child counter cannot be charged as prior content. */
export async function beginHtmlPreviewEvidence(app: ElectronApplication, window: Page): Promise<Baseline> {
  const topology = await nativeTopology(app, window)
  assert.equal(topology.previews.length, 0, 'The HTML open baseline must contain no preview frame')
  assert.equal(window.frames().filter(frame => frame.url().startsWith('halo-preview:')).length, 0, 'The browser frame baseline must contain no preview')
  const targetId = await withSession(window, window, async session => {
    const { targetInfo } = await bounded(session.send('Target.getTargetInfo'), 'parent target identity')
    assert.ok(targetInfo.targetId, 'The parent CDP target must be identified')
    return targetInfo.targetId
  })
  return { previewFrameCount: 0, parent: { ...topology.parent, targetId }, rendererPids: topology.rendererPids }
}

interface CaptureOptions {
  app: ElectronApplication; window: Page; baseline: Baseline; fixturePath: string
  parentNodes: { start: number; end: number; delta: number }; label: string; scenario: string; openedAt: number
}

export async function captureHtmlPreviewEvidence(options: CaptureOptions): Promise<HtmlPreviewEvidence> {
  const diagnostic = { stage: 'read fixture source', observed: { baseline: options.baseline, rawParent: options.parentNodes } as Record<string, unknown> }
  try { return await collectHtmlPreviewEvidence(options, diagnostic) }
  catch (error) {
    if (error instanceof HtmlPreviewVerificationError) throw error
    throw new HtmlPreviewVerificationError(diagnostic.stage, diagnostic.observed, error)
  }
}

async function collectHtmlPreviewEvidence(options: CaptureOptions, diagnostic: { stage: string; observed: Record<string, unknown> }): Promise<HtmlPreviewEvidence> {
  const { app, window, baseline, parentNodes } = options
  const verificationStarted = Date.now()
  const bytes = readFileSync(options.fixturePath)
  const source = bytes.toString('utf8')
  const sections = [...source.matchAll(/<h2>Section (\d+)<\/h2>/g)]
  const fixture = { name: basename(options.fixturePath), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), elements: [...source.matchAll(/<[a-z][a-z0-9]*(?=[\s>])/gi)].length, sections: sections.length, lastSection: `Section ${sections.at(-1)?.[1]}` }
  diagnostic.observed.fixture = fixture
  diagnostic.stage = 'verify fixture sections'
  assert.ok(fixture.sections > 0, 'The HTML fixture must have known first and last sections')
  diagnostic.stage = 'select active canvas iframe'
  const iframe = window.locator('.canvas-tab-bar + * iframe')
  const iframeCount = await iframe.count()
  diagnostic.observed.iframeCount = iframeCount
  assert.equal(iframeCount, 1, 'The active canvas must have exactly one HTML preview iframe')
  const handle = await iframe.elementHandle()
  assert.ok(handle, 'The active preview iframe must exist')
  let frame: Frame
  try {
    const selected = await handle.contentFrame()
    assert.ok(selected, 'The preview iframe must own a loaded document')
    frame = selected
  } finally { await handle.dispose() }
  diagnostic.observed.browserFrameUrl = frame.url()
  diagnostic.stage = 'verify browser frame URL'
  assert.ok(frame.url().startsWith('halo-preview:'), 'A desktop space file must use its isolated preview origin')
  assert.equal(decodeURIComponent(new URL(frame.url()).pathname.slice(1)), basename(options.fixturePath))
  diagnostic.stage = 'read complete preview DOM'
  const document = await bounded(frame.evaluate(() => {
    let attachedNodes = 1
    const walker = globalThis.document.createTreeWalker(globalThis.document, NodeFilter.SHOW_ALL)
    while (walker.nextNode()) attachedNodes++
    const headings = globalThis.document.querySelectorAll('h2')
    return { url: location.href, title: globalThis.document.title, readyState: globalThis.document.readyState, elements: globalThis.document.querySelectorAll('*').length, attachedNodes, sections: headings.length, lastSection: headings[headings.length - 1]?.textContent ?? '', heading: globalThis.document.querySelector('h1')?.textContent ?? '' }
  }), 'complete preview DOM')
  diagnostic.observed.document = document
  diagnostic.stage = 'verify complete preview DOM'
  assert.equal(document.title, 'Perf Fixture')
  assert.equal(document.readyState, 'complete')
  assert.equal(document.heading, 'Perf Fixture HTML')
  assert.equal(document.elements, fixture.elements, 'Every fixture element must be present in the actual child document')
  assert.equal(document.sections, fixture.sections)
  assert.equal(document.lastSection, fixture.lastSection)
  diagnostic.stage = 'read native frame topology'
  const topology = await nativeTopology(app, window)
  diagnostic.observed.topology = topology
  diagnostic.stage = 'verify native frame and renderer ownership'
  assert.equal(topology.previews.length, 1, 'The native window must own exactly one preview document')
  const child = topology.previews[0]
  assert.equal(child.url, frame.url())
  assert.equal(document.url, child.url)
  assert.deepEqual(topology.parent, (({ targetId: _targetId, ...native }) => native)(baseline.parent), 'The parent renderer identity must remain unchanged')
  if (child.pid !== baseline.parent.pid) {
    assert.notEqual(child.processId, baseline.parent.processId)
    assert.ok(!baseline.rendererPids.includes(child.pid), 'A reused child renderer has no measured prior CDP counter')
    const owned = topology.allFrames.filter(frame => frame.pid === child.pid)
    assert.deepEqual(owned, [{ pid: child.pid, frameTreeNodeId: child.frameTreeNodeId }], 'The preview counter must belong exclusively to this document')
  } else assert.equal(child.processId, baseline.parent.processId)
  diagnostic.stage = 'fetch served HTML bytes'
  diagnostic.observed.fetchRequest = { contentsId: child.contentsId, requestUrl: child.url }
  const served = await bounded(app.evaluate(async ({ webContents }, { contentsId, url }) => {
    const contents = webContents.fromId(contentsId)
    if (!contents) throw new Error('The HTML owning window closed')
    const response = await contents.session.fetch(url)
    const bytes = Buffer.from(await response.arrayBuffer())
    return { status: response.status, requestUrl: url, responseUrl: response.url, responseUrlAvailable: response.url.length > 0, redirected: response.redirected, data: bytes.toString('base64') }
  }, { contentsId: child.contentsId, url: child.url }), 'served HTML bytes')
  const servedBytes = Buffer.from(served.data, 'base64')
  const servedEvidence = { bytes: servedBytes.length, sha256: createHash('sha256').update(servedBytes).digest('hex'), status: served.status, requestUrl: served.requestUrl, responseUrl: served.responseUrl, responseUrlAvailable: served.responseUrlAvailable, redirected: served.redirected }
  diagnostic.observed.served = servedEvidence
  diagnostic.stage = 'verify served request and response identity'
  assert.equal(servedEvidence.status, 200)
  assert.equal(servedEvidence.requestUrl, child.url)
  assert.equal(servedEvidence.redirected, false)
  if (servedEvidence.responseUrlAvailable) assert.equal(servedEvidence.responseUrl, child.url)
  diagnostic.stage = 'verify complete served HTML bytes and hash'
  assert.equal(servedEvidence.bytes, fixture.bytes)
  assert.equal(servedEvidence.sha256, fixture.sha256, 'The actual preview protocol must serve the complete verified fixture')

  diagnostic.stage = 'wait for preview paint'
  await bounded(frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))), 'preview paint readiness')
  const rect = await iframe.boundingBox()
  const headingRect = await frame.locator('h1').boundingBox()
  diagnostic.observed.geometry = { frame: rect, heading: headingRect }
  diagnostic.stage = 'verify visible preview geometry'
  assert.ok(rect && headingRect && rect.width > 100 && rect.height > 100, 'The actual preview must occupy a visible canvas area')
  const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const clip = { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(viewport.width, rect.x + rect.width) - Math.max(0, rect.x), height: Math.min(viewport.height, rect.y + rect.height) - Math.max(0, rect.y) }
  assert.ok(clip.width > 100 && clip.height > 100 && headingRect.y >= clip.y && headingRect.y < clip.y + clip.height, 'The fixture heading must be inside the captured preview')
  diagnostic.observed.clip = clip
  diagnostic.stage = 'capture native compositor image'
  const png = await window.screenshot({ clip, timeout: 10000 })
  const decoded = PNG.sync.read(png)
  let opaquePixels = 0
  let inkPixels = 0
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    if (decoded.data[offset + 3] === 255) opaquePixels++
    if (decoded.data[offset + 3] > 0 && decoded.data[offset] < 200 && decoded.data[offset + 1] < 200 && decoded.data[offset + 2] < 200) inkPixels++
  }
  diagnostic.observed.image = { width: decoded.width, height: decoded.height, bytes: png.length, opaquePixels, inkPixels }
  diagnostic.stage = 'verify native compositor pixels'
  assert.ok(inkPixels > 100, 'The native compositor image must contain the fixture text and table ink')
  assert.equal(opaquePixels, decoded.width * decoded.height, 'The rendered preview must provide an opaque image')
  const artifact = `${options.scenario}-html-preview.png`
  const output = dirname(resultPath(options.label, options.scenario))
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, artifact), png)
  const pixels = { width: decoded.width, height: decoded.height, opaquePixels, inkPixels, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), artifact }
  const pixelReadyMsFromOpen = Date.now() - options.openedAt
  diagnostic.stage = 'verify final parent target identity'
  const parentTargetId = await withSession(window, window, async session => (await bounded(session.send('Target.getTargetInfo'), 'final parent target')).targetInfo.targetId)
  diagnostic.observed.parentTargetId = parentTargetId
  assert.equal(parentTargetId, baseline.parent.targetId)
  let targetId = parentTargetId
  let sessionEvidence: HtmlPreviewEvidence['session'] = null
  const processes: HtmlPreviewEvidence['rendererNodes']['processes'] = [{ role: 'parent', pid: baseline.parent.pid, creationTime: baseline.parent.creationTime, targetId: parentTargetId, nodes: parentNodes.end }]
  if (child.pid !== baseline.parent.pid) {
    const observed = diagnostic.observed
    Object.assign(observed, { nativeFrame: child, pixels })
    let stage = 'attach child CDP session'
    let preview: HtmlPreviewEvidence['rendererNodes']['processes'][number]
    try { preview = await withSession(window, frame, async session => {
      stage = 'read child TargetInfo'
      const { targetInfo } = await bounded(session.send('Target.getTargetInfo'), 'preview target identity')
      observed.targetInfo = { targetId: targetInfo.targetId, type: targetInfo.type, title: targetInfo.title, url: targetInfo.url, attached: targetInfo.attached }
      stage = 'read child frame tree'
      const { frameTree } = await bounded(session.send('Page.getFrameTree'), 'preview session frame tree')
      observed.frameTree = { frame: frameTree.frame, childFrameCount: frameTree.childFrames?.length ?? 0 }
      stage = 'read child Runtime location'
      const runtime = await bounded(session.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }), 'preview session document URL')
      observed.runtime = { result: runtime.result, exceptionDetails: runtime.exceptionDetails ?? null }
      stage = 'verify child TargetInfo URL'
      if (targetInfo.url) assert.equal(targetInfo.url, child.url)
      stage = 'verify child target ID'
      assert.ok(targetInfo.targetId && targetInfo.targetId !== parentTargetId, 'An independent renderer must own an independent CDP target')
      stage = 'verify child frame-tree root ID'
      assert.equal(frameTree.frame.id, targetInfo.targetId, 'The owned child target must be the root of its CDP frame tree')
      stage = 'verify child frame-tree URL'
      assert.equal(frameTree.frame.url, child.url)
      stage = 'verify child Runtime URL'
      assert.ok(!runtime.exceptionDetails, 'The child session must have a live document execution context')
      assert.equal(runtime.result.value, child.url)
      sessionEvidence = { targetInfoUrl: targetInfo.url, targetInfoUrlAvailable: targetInfo.url.length > 0, frameTreeId: frameTree.frame.id, frameTreeUrl: frameTree.frame.url, runtimeUrl: runtime.result.value as string }
      stage = 'enable child renderer counters'
      await bounded(session.send('Performance.enable'), 'child counter enable')
      stage = 'read child renderer counters'
      const { metrics } = await bounded(session.send('Performance.getMetrics'), 'child renderer counters')
      const nodes = metrics.find(metric => metric.name === 'Nodes')?.value
      observed.counterNodes = nodes ?? null
      stage = 'verify child renderer counters'
      assert.ok(Number.isSafeInteger(nodes) && nodes! >= document.attachedNodes, 'The child renderer counter must cover the complete attached document')
      stage = 'release child CDP session'
      return { role: 'preview' as const, pid: child.pid, creationTime: child.creationTime, targetId: targetInfo.targetId, nodes: nodes! }
    }) } catch (error) { throw new HtmlPreviewVerificationError(stage, observed, error) }
    targetId = preview.targetId
    processes.push(preview)
  } else assert.ok(parentNodes.end >= document.attachedNodes, 'An in-process preview must already be included in the parent counter')
  diagnostic.observed.rendererCounters = processes
  diagnostic.stage = 'verify renderer counter uniqueness'
  assert.equal(new Set(processes.map(process => process.pid)).size, processes.length, 'Each renderer process must be counted once')
  diagnostic.stage = 'verify pinned final native frame'
  const final = await nativeTopology(app, window)
  diagnostic.observed.finalTopology = final
  assert.deepEqual(final.previews, [child], 'The preview document and renderer must remain pinned throughout evidence collection')
  const end = processes.reduce((sum, process) => sum + process.nodes, 0)
  return { baseline, frame: { ...child, targetId }, session: sessionEvidence, fixture, served: servedEvidence, document, pixels, pixelReadyMsFromOpen, verificationAfterSampling: true, evidenceVerificationMs: Date.now() - verificationStarted, rawParent: parentNodes, rendererNodes: { counter: 'Performance.Nodes', scope: 'distinct-owned-renderer-processes', start: parentNodes.start, end, delta: end - parentNodes.start, processes } }
}
