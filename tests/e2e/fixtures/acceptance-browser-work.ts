import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { AIBrowserLivePage } from '../../../src/shared/types/ai-browser'
import type { Thought } from '../../../src/shared/types/transcript'
import {
  test as base, expect, acceptance, readAcceptanceConversation,
  sendAcceptanceMessage, waitForAcceptanceIdle,
} from './acceptance-app'
import type { AcceptanceModel, ModelRequest } from './acceptance-model'
import { assertBrowserFrame, guestIdentity } from './browser-site'

const PAGE_SCRIPT = `
window.carrierNonce = crypto.randomUUID(); window.pageClicks = 0; window.inputEvents = []; window.cancelledKeys = []; window.pasteEvents = [];
document.addEventListener('click', event => { window.pageClicks++; window.lastClick = { trusted: event.isTrusted, target: event.target.id }; });
document.addEventListener('input', event => window.inputEvents.push({ target: event.target.id, trusted: event.isTrusted }));
document.addEventListener('paste', event => window.pasteEvents.push({ target: event.target.id, trusted: event.isTrusted, text: event.clipboardData.getData('text/plain') }));
document.querySelector('#cancel').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && ['a', 'v'].includes(event.key.toLowerCase())) {
    event.preventDefault(); window.cancelledKeys.push({ key: event.key.toLowerCase(), trusted: event.isTrusted, cancelled: event.defaultPrevented });
  }
});`

export function browserWorkHtml(title: string, frame = false) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#00b4ff;font:18px sans-serif;${frame ? '' : 'min-height:2400px;'}">
<h1 style="font-size:22px;margin:8px">${title}</h1>
<label style="display:block;margin:8px">${frame ? 'Frame draft' : 'Draft'} <input id="draft" aria-label="${frame ? 'Frame draft' : 'Draft'}" style="width:260px"></label>
<label style="display:block;margin:8px">Paste destination <input id="paste" aria-label="${frame ? 'Frame paste' : 'Paste destination'}" style="width:230px"></label>
<label style="display:block;margin:8px">Protected input <input id="cancel" aria-label="${frame ? 'Frame protected input' : 'Protected input'}" value="Protected original" style="width:240px"></label>
<label style="display:block;margin:8px">Control <input id="control" value="Unchanged page control" readonly></label>
<button id="action" style="margin:8px">Page action</button>
${frame ? '' : '<iframe id="editing-frame" title="Owned editing frame" src="/frame" style="display:block;margin:8px;border:0;width:min(440px,calc(100vw - 16px));height:240px"></iframe>'}
<script>${PAGE_SCRIPT}</script></body></html>`
}

interface BrowserWorkSite {
  targetUrl: string
  controlUrl: string
  nextUrl: string
  targetTitle: string
}

export const test = base.extend<{ browserWorkSite: BrowserWorkSite; browserWorkTrace: void }>({
  browserWorkTrace: [async ({ acceptanceApp }, use, info) => {
    const context = acceptanceApp.app.context()
    await context.tracing.start({ screenshots: true, snapshots: true })
    try { await use() }
    finally {
      if (info.status !== info.expectedStatus) {
        const trace = info.outputPath('browser-work-trace.zip')
        await context.tracing.stop({ path: trace })
        await info.attach('browser-work-trace', { path: trace, contentType: 'application/zip' })
      } else await context.tracing.stop()
    }
  }, { auto: true }],
  browserWorkSite: async ({}, use) => {
    const label = randomUUID()
    const targetTitle = `Owned browser ${label}`
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(browserWorkHtml(url.pathname === '/frame' ? 'Owned frame' : url.searchParams.get('role') === 'control' ? `Control browser ${label}` : targetTitle, url.pathname === '/frame'))
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try { await use({ targetUrl: `${origin}/page?role=target`, controlUrl: `${origin}/page?role=control`, nextUrl: `${origin}/next?role=target`, targetTitle }) }
    finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  },
})

export { expect, acceptance }

export const READ_BROWSER_STATE = `() => {
  const state = owner => {
    const doc = owner.document;
    const field = id => { const input = doc.querySelector('#' + id); return { value: input.value, start: input.selectionStart, end: input.selectionEnd }; };
    return { nonce: owner.carrierNonce, draft: field('draft'), paste: field('paste'), protected: field('cancel'), control: field('control'),
      clicks: owner.pageClicks, lastClick: owner.lastClick ?? null, inputs: owner.inputEvents, cancelledKeys: owner.cancelledKeys, pastes: owner.pasteEvents, scroll: owner.scrollY };
  };
  return { url: location.href, ...state(window), frame: document.querySelector('#editing-frame') ? state(document.querySelector('#editing-frame').contentWindow) : null };
}`

export interface BrowserState {
  url: string
  nonce: string
  draft: { value: string; start: number | null; end: number | null }
  paste: { value: string; start: number | null; end: number | null }
  protected: { value: string; start: number | null; end: number | null }
  control: { value: string; start: number | null; end: number | null }
  clicks: number
  lastClick: { trusted: boolean; target: string } | null
  inputs: Array<{ target: string; trusted: boolean }>
  cancelledKeys: Array<{ key: string; trusted: boolean; cancelled: boolean }>
  pastes: Array<{ target: string; trusted: boolean; text: string }>
  scroll: number
  frame: Omit<BrowserState, 'url' | 'frame'> | null
}

export function parseBrowserState(text: string): BrowserState {
  const json = text.match(/```json\s*([\s\S]*?)```/)?.[1]
  if (!json) throw new Error(`The browser tool returned no JSON state: ${text}`)
  return JSON.parse(json) as BrowserState
}

export interface BrowserStep {
  name: string
  input: Record<string, unknown> | ((results: string[]) => Record<string, unknown>)
}

export async function runBrowserChat(window: Page, model: AcceptanceModel, instruction: string, steps: BrowserStep[]) {
  const reference = randomUUID()
  const question = `${instruction} Request reference: ${reference}.`
  const answer = `Browser tool responses recorded for ${reference}.`
  const requests: ModelRequest[] = []
  const results: string[] = []
  const issues: string[] = []
  const ids = steps.map((_step, index) => `browser-${reference}-${index}`)
  const inputs: Array<Record<string, unknown>> = []
  model.respond(request => {
    requests.push(request)
    if (!request.text.includes(reference)) {
      issues.push('The browser request reference did not reach the model')
      return { text: answer }
    }
    for (const [index, step] of steps.entries()) {
      const result = request.toolResults.find(result => result.id === ids[index])
      if (result) { results[index] = result.text; continue }
      const names = request.tools.filter(name => name === step.name || name.endsWith(`__${step.name}`))
      if (names.length !== 1) { issues.push(`Expected one advertised ${step.name}, received ${names.length}`); return { text: answer } }
      try {
        const input = typeof step.input === 'function' ? step.input(results) : step.input
        inputs[index] = input
        return { tools: [{ id: ids[index], name: names[0], input }] }
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error))
        return { text: answer }
      }
    }
    return { text: answer }
  })
  const turn = await sendAcceptanceMessage(window, question)
  await expect(window.locator('.message-assistant').last()).toContainText(answer, { timeout: 60000 })
  await waitForAcceptanceIdle(window, turn.conversationId, { timeout: 30000 })
  expect(issues, 'Script problems must remain failures without manufacturing provider transport errors').toEqual([])
  expect(results).toHaveLength(steps.length)
  expect(requests).toHaveLength(steps.length + 1)
  const saved = await readAcceptanceConversation(window, turn.spaceId, turn.conversationId)
  expect(saved.messages.filter(message => message.role === 'user').at(-1)?.content).toBe(question)
  const assistant = saved.messages.filter(message => message.role === 'assistant').at(-1)!
  const thoughts = await window.evaluate(({ spaceId, conversationId, messageId }) => (window as unknown as { halo: HaloAPI }).halo.getMessageThoughts(spaceId, conversationId, messageId), { spaceId: turn.spaceId, conversationId: turn.conversationId, messageId: assistant.id })
  expect(thoughts.success).toBe(true)
  const tools = (thoughts.data as Thought[]).filter(thought => thought.type === 'tool_use' && steps.some(step => thought.toolName === step.name || thought.toolName?.endsWith(`__${step.name}`)))
  expect(tools).toHaveLength(steps.length)
  for (const [index, tool] of tools.entries()) {
    expect(tool.toolName === steps[index].name || tool.toolName?.endsWith(`__${steps[index].name}`)).toBe(true)
    expect(tool.toolInput).toEqual(inputs[index])
    expect(tool.toolResult?.isError).toBe(false)
    expect(results[index]).not.toMatch(/^(?:Script error|Snapshot failed|Failed to create page|Navigation failed|Fill failed)/)
  }
  return { turn, answer, question, results, requests }
}

export function snapshotUid(text: string, role: string, name: string): string {
  const line = text.split('\n').find(line => line.includes(`${role} "${name}"`))
  const uid = line?.match(/uid=(\S+)/)?.[1]
  if (!uid) throw new Error(`The actual page snapshot has no ${role} named ${name}`)
  return uid
}

export async function openAiBrowser(window: Page, app: ElectronApplication, model: AcceptanceModel, site: BrowserWorkSite, draft: string) {
  const opened = await runBrowserChat(window, model, `Open the controlled local browser page ${site.controlUrl}, record its state, then create a separate page ${site.targetUrl} and fill its Draft field with ${JSON.stringify(draft)}.`, [
    { name: 'browser_navigate', input: { url: site.controlUrl } },
    { name: 'browser_evaluate', input: { function: READ_BROWSER_STATE } },
    { name: 'browser_tab', input: { action: 'new', url: site.targetUrl } },
    { name: 'browser_snapshot', input: {} },
    { name: 'browser_fill', input: results => ({ uid: snapshotUid(results[3], 'textbox', 'Draft'), value: draft }) },
    { name: 'browser_evaluate', input: { function: READ_BROWSER_STATE } },
  ])
  const control = parseBrowserState(opened.results[1])
  const target = parseBrowserState(opened.results[5])
  expect(target.draft.value).toBe(draft)
  expect(target.inputs.length).toBeGreaterThan(0)
  expect(target.inputs.every(event => event.trusted)).toBe(true)
  const response = await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.listAIBrowserLivePages())
  expect(response.success).toBe(true)
  const pages = response.data as AIBrowserLivePage[]
  const active = pages.find(page => page.url === site.targetUrl)!
  const other = pages.find(page => page.url === site.controlUrl)!
  expect(pages).toHaveLength(2)
  expect(active).toMatchObject({ owned: true, active: true, conversationId: opened.turn.conversationId, spaceId: opened.turn.spaceId })
  expect(other).toMatchObject({ owned: true, active: false, conversationId: opened.turn.conversationId, spaceId: opened.turn.spaceId })
  const guestId = await guestIdentity(app, site.targetUrl)
  const controlGuestId = await guestIdentity(app, site.controlUrl)
  expect(guestId).toBeGreaterThan(0)
  expect(controlGuestId).toBeGreaterThan(0)
  expect(guestId).not.toBe(controlGuestId)
  return { ...opened, viewId: active.viewId, controlViewId: other.viewId, guestId, controlGuestId, control, target }
}

export async function readGuest(app: ElectronApplication, guestId: number): Promise<BrowserState> {
  return app.evaluate(({ webContents }, { guestId, script }) => webContents.fromId(guestId)!.executeJavaScript(`(${script})()`), { guestId, script: READ_BROWSER_STATE })
}

export async function revealFromReply(window: Page, answer: string) {
  const row = window.locator('[data-transcript-index]').filter({ hasText: answer }).last()
  const view = row.getByRole('button', { name: 'Open browser view', exact: true })
  if (!await view.isVisible()) await row.getByRole('button', { name: /^Already thought/ }).click()
  await expect(view).toBeEnabled()
  await view.click()
}

export async function guestPoint(window: Page, app: ElectronApplication, guestId: number, selector: string, frame = false) {
  const guest = window.locator('webview[aria-hidden="false"]')
  await expect(guest).toHaveCount(1)
  expect(await guest.evaluate(element => (element as HTMLElement & { getWebContentsId(): number }).getWebContentsId())).toBe(guestId)
  const box = (await guest.boundingBox())!
  const point = await app.evaluate(async ({ webContents }, { guestId, selector, frame }) => webContents.fromId(guestId)!.executeJavaScript(`(() => {
    const frame = ${frame ? "document.querySelector('#editing-frame')" : 'null'};
    const doc = frame ? frame.contentDocument : document;
    const rect = doc.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    const offset = frame ? frame.getBoundingClientRect() : { x: 0, y: 0 };
    return { x: offset.x + rect.x + rect.width / 2, y: offset.y + rect.y + rect.height / 2 };
  })()`), { guestId, selector, frame })
  const scale = await app.evaluate(({ webContents }, guestId) => webContents.fromId(guestId)!.hostWebContents!.getZoomFactor(), guestId)
  const target = { x: box.x + point.x / scale, y: box.y + point.y / scale }
  expect(target.x).toBeGreaterThan(box.x)
  expect(target.x).toBeLessThan(box.x + box.width)
  expect(target.y).toBeGreaterThan(box.y)
  expect(target.y).toBeLessThan(box.y + box.height)
  expect(await window.evaluate(({ target, guestId }) => {
    const hit = document.elementFromPoint(target.x, target.y) as HTMLElement & { getWebContentsId?: () => number }
    return hit?.tagName === 'WEBVIEW' && hit.getWebContentsId?.() === guestId
  }, { target, guestId })).toBe(true)
  return target
}

export async function paintAiBrowser(window: Page, app: ElectronApplication, viewId: string) {
  const guest = window.locator(`webview[data-browser-page-id="${viewId}"]`)
  await expect(guest).toHaveAttribute('aria-hidden', 'false')
  await assertBrowserFrame(app, window, viewId)
  const screenshot = await window.screenshot()
  const bounds = (await guest.boundingBox())!
  const width = await window.evaluate(() => innerWidth)
  const pixel = await app.evaluate(({ nativeImage }, { data, bounds, width }) => {
    const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
    const ratio = image.getSize().width / width
    return Array.from(image.crop({ x: Math.round((bounds.x + bounds.width - 24) * ratio), y: Math.round((bounds.y + bounds.height - 24) * ratio), width: 1, height: 1 }).toBitmap().subarray(0, 3))
  }, { data: screenshot.toString('base64'), bounds, width })
  expect(pixel, 'The actual application window must paint the revealed guest').toEqual([255, 180, 0])
  return screenshot
}
