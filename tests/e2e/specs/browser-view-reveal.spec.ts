import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, callBrowserTool, toolText, type ContextKind, type BrowserToolOutcome } from '../fixtures/browser-runtime'
import { showBrowser, hideBrowser, destroyBrowser, executeBrowser, guestIdentity, assertBrowserFrame, browserHtmlFixture } from '../fixtures/browser-site'
import { preserveSystemClipboard } from '../fixtures/clipboard'
import { browserFrameColors } from '../fixtures/image-pixels'

function snapshotUid(text: string, role: string, name: string): string {
  const line = text.split('\n').find(line => line.includes(`${role} "${name}"`))
  const uid = line?.match(/uid=(\S+)/)?.[1]
  if (!uid) throw new Error(`Snapshot has no ${role} named ${name}:\n${text}`)
  return uid
}

test.describe('AI tools on persistent webview guests', () => {
  test.setTimeout(120000)

  test('native and AI screenshots preserve opaque default, dark and explicit page backgrounds', async ({ electronApp, window }, testInfo) => {
    const fixtures = new Map([
      ['default', { root: '', body: '', rgb: [255, 255, 255] }],
      ['dark', { root: ' style="color-scheme:dark"', body: '', rgb: [18, 18, 18] }],
      ['explicit', { root: '', body: ' style="display:flow-root;margin:0;height:100vh;overflow:hidden;background:rgb(72,144,210)"', rgb: [72, 144, 210] }],
    ])
    const server = createServer((request, response) => {
      const name = new URL(request.url!, 'http://127.0.0.1').pathname.slice(1)
      const fixture = fixtures.get(name)
      if (!fixture) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(`<!doctype html><html${fixture.root}><head><meta charset="utf-8"><title>Opaque ${name} fixture</title></head><body${fixture.body}><h1>Opaque ${name} fixture</h1><script>window.carrierNonce=crypto.randomUUID()</script></body></html>`)
    })
    let contextCreated = false
    let activeView: string | undefined
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Background fixture server has no TCP address')
    const inspectImage = (data: string, rgb: number[], tolerance: number) => window.evaluate(async ({ data, rgb, tolerance }) => {
      const image = new Image()
      image.src = data
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let opaquePixels = 0
      let matchingPixels = 0
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] === 255) opaquePixels++
        if (pixels[offset + 3] === 255 && rgb.every((channel, index) => Math.abs(pixels[offset + index] - channel) <= tolerance)) matchingPixels++
      }
      const corners = [[4, 4], [canvas.width - 5, 4], [4, canvas.height - 5], [canvas.width - 5, canvas.height - 5]].map(([x, y]) => [...pixels.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4)])
      return { width: canvas.width, height: canvas.height, opaquePixels, matchingPixels, corners }
    }, { data, rgb, tolerance })
    try {
      for (const [name, fixture] of fixtures) {
        const url = `http://127.0.0.1:${address.port}/${name}`
        contextCreated = true
        const opened = await callBrowserTool(window, 'human', 'browser_navigate', { url })
        expect(opened.viewId).not.toBeNull()
        activeView = opened.viewId!
        await showBrowser(window, activeView)
        const contentsId = await guestIdentity(electronApp, url)
        expect(contentsId).toBeGreaterThan(0)
        const nonce = await executeBrowser<string>(window, activeView, 'carrierNonce')
        expect(nonce).toMatch(/^[0-9a-f-]{36}$/)
        expect(await executeBrowser(window, activeView, 'document.readyState')).toBe('complete')
        expect(await executeBrowser(window, activeView, 'getComputedStyle(document.documentElement).colorScheme')).toBe(name === 'dark' ? 'dark' : 'normal')
        if (name === 'explicit') expect(await executeBrowser(window, activeView, '({ width:document.documentElement.clientWidth === innerWidth, height:document.documentElement.clientHeight === innerHeight })')).toEqual({ width: true, height: true })
        await executeBrowser(window, activeView, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
        const native = await electronApp.evaluate(async ({ webContents }, contentsId) => {
          const guest = webContents.fromId(contentsId)!
          const frame = { contentsId: guest.id, processId: guest.mainFrame.processId, routingId: guest.mainFrame.routingId }
          const target = await guest.debugger.sendCommand('Target.getTargetInfo')
          const image = await guest.capturePage(undefined, { stayHidden: true, stayAwake: true })
          if (image.isEmpty()) throw new Error('Native background capture returned an empty image')
          return { frame, targetId: target.targetInfo.targetId as string, png: image.toPNG().toString('base64'), jpeg: image.toJPEG(90).toString('base64') }
        }, contentsId)
        const ai = await callBrowserTool(window, 'human', 'browser_screenshot')
        const image = ai.result.content.find(content => content.type === 'image')
        expect(image).toMatchObject({ mimeType: 'image/jpeg', data: expect.any(String) })
        const images = [
          { label: 'native-png', data: native.png, mimeType: 'image/png', tolerance: 3 },
          { label: 'native-jpeg', data: native.jpeg, mimeType: 'image/jpeg', tolerance: 6 },
          { label: 'ai-jpeg', data: image!.data!, mimeType: 'image/jpeg', tolerance: 6 },
        ]
        for (const capture of images) {
          await testInfo.attach(`${name}-${capture.label}`, { body: Buffer.from(capture.data, 'base64'), contentType: capture.mimeType })
          const pixels = await inspectImage(`data:${capture.mimeType};base64,${capture.data}`, fixture.rgb, capture.tolerance)
          await testInfo.attach(`${name}-${capture.label}-rgba`, { body: Buffer.from(JSON.stringify(pixels)), contentType: 'application/json' })
          expect(pixels.width).toBeGreaterThan(100)
          expect(pixels.height).toBeGreaterThan(100)
          expect(pixels.opaquePixels, `${name} ${capture.label} must contain an opaque page surface`).toBe(pixels.width * pixels.height)
          expect(pixels.matchingPixels, `${name} ${capture.label} must paint the expected canvas background`).toBeGreaterThan(pixels.width * pixels.height * 0.9)
          for (const corner of pixels.corners) {
            expect(corner[3]).toBe(255)
            fixture.rgb.forEach((channel, index) => expect(Math.abs(corner[index] - channel)).toBeLessThanOrEqual(capture.tolerance))
          }
        }
        const after = await electronApp.evaluate(async ({ webContents }, contentsId) => {
          const guest = webContents.fromId(contentsId)!
          const target = await guest.debugger.sendCommand('Target.getTargetInfo')
          return { frame: { contentsId: guest.id, processId: guest.mainFrame.processId, routingId: guest.mainFrame.routingId }, targetId: target.targetInfo.targetId as string }
        }, contentsId)
        expect(after).toEqual({ frame: native.frame, targetId: native.targetId })
        expect(await executeBrowser(window, activeView, '({url:location.href,nonce:carrierNonce})')).toEqual({ url, nonce })
        await destroyBrowser(window, activeView)
        activeView = undefined
        expect(await electronApp.evaluate(({ webContents }, contentsId) => !!webContents.fromId(contentsId), contentsId)).toBe(false)
      }
    } finally {
      try {
        if (activeView) await destroyBrowser(window, activeView)
        if (contextCreated) await window.evaluate(async () => (window as unknown as { browserTest: { release: (kind: ContextKind) => Promise<unknown> } }).browserTest.release('human'))
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
    }
  })

  for (const kind of ['main', 'human'] as ContextKind[]) {
    test(`${kind} conversation keeps one page through watching, takeover, parking and further AI work`, async ({ electronApp, window, browserSite }) => {
      const url = browserSite.pageUrl(`ai-${kind}`)
      const opened = await callBrowserTool(window, kind, 'browser_navigate', { url })
      expect(opened.viewId).not.toBeNull()
      expect(opened.pages).toContainEqual(expect.objectContaining({ viewId: opened.viewId, conversationId: kind === 'main' ? 'carrier-main' : 'app-chat:carrier-human' }))
      const viewId = opened.viewId!
      await expect.poll(() => guestIdentity(electronApp, url), { message: `Navigation result: ${toolText(opened)}` }).toBeGreaterThan(0)
      const id = await guestIdentity(electronApp, url)
      const mainContentsId = await electronApp.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getType() === 'window' && contents.getURL() === url)!.id, window.url())
      expect(await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)!.hostWebContents?.id, id)).toBe(mainContentsId)
      const nonce = await executeBrowser(window, viewId, 'carrierNonce')
      await executeBrowser(window, viewId, 'window.carrierInputTrusted = []; document.querySelector("#draft").addEventListener("input", event => carrierInputTrusted.push(event.isTrusted)); true')
      await window.evaluate(() => { const input = document.createElement('input'); input.id = 'host-editor'; input.value = 'host draft'; document.body.appendChild(input); input.focus(); input.setSelectionRange(5, 5) })

      const snapshot = toolText(await callBrowserTool(window, kind, 'browser_snapshot'))
      const draft = 'AI draft 中文𠮷🙂'
      await callBrowserTool(window, kind, 'browser_fill', { uid: snapshotUid(snapshot, 'textbox', 'Draft'), value: draft })
      expect(await executeBrowser(window, viewId, `document.querySelector('#draft').value`)).toBe(draft)
      const inputEvents = await executeBrowser<boolean[]>(window, viewId, 'carrierInputTrusted')
      expect(inputEvents.length).toBeGreaterThan(0)
      expect(inputEvents.every(trusted => trusted)).toBe(true)
      expect(await window.evaluate(() => { const input = document.querySelector('#host-editor') as HTMLInputElement; return { value: input.value, selection: input.selectionStart, active: document.activeElement?.id } })).toEqual({ value: 'host draft', selection: 5, active: 'host-editor' })
      for (let cycle = 0; cycle < 4; cycle++) {
        await showBrowser(window, viewId)
        await assertBrowserFrame(electronApp, window, viewId)
        await executeBrowser(window, viewId, `document.querySelector('#draft').value += ' user'; scrollTo(0, 220)`)
        await hideBrowser(window, viewId)
        const resumed = await callBrowserTool(window, kind, 'browser_evaluate', { function: '() => ({ nonce: carrierNonce, value: document.querySelector("#draft").value, scroll: scrollY })' })
        expect(toolText(resumed)).toContain(String(nonce))
        expect(toolText(resumed)).toContain(`${draft}${' user'.repeat(cycle + 1)}`)
        expect(toolText(resumed)).toContain('220')
        const capture = await callBrowserTool(window, kind, 'browser_screenshot')
        expect(capture.result.content.some(item => item.type === 'image' && (item.data?.length ?? 0) > 1000)).toBe(true)
        expect(await guestIdentity(electronApp, url)).toBe(id)
      }
      const currentSnapshot = toolText(await callBrowserTool(window, kind, 'browser_snapshot'))
      await callBrowserTool(window, kind, 'browser_click', { uid: snapshotUid(currentSnapshot, 'button', 'Page action') })
      expect(await executeBrowser<number>(window, viewId, 'pageClicks')).toBeGreaterThan(0)

      await window.evaluate(async kind => (window as unknown as { browserTest: { release: (kind: string) => Promise<unknown> } }).browserTest.release(kind), kind)
      if (kind === 'main') {
        expect(await guestIdentity(electronApp, url)).toBe(id)
        await assertBrowserFrame(electronApp, window, viewId)
      } else {
        expect(await electronApp.evaluate(({ webContents }, id) => !!webContents.fromId(id), id)).toBe(false)
      }
    })
  }

  test('an unattended run owns a separate host and continues when the main host reloads', async ({ electronApp, window, browserSite }) => {
    const url = browserSite.pageUrl('automation')
    const opened = await callBrowserTool(window, 'automation', 'browser_navigate', { url })
    expect(opened.viewId).not.toBeNull()
    expect(opened.pages.some(page => page.viewId === opened.viewId)).toBe(false)
    await expect.poll(() => guestIdentity(electronApp, url), { message: `Navigation result: ${toolText(opened)}` }).toBeGreaterThan(0)
    const id = await guestIdentity(electronApp, url)
    const owner = await electronApp.evaluate(({ webContents }, { id, url }) => ({
      hostId: webContents.fromId(id)!.hostWebContents?.id,
      mainId: webContents.getAllWebContents().find(contents => contents.getType() === 'window' && contents.getURL() === url)!.id,
    }), { id, url: window.url() })
    expect(owner.hostId).not.toBe(owner.mainId)
    const nonce = await executeBrowser(window, opened.viewId!, 'carrierNonce')
    await window.reload()
    await window.waitForLoadState('domcontentloaded')
    expect(await guestIdentity(electronApp, url)).toBe(id)
    expect(toolText(await callBrowserTool(window, 'automation', 'browser_evaluate', { function: '() => carrierNonce' }))).toContain(String(nonce))
    const screenshot = await callBrowserTool(window, 'automation', 'browser_screenshot')
    expect(screenshot.result.content.some(item => item.type === 'image' && (item.data?.length ?? 0) > 1000)).toBe(true)
    await window.evaluate(async () => (window as unknown as { browserTest: { release: (kind: string) => Promise<unknown> } }).browserTest.release('automation'))
    expect(await electronApp.evaluate(({ webContents }, id) => !!webContents.fromId(id), id)).toBe(false)
  })

  test('the production MCP upload and silent download tools use the same guest and isolated test files', async ({ electronApp, window, browserSite }, testInfo) => {
    const opened = await callBrowserTool(window, 'human', 'browser_navigate', { url: browserSite.pageUrl('files') })
    const viewId = opened.viewId!
    const upload = testInfo.outputPath('carrier-upload.txt')
    fs.writeFileSync(upload, 'Carrier upload fixture\n')
    const snapshot = toolText(await callBrowserTool(window, 'human', 'browser_snapshot'))
    await callBrowserTool(window, 'human', 'browser_upload_file', { uid: snapshotUid(snapshot, 'button', 'Upload'), filePath: upload })
    expect(await executeBrowser(window, viewId, `document.querySelector('#upload').files[0].name`)).toBe('carrier-upload.txt')
    const download = await callBrowserTool(window, 'human', 'browser_download', { url: `${browserSite.origin}/download` })
    expect(toolText(download)).toContain('Download completed:')
    const savePath = toolText(download).match(/Path: (.+)/)?.[1]
    expect(savePath).toBeTruthy()
    expect(fs.readFileSync(savePath!, 'utf8')).toBe('Carrier download fixture\n')
    await showBrowser(window, viewId)
    await assertBrowserFrame(electronApp, window, viewId)
  })

  test('tab ownership isolates unattended work and guest destruction reconciles the AI pointer', async ({ window, browserSite }) => {
    const human = await callBrowserTool(window, 'human', 'browser_navigate', { url: browserSite.pageUrl('human-owned') })
    const automation = await callBrowserTool(window, 'automation', 'browser_navigate', { url: browserSite.pageUrl('automation-owned') })
    const main = await callBrowserTool(window, 'main', 'browser_navigate', { url: browserSite.pageUrl('main-owned') })
    const humanTabs = toolText(await callBrowserTool(window, 'human', 'browser_tab', { action: 'list' }))
    expect(humanTabs).toContain('human-owned')
    expect(humanTabs).not.toContain('automation-owned')
    const automaticTabs = toolText(await callBrowserTool(window, 'automation', 'browser_tab', { action: 'list' }))
    expect(automaticTabs).toContain('automation-owned')
    expect(automaticTabs).not.toContain('main-owned')
    const destroyed = await window.evaluate(async viewId => (window as unknown as { halo: HaloAPI }).halo.destroyBrowserView(viewId), human.viewId!)
    expect(destroyed).toMatchObject({ success: true })
    const reopened = await callBrowserTool(window, 'human', 'browser_navigate', { url: browserSite.pageUrl('human-fresh') })
    expect(reopened.viewId).not.toBe(human.viewId)
    expect(reopened.pages.some(page => page.viewId === human.viewId)).toBe(false)
    expect(reopened.pages.some(page => page.viewId === main.viewId)).toBe(true)
    expect(reopened.pages.some(page => page.viewId === automation.viewId)).toBe(false)
  })

  test('the remaining production tools preserve keyboard, hover, script, inspection and multi-tab behavior', async ({ electronApp, window, browserSite }) => {
    const url = browserSite.pageUrl('tool-chain')
    const opened = await callBrowserTool(window, 'main', 'browser_navigate', { url })
    const viewId = opened.viewId!
    const nonce = await executeBrowser(window, viewId, 'carrierNonce')
    await callBrowserTool(window, 'main', 'browser_wait_for', { text: 'Carrier regression page', timeout: 3000 })
    await callBrowserTool(window, 'main', 'browser_evaluate', { function: '() => { document.querySelector("#action").addEventListener("mouseenter", () => window.carrierHovered = true); return true }' })
    const snapshot = toolText(await callBrowserTool(window, 'main', 'browser_snapshot'))
    await callBrowserTool(window, 'main', 'browser_hover', { uid: snapshotUid(snapshot, 'button', 'Page action') })
    expect(await executeBrowser(window, viewId, 'carrierHovered')).toBe(true)
    await callBrowserTool(window, 'main', 'browser_fill', { uid: snapshotUid(snapshot, 'textbox', 'Draft'), value: 'keyboard' })
    await callBrowserTool(window, 'main', 'browser_press_key', { key: 'End' })
    await callBrowserTool(window, 'main', 'browser_press_key', { key: 'Backspace' })
    expect(await executeBrowser(window, viewId, `document.querySelector('#draft').value`)).toBe('keyboar')
    await callBrowserTool(window, 'main', 'browser_press_key', { key: 'Enter' })
    expect(await executeBrowser(window, viewId, 'submitted')).toBe(1)
    await callBrowserTool(window, 'main', 'browser_press_key', { key: process.platform === 'darwin' ? 'Meta+A' : 'Control+A' })
    await callBrowserTool(window, 'main', 'browser_press_key', { key: 'Backspace' })
    expect(await executeBrowser(window, viewId, `document.querySelector('#draft').value`)).toBe('')
    const workDir = await electronApp.evaluate(() => process.env.HALO_DATA_DIR!)
    const script = path.join(workDir, 'carrier-script.js')
    fs.writeFileSync(script, 'async (params) => { console.log(params.marker); const response = await fetch("/inspect-api"); return { text: await response.text(), nonce: carrierNonce } }')
    const scripted = await callBrowserTool(window, 'main', 'browser_run', { file: script, params: { marker: 'carrier-console-marker' } })
    expect(toolText(scripted)).toContain('Carrier inspection data')
    expect(toolText(scripted)).toContain(String(nonce))
    const network = toolText(await callBrowserTool(window, 'main', 'browser_inspect', { target: 'network' }))
    expect(network).toContain('/inspect-api')
    expect(toolText(await callBrowserTool(window, 'main', 'browser_inspect', { target: 'console' }))).toContain('carrier-console-marker')
    const second = await callBrowserTool(window, 'main', 'browser_tab', { action: 'new', url: browserSite.pageUrl('tool-chain-second') })
    expect(second.viewId).not.toBe(viewId)
    const selected = await callBrowserTool(window, 'main', 'browser_tab', { action: 'select', pageIdx: 0 })
    expect(selected.viewId).toBe(viewId)
    expect(await executeBrowser(window, viewId, 'carrierNonce')).toBe(nonce)
    await callBrowserTool(window, 'main', 'browser_tab', { action: 'close', pageIdx: 1 })
    expect(toolText(await callBrowserTool(window, 'main', 'browser_tab', { action: 'list' }))).not.toContain('tool-chain-second')
  })

  test('closing the page cancels a pending download wait promptly', async ({ window, browserSite }) => {
    const opened = await callBrowserTool(window, 'human', 'browser_navigate', { url: browserSite.pageUrl('pending-download') })
    const outcome = await window.evaluate(async viewId => {
      const runtime = (window as unknown as { browserTest: { tool: (kind: string, name: string, args: Record<string, unknown>) => Promise<{ result: { isError?: boolean; content: Array<{ text?: string }> } }> } }).browserTest
      const waiting = runtime.tool('human', 'browser_download', { timeout: 5000 })
      await new Promise(resolve => setTimeout(resolve, 100))
      const started = performance.now()
      await (window as unknown as { halo: HaloAPI }).halo.destroyBrowserView(viewId)
      const result = await waiting
      return { elapsedMs: performance.now() - started, result: result.result }
    }, opened.viewId!)
    expect(outcome.result.isError).toBe(true)
    expect(outcome.elapsedMs).toBeLessThan(1500)
    expect(outcome.result.content.map(item => item.text).join('\n')).toMatch(/closed|lost|destroyed|cancel/i)
  })

  test('native editing targets every guest field and preserves the host editor through shortcuts and script focus', async ({ electronApp, window, browserSite }) => {
    const opened = await callBrowserTool(window, 'main', 'browser_navigate', { url: browserSite.pageUrl('native-editing') })
    const viewId = opened.viewId!
    await executeBrowser(window, viewId, `
      document.querySelector('#form').insertAdjacentHTML('beforeend', '<input id="next" aria-label="Next"><button type="submit">Submit</button>');
      document.body.insertAdjacentHTML('beforeend', '<input id="number" type="number" aria-label="Number" value="123"><textarea id="notes" aria-label="Notes">old notes</textarea><div id="editable" role="textbox" aria-label="Editable" contenteditable="true">old editable</div>');
      document.querySelectorAll('#number,#notes,#editable').forEach(element => { element.style.position = 'fixed'; element.style.top = element.id === 'number' ? '160px' : element.id === 'notes' ? '210px' : '290px'; element.style.left = '10px' });
      window.carrierEditingEvents = [];
      document.addEventListener('input', event => carrierEditingEvents.push({ target: event.target.id, trusted: event.isTrusted })); true
    `)
    await window.evaluate(() => {
      const editor = document.createElement('textarea')
      editor.id = 'host-editor'
      editor.value = 'host draft 中文'
      document.body.appendChild(editor)
      editor.focus()
      editor.setSelectionRange(2, 7)
    })
    const hostState = () => window.evaluate(() => {
      const editor = document.querySelector('#host-editor') as HTMLTextAreaElement
      return { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd, active: document.activeElement?.id }
    })
    const expectedHost = { value: 'host draft 中文', start: 2, end: 7, active: 'host-editor' }
    const snapshot = toolText(await callBrowserTool(window, 'main', 'browser_snapshot'))
    for (const { selector, role, name, values } of [
      { selector: '#draft', role: 'textbox', name: 'Draft', values: ['first 中文𠮷🙂', 'replacement 中文𠮷🙂', ''] },
      { selector: '#number', role: 'spinbutton', name: 'Number', values: ['987', '432', ''] },
      { selector: '#notes', role: 'textbox', name: 'Notes', values: ['first\n中文𠮷🙂', 'replacement\n中文𠮷🙂', ''] },
      { selector: '#editable', role: 'textbox', name: 'Editable', values: ['first 中文𠮷🙂', 'replacement 中文𠮷🙂', ''] },
    ]) {
      for (const value of values) {
        await callBrowserTool(window, 'main', 'browser_fill', { uid: snapshotUid(snapshot, role, name), value })
        expect(await executeBrowser(window, viewId, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); return element.isContentEditable ? element.textContent : element.value })()`)).toBe(value)
        expect(await hostState()).toEqual(expectedHost)
      }
    }
    const events = await executeBrowser<Array<{ target: string; trusted: boolean }>>(window, viewId, 'carrierEditingEvents')
    for (const id of ['draft', 'number', 'notes', 'editable']) expect(events.some(event => event.target === id && event.trusted)).toBe(true)
    expect(events.every(event => event.trusted)).toBe(true)

    await callBrowserTool(window, 'main', 'browser_evaluate', { function: '() => { document.querySelector("#draft").focus(); return true }' })
    await callBrowserTool(window, 'main', 'browser_press_key', { key: 'Tab' })
    expect(await executeBrowser(window, viewId, 'document.activeElement.id')).toBe('next')
    await callBrowserTool(window, 'main', 'browser_press_key', { key: 'Shift+Tab' })
    expect(await executeBrowser(window, viewId, 'document.activeElement.id')).toBe('draft')
    await callBrowserTool(window, 'main', 'browser_press_key', { key: 'Enter' })
    expect(await executeBrowser(window, viewId, 'submitted')).toBe(1)
    expect(await hostState()).toEqual(expectedHost)

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    const restoreClipboard = await preserveSystemClipboard(electronApp)
    try {
      await callBrowserTool(window, 'main', 'browser_fill', { uid: snapshotUid(snapshot, 'textbox', 'Draft'), value: 'guest clipboard 中文𠮷🙂' })
      await callBrowserTool(window, 'main', 'browser_press_key', { key: `${modifier}+A` })
      await callBrowserTool(window, 'main', 'browser_press_key', { key: `${modifier}+C` })
      expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe('guest clipboard 中文𠮷🙂')
      await callBrowserTool(window, 'main', 'browser_press_key', { key: `${modifier}+X` })
      expect(await executeBrowser(window, viewId, 'document.querySelector("#draft").value')).toBe('')
      await callBrowserTool(window, 'main', 'browser_press_key', { key: `${modifier}+V` })
      expect(await executeBrowser(window, viewId, 'document.querySelector("#draft").value')).toBe('guest clipboard 中文𠮷🙂')
      await callBrowserTool(window, 'main', 'browser_press_key', { key: `${modifier}+Z` })
      expect(await executeBrowser(window, viewId, 'document.querySelector("#draft").value')).toBe('')
      expect(await hostState()).toEqual(expectedHost)
    } finally {
      await restoreClipboard()
    }

    const workDir = await electronApp.evaluate(() => process.env.HALO_DATA_DIR!)
    const script = path.join(workDir, 'carrier-focus.js')
    await callBrowserTool(window, 'main', 'browser_fill', { uid: snapshotUid(snapshot, 'textbox', 'Notes'), value: 'replacement\n中文𠮷🙂' })
    fs.writeFileSync(script, 'async () => { document.querySelector("#notes").focus(); return document.activeElement.id }')
    expect(toolText(await callBrowserTool(window, 'main', 'browser_run', { file: script }))).toContain('notes')
    await callBrowserTool(window, 'main', 'browser_press_key', { key: 'End' })
    await callBrowserTool(window, 'main', 'browser_press_key', { key: 'Backspace' })
    expect(await executeBrowser(window, viewId, 'document.querySelector("#notes").value')).toBe('replacement\n中文𠮷')
    expect(await hostState()).toEqual(expectedHost)
  })

  test('the production drag tool dispatches a complete trusted gesture into the parked guest', async ({ window, browserSite }) => {
    const opened = await callBrowserTool(window, 'main', 'browser_navigate', { url: browserSite.pageUrl('native-drag') })
    const viewId = opened.viewId!
    await executeBrowser(window, viewId, `
      document.body.insertAdjacentHTML('beforeend', '<button id="drag-source" style="position:fixed;left:20px;top:180px">Drag source</button><button id="drag-target" style="position:fixed;left:280px;top:180px">Drag target</button>');
      window.carrierGesture = [];
      document.addEventListener('mousedown', event => carrierGesture.push({ type: event.type, target: event.target.id, trusted: event.isTrusted, buttons: event.buttons }));
      document.addEventListener('mouseup', event => carrierGesture.push({ type: event.type, target: event.target.id, trusted: event.isTrusted, buttons: event.buttons })); true
    `)
    const snapshot = toolText(await callBrowserTool(window, 'main', 'browser_snapshot'))
    await callBrowserTool(window, 'main', 'browser_click', { uid: snapshotUid(snapshot, 'button', 'Drag source'), dragTo: snapshotUid(snapshot, 'button', 'Drag target') })
    expect(await executeBrowser(window, viewId, 'carrierGesture')).toEqual([
      { type: 'mousedown', target: 'drag-source', trusted: true, buttons: 1 },
      { type: 'mouseup', target: 'drag-target', trusted: true, buttons: 0 },
    ])
    expect(await executeBrowser(window, viewId, 'document.querySelector("#drag-target").matches(":active")')).toBe(false)
  })

  test('guest keydown cancellation suppresses editing defaults without touching the host editor', async ({ electronApp, window, browserSite }) => {
    const opened = await callBrowserTool(window, 'main', 'browser_navigate', { url: browserSite.pageUrl('cancel-shortcuts') })
    const viewId = opened.viewId!
    await executeBrowser(window, viewId, `
      const draft = document.querySelector('#draft'); draft.value = 'ABCDE'; draft.focus(); draft.setSelectionRange(2, 2);
      window.carrierCancelledKeys = []; window.carrierCancelledInput = 0;
      document.addEventListener('input', () => carrierCancelledInput++);
      document.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && ['a','c','v'].includes(event.key.toLowerCase())) {
          event.preventDefault(); carrierCancelledKeys.push({ key: event.key.toLowerCase(), trusted: event.isTrusted });
        }
      }); true
    `)
    await window.evaluate(() => {
      const editor = document.createElement('input'); editor.id = 'host-cancel-editor'; editor.value = 'host draft'; document.body.appendChild(editor); editor.focus(); editor.setSelectionRange(4, 4)
    })
    const restoreClipboard = await preserveSystemClipboard(electronApp)
    try {
      await electronApp.evaluate(({ clipboard }) => clipboard.writeText('clipboard must remain unchanged'))
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
      for (const key of ['A', 'C', 'V']) await callBrowserTool(window, 'main', 'browser_press_key', { key: `${modifier}+${key}` })
      expect(await executeBrowser(window, viewId, `({ value: document.querySelector('#draft').value, start: document.querySelector('#draft').selectionStart, end: document.querySelector('#draft').selectionEnd, inputs: carrierCancelledInput, keys: carrierCancelledKeys })`)).toEqual({
        value: 'ABCDE', start: 2, end: 2, inputs: 0,
        keys: [{ key: 'a', trusted: true }, { key: 'c', trusted: true }, { key: 'v', trusted: true }],
      })
      expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe('clipboard must remain unchanged')
      expect(await window.evaluate(() => {
        const editor = document.querySelector('#host-cancel-editor') as HTMLInputElement
        return { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd, active: document.activeElement?.id }
      })).toEqual({ value: 'host draft', start: 4, end: 4, active: 'host-cancel-editor' })
    } finally {
      await restoreClipboard()
    }
  })

  test('clipboard paste preserves rich content and lets the guest paste handler cancel insertion', async ({ electronApp, window, browserSite }) => {
    const opened = await callBrowserTool(window, 'main', 'browser_navigate', { url: browserSite.pageUrl('paste-formats') })
    const viewId = opened.viewId!
    await executeBrowser(window, viewId, `
      document.body.insertAdjacentHTML('beforeend', '<div id="rich-editor" role="textbox" aria-label="Rich editor" contenteditable="true" style="position:fixed;left:10px;top:180px">initial</div>');
      const editor = document.querySelector('#rich-editor'); editor.focus(); document.execCommand('selectAll');
      window.carrierPastes = []; window.carrierPasteInputs = []; window.carrierPreventPaste = false;
      editor.addEventListener('paste', event => { carrierPastes.push({ text: event.clipboardData.getData('text/plain'), html: event.clipboardData.getData('text/html'), trusted: event.isTrusted, files: Array.from(event.clipboardData.files).map(file => ({ type: file.type, size: file.size })) }); if (carrierPreventPaste) event.preventDefault() });
      editor.addEventListener('input', event => carrierPasteInputs.push({ trusted: event.isTrusted, inputType: event.inputType })); true
    `)
    await window.evaluate(() => {
      const editor = document.createElement('input'); editor.id = 'host-paste-editor'; editor.value = 'host paste draft'; document.body.appendChild(editor); editor.focus(); editor.setSelectionRange(3, 8)
    })
    const restoreClipboard = await preserveSystemClipboard(electronApp)
    try {
      await electronApp.evaluate(({ clipboard, nativeImage }) => {
        const image = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 })
        if (image.isEmpty()) throw new Error('Clipboard image fixture did not decode')
        clipboard.write({ text: 'rich 中文𠮷🙂', html: '<strong>rich 中文𠮷🙂</strong>', image })
      })
      const key = `${process.platform === 'darwin' ? 'Meta' : 'Control'}+V`
      await callBrowserTool(window, 'main', 'browser_press_key', { key })
      const pasted = await executeBrowser<{ text: string; html: string; pastes: Array<{ text: string; html: string; trusted: boolean; files: Array<{ type: string; size: number }> }>; inputs: Array<{ trusted: boolean }> }>(window, viewId, `({ text: document.querySelector('#rich-editor').textContent, html: document.querySelector('#rich-editor').innerHTML, pastes: carrierPastes, inputs: carrierPasteInputs })`)
      expect(pasted.text).toBe('rich 中文𠮷🙂')
      expect(pasted.html).toMatch(/<strong[^>]*>rich 中文𠮷🙂<\/strong>/)
      expect(pasted.pastes).toHaveLength(1)
      expect(pasted.pastes[0].text).toBe('rich 中文𠮷🙂')
      expect(pasted.pastes[0].html).toContain('<strong>rich 中文𠮷🙂</strong>')
      expect(pasted.pastes[0].trusted).toBe(process.platform !== 'darwin')
      expect(pasted.pastes[0].files).toHaveLength(1)
      expect(pasted.pastes[0].files[0].type).toBe('image/png')
      expect(pasted.pastes[0].files[0].size).toBeGreaterThan(0)
      expect(pasted.inputs.length).toBeGreaterThan(0)
      expect(pasted.inputs.every(event => event.trusted)).toBe(true)
      await executeBrowser(window, viewId, `carrierPreventPaste = true; carrierPasteInputs = []; document.querySelector('#rich-editor').focus(); document.execCommand('selectAll'); true`)
      await callBrowserTool(window, 'main', 'browser_press_key', { key })
      expect(await executeBrowser(window, viewId, `({ text: document.querySelector('#rich-editor').textContent, pasteCount: carrierPastes.length, inputs: carrierPasteInputs.length })`)).toEqual({ text: 'rich 中文𠮷🙂', pasteCount: 2, inputs: 0 })
      expect(await window.evaluate(() => {
        const editor = document.querySelector('#host-paste-editor') as HTMLInputElement
        return { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd, active: document.activeElement?.id }
      })).toEqual({ value: 'host paste draft', start: 3, end: 8, active: 'host-paste-editor' })
    } finally {
      await restoreClipboard()
    }
  })

  test('guest editing shortcuts and paste handlers operate inside a focused iframe', async ({ electronApp, window, browserSite }) => {
    const opened = await callBrowserTool(window, 'main', 'browser_navigate', { url: browserSite.pageUrl('frame-editing') })
    const viewId = opened.viewId!
    await executeBrowser(window, viewId, `
      const frame = document.createElement('iframe'); frame.id = 'editing-frame'; frame.srcdoc = '<input id="nested-input" value="iframe draft 中文𠮷🙂">'; document.body.appendChild(frame); true
    `)
    await expect.poll(() => executeBrowser(window, viewId, `!!document.querySelector('#editing-frame').contentDocument.querySelector('#nested-input')`)).toBe(true)
    await executeBrowser(window, viewId, `
      const input = document.querySelector('#editing-frame').contentDocument.querySelector('#nested-input');
      const owner = input.ownerDocument.defaultView; owner.carrierPaste = null;
      input.addEventListener('paste', event => { owner.carrierPaste = { localEvent: event instanceof owner.ClipboardEvent, localTransfer: event.clipboardData instanceof owner.DataTransfer, text: event.clipboardData.getData('text/plain') } });
      input.focus(); input.setSelectionRange(input.value.length, input.value.length); true
    `)
    await window.evaluate(() => {
      const editor = document.createElement('input'); editor.id = 'host-frame-editor'; editor.value = 'host iframe draft'; document.body.appendChild(editor); editor.focus(); editor.setSelectionRange(4, 4)
    })
    const restoreClipboard = await preserveSystemClipboard(electronApp)
    try {
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
      await callBrowserTool(window, 'main', 'browser_press_key', { key: `${modifier}+A` })
      await callBrowserTool(window, 'main', 'browser_press_key', { key: `${modifier}+C` })
      expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe('iframe draft 中文𠮷🙂')
      await callBrowserTool(window, 'main', 'browser_press_key', { key: `${modifier}+X` })
      expect(await executeBrowser(window, viewId, `document.querySelector('#editing-frame').contentDocument.querySelector('#nested-input').value`)).toBe('')
      await callBrowserTool(window, 'main', 'browser_press_key', { key: `${modifier}+V` })
      expect(await executeBrowser(window, viewId, `document.querySelector('#editing-frame').contentDocument.querySelector('#nested-input').value`)).toBe('iframe draft 中文𠮷🙂')
      expect(await executeBrowser(window, viewId, `document.querySelector('#editing-frame').contentWindow.carrierPaste`)).toEqual({ localEvent: true, localTransfer: true, text: 'iframe draft 中文𠮷🙂' })
      expect(await window.evaluate(() => {
        const editor = document.querySelector('#host-frame-editor') as HTMLInputElement
        return { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd, active: document.activeElement?.id }
      })).toEqual({ value: 'host iframe draft', start: 4, end: 4, active: 'host-frame-editor' })
    } finally { await restoreClipboard() }
  })

  test('the clipboard fixture restores native custom formats and their original bytes', async ({ electronApp, window }) => {
    await window.waitForLoadState('domcontentloaded')
    const restoreOriginal = await preserveSystemClipboard(electronApp)
    try {
      await electronApp.evaluate(({ clipboard }) => clipboard.writeBuffer('com.halo.carrier.custom', Buffer.from('custom clipboard fixture')))
      const restoreCustom = await preserveSystemClipboard(electronApp, ['com.halo.carrier.custom'])
      try { await electronApp.evaluate(({ clipboard }) => clipboard.writeText('temporary standard text')) }
      finally { await restoreCustom() }
      expect(await electronApp.evaluate(({ clipboard }) => clipboard.readBuffer('com.halo.carrier.custom').toString())).toBe('custom clipboard fixture')
      expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe('')
    } finally { await restoreOriginal() }
  })

  for (const originKind of ['different-port', 'cross-site'] as const) {
    test(`${originKind} iframe receives trusted keyboard editing while the host editor keeps its native input`, async ({ electronApp, window, browserSite }) => {
      const parentUrl = browserSite.pageUrl(`iframe-${originKind}`)
      const opened = await callBrowserTool(window, 'main', 'browser_navigate', { url: parentUrl })
      await expect.poll(() => guestIdentity(electronApp, parentUrl)).toBeGreaterThan(0)
      const parentId = await guestIdentity(electronApp, parentUrl)
      const childServer = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(browserHtmlFixture()) })
      await new Promise<void>(resolve => childServer.listen(0, '127.0.0.1', resolve))
      const hostname = originKind === 'cross-site' ? 'localhost' : '127.0.0.1'
      const childUrl = `http://${hostname}:${(childServer.address() as { port: number }).port}/child`
      let restoreClipboard: (() => Promise<void>) | undefined
      try {
        await executeBrowser(window, opened.viewId!, `const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(childUrl)}; frame.style = 'position:fixed;left:10px;top:180px;width:450px;height:250px'; document.body.appendChild(frame); true`)
        const childValue = (script: string) => electronApp.evaluate(async ({ webContents }, { parentId, childUrl, script }) => {
          const frame = webContents.fromId(parentId)!.mainFrame.frames.find(frame => frame.url === childUrl)
          return frame ? await frame.executeJavaScript(script) : null
        }, { parentId, childUrl, script })
        await expect.poll(() => childValue("!!document.querySelector('#draft')"), { timeout: 20000 }).toBe(true)
        await childValue(`
          const form = document.querySelector('#form'); form.insertAdjacentHTML('beforeend', '<input id="next"><button type="submit">Submit</button>');
          window.carrierKeys = []; window.carrierPaste = null;
          for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => carrierKeys.push({ type, key: event.key.toLowerCase(), trusted: event.isTrusted }));
          const input = document.querySelector('#draft'); input.value = 'cross frame draft'; input.focus(); input.setSelectionRange(input.value.length, input.value.length);
          input.addEventListener('paste', event => { carrierPaste = { localEvent: event instanceof ClipboardEvent, localTransfer: event.clipboardData instanceof DataTransfer, text: event.clipboardData.getData('text/plain') } }); true
        `)
        await window.evaluate(() => {
          const input = document.createElement('input'); input.id = 'cross-host-editor'; input.value = 'host frame draft'; document.body.appendChild(input); input.focus(); input.setSelectionRange(2, 5)
        })
        await callBrowserTool(window, 'main', 'browser_press_key', { key: 'Backspace' })
        expect(await childValue(`({ value: document.querySelector('#draft').value, keys: carrierKeys })`)).toEqual({
          value: 'cross frame draf', keys: [{ type: 'keydown', key: 'backspace', trusted: true }, { type: 'keyup', key: 'backspace', trusted: true }],
        })
        await callBrowserTool(window, 'main', 'browser_press_key', { key: 'Enter' })
        expect(await childValue('submitted')).toBe(1)
        await callBrowserTool(window, 'main', 'browser_press_key', { key: 'Tab' })
        expect(await childValue('document.activeElement.id')).toBe('next')
        await callBrowserTool(window, 'main', 'browser_press_key', { key: 'Shift+Tab' })
        expect(await childValue('document.activeElement.id')).toBe('draft')
        restoreClipboard = await preserveSystemClipboard(electronApp)
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
        for (const key of ['A', 'C']) await callBrowserTool(window, 'main', 'browser_press_key', { key: `${modifier}+${key}` })
        expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe('cross frame draf')
        await callBrowserTool(window, 'main', 'browser_press_key', { key: `${modifier}+X` })
        expect(await childValue(`document.querySelector('#draft').value`)).toBe('')
        await callBrowserTool(window, 'main', 'browser_press_key', { key: `${modifier}+V` })
        expect(await childValue(`({ value: document.querySelector('#draft').value, paste: carrierPaste, keys: carrierKeys })`)).toMatchObject({ value: 'cross frame draf', paste: { localEvent: true, localTransfer: true, text: 'cross frame draf' } })
        const keys = await childValue('carrierKeys') as Array<{ type: string; key: string; trusted: boolean }>
        expect(keys).toHaveLength(16)
        expect(keys.every(event => event.trusted)).toBe(true)
        expect(await window.evaluate(() => {
          const input = document.querySelector('#cross-host-editor') as HTMLInputElement
          return { value: input.value, start: input.selectionStart, end: input.selectionEnd, active: document.activeElement?.id }
        })).toEqual({ value: 'host frame draft', start: 2, end: 5, active: 'cross-host-editor' })
        await window.keyboard.type(' continues')
        await expect(window.locator('#cross-host-editor')).toHaveValue('host frame draft'.slice(0, 2) + ' continues' + 'host frame draft'.slice(5))
        expect(await childValue(`document.querySelector('#draft').value`)).toBe('cross frame draf')
      } finally {
        try { if (restoreClipboard) await restoreClipboard() }
        finally { childServer.closeAllConnections(); await new Promise<void>(resolve => childServer.close(() => resolve())) }
      }
    })
  }

  test('Enter completes a real form navigation without leaving pressed input or taking host focus', async ({ electronApp, window, browserSite }) => {
    const initial = browserSite.pageUrl('enter-navigation')
    const opened = await callBrowserTool(window, 'main', 'browser_navigate', { url: initial })
    await expect.poll(() => guestIdentity(electronApp, initial)).toBeGreaterThan(0)
    const id = await guestIdentity(electronApp, initial)
    const destination = `${browserSite.origin}/submitted?draft=go`
    await executeBrowser(window, opened.viewId!, `
      const old = document.querySelector('#form'); const form = old.cloneNode(false); old.replaceWith(form);
      form.action = ${JSON.stringify(`${browserSite.origin}/submitted`)}; form.method = 'get';
      form.innerHTML = '<input id="draft" name="draft" value="go"><button type="submit">Submit</button>'; document.querySelector('#draft').focus(); true
    `)
    await window.evaluate(() => {
      const input = document.createElement('input'); input.id = 'host-submit-editor'; input.value = 'host submit draft'; document.body.appendChild(input); input.focus(); input.setSelectionRange(4, 4)
    })
    await callBrowserTool(window, 'main', 'browser_press_key', { key: 'Enter' })
    await expect.poll(() => guestIdentity(electronApp, destination)).toBe(id)
    expect(await executeBrowser(window, opened.viewId!, 'location.href')).toBe(destination)
    expect(await window.evaluate(() => {
      const input = document.querySelector('#host-submit-editor') as HTMLInputElement
      return { value: input.value, start: input.selectionStart, end: input.selectionEnd, active: document.activeElement?.id }
    })).toEqual({ value: 'host submit draft', start: 4, end: 4, active: 'host-submit-editor' })
  })

  test('printable punctuation completes trusted native key pairs and function keys do not insert their names', async ({ window, browserSite }) => {
    const opened = await callBrowserTool(window, 'main', 'browser_navigate', { url: browserSite.pageUrl('punctuation-key') })
    await executeBrowser(window, opened.viewId!, `
      window.carrierKeys = [];
      document.addEventListener('keydown', event => { carrierKeys.push({ type: event.type, key: event.key, code: event.code, shift: event.shiftKey, trusted: event.isTrusted }); if (event.key === 'F1') event.preventDefault() });
      document.addEventListener('keyup', event => carrierKeys.push({ type: event.type, key: event.key, code: event.code, shift: event.shiftKey, trusted: event.isTrusted }));
      document.querySelector('#draft').focus(); true
    `)
    await callBrowserTool(window, 'main', 'browser_press_key', { key: '%' })
    expect(await executeBrowser(window, opened.viewId!, `document.querySelector('#draft').value`)).toBe('%')
    expect(await executeBrowser(window, opened.viewId!, 'carrierKeys')).toEqual([
      { type: 'keydown', key: '%', code: 'Digit5', shift: true, trusted: true },
      { type: 'keyup', key: '%', code: 'Digit5', shift: true, trusted: true },
    ])
    await callBrowserTool(window, 'main', 'browser_press_key', { key: 'F1' })
    expect(await executeBrowser(window, opened.viewId!, `document.querySelector('#draft').value`)).toBe('%')
  })

  test('an input operation stays on its original page while the context selects another page', async ({ window, browserSite }) => {
    const first = await callBrowserTool(window, 'main', 'browser_navigate', { url: browserSite.pageUrl('input-first') })
    const second = await callBrowserTool(window, 'main', 'browser_tab', { action: 'new', url: browserSite.pageUrl('input-second') })
    await callBrowserTool(window, 'main', 'browser_tab', { action: 'select', pageIdx: 0 })
    const snapshot = toolText(await callBrowserTool(window, 'main', 'browser_snapshot'))
    const outcome = await window.evaluate(async uid => {
      const runtime = (window as unknown as { browserTest: { tool: (kind: string, name: string, args: Record<string, unknown>) => Promise<BrowserToolOutcome> } }).browserTest
      const filling = runtime.tool('main', 'browser_fill', { uid, value: 'only first page' })
      const selected = await runtime.tool('main', 'browser_tab', { action: 'select', pageIdx: 1 })
      return { filled: await filling, selected }
    }, snapshotUid(snapshot, 'textbox', 'Draft'))
    expect(outcome.filled.result.isError).not.toBe(true)
    expect(outcome.selected.viewId).toBe(second.viewId)
    expect(await executeBrowser(window, first.viewId!, `document.querySelector('#draft').value`)).toBe('only first page')
    expect(await executeBrowser(window, second.viewId!, `document.querySelector('#draft').value`)).toBe('')
  })

  test('a screenshot keeps its original page pixels while the context selects another tab', async ({ electronApp, window, browserSite }, testInfo) => {
    const first = await callBrowserTool(window, 'main', 'browser_navigate', { url: browserSite.pageUrl('capture-first') })
    await executeBrowser(window, first.viewId!, 'document.body.style.background = "#ff6600"; true')
    const second = await callBrowserTool(window, 'main', 'browser_tab', { action: 'new', url: browserSite.pageUrl('capture-second') })
    await callBrowserTool(window, 'main', 'browser_tab', { action: 'select', pageIdx: 0 })
    const outcome = await window.evaluate(async () => {
      const runtime = (window as unknown as { browserTest: { tool: (kind: string, name: string, args: Record<string, unknown>) => Promise<BrowserToolOutcome> } }).browserTest
      const capturing = runtime.tool('main', 'browser_screenshot', {})
      const selected = await runtime.tool('main', 'browser_tab', { action: 'select', pageIdx: 1 })
      return { captured: await capturing, selected }
    })
    expect(outcome.captured.result.isError).not.toBe(true)
    expect(outcome.selected.viewId).toBe(second.viewId)
    const image = outcome.captured.result.content.find(item => item.type === 'image')
    expect(image?.data).toBeTruthy()
    await testInfo.attach('captured-original-page', { body: Buffer.from(image!.data!, 'base64'), contentType: 'image/jpeg' })
    const pixels = await browserFrameColors(window, image!.data!)
    expect(pixels.orange, JSON.stringify(pixels)).toBeGreaterThan(10000)
    expect(pixels.blue).toBeLessThan(100)
  })

  test('releasing a context while input awaits its frame prevents late input and guest revival', async ({ electronApp, window, browserSite }) => {
    const url = browserSite.pageUrl('released-input')
    const opened = await callBrowserTool(window, 'human', 'browser_navigate', { url })
    const snapshot = toolText(await callBrowserTool(window, 'human', 'browser_snapshot'))
    const outcome = await window.evaluate(async uid => {
      const runtime = (window as unknown as { browserTest: { tool: (kind: string, name: string, args: Record<string, unknown>) => Promise<BrowserToolOutcome>; release: (kind: string) => Promise<unknown> } }).browserTest
      const filling = runtime.tool('human', 'browser_fill', { uid, value: 'must be cancelled' })
      await runtime.release('human')
      return await filling
    }, snapshotUid(snapshot, 'textbox', 'Draft'))
    expect(outcome.result.isError).toBe(true)
    expect(toolText(outcome)).toMatch(/closed|released|destroyed|No active browser page/i)
    await expect.poll(() => guestIdentity(electronApp, url)).toBe(0)
    const state = await window.evaluate(async viewId => (window as unknown as { halo: HaloAPI }).halo.getBrowserState(viewId), opened.viewId!)
    expect(state).toMatchObject({ success: true, data: null })
  })

  test('browser pages, standalone login and silent AI downloads share the configured session proxy', async ({ electronApp, window }) => {
    const requests: string[] = []
    const proxy = createServer((request, response) => {
      const url = new URL(request.url!, 'http://carrier-proxy.invalid')
      requests.push(url.href)
      if (url.pathname === '/download') {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="proxy-carrier.txt"' })
        response.end('Proxy download fixture\n')
        return
      }
      if (url.pathname === '/login') response.setHeader('set-cookie', 'carrier-proxy-login=shared; Path=/; SameSite=Lax')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(browserHtmlFixture().replace('crypto.randomUUID()', '"proxy-document"'))
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const port = (proxy.address() as { port: number }).port
    try {
      await electronApp.evaluate(async ({ session }, port) => {
        const browser = session.fromPartition('persist:browser')
        await browser.setProxy({ proxyRules: `http=127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' })
        await browser.closeAllConnections()
      }, port)
      const opened = await callBrowserTool(window, 'main', 'browser_navigate', { url: 'http://carrier-proxy.invalid/page' })
      expect(opened.viewId).not.toBeNull()
      expect(await executeBrowser(window, opened.viewId!, 'document.title')).toBe('Carrier regression page')
      expect(await window.evaluate(async () => (window as unknown as { halo: HaloAPI }).halo.openLoginWindow('http://carrier-proxy.invalid/login'))).toMatchObject({ success: true })
      await expect.poll(() => executeBrowser<string>(window, opened.viewId!, 'document.cookie')).toContain('carrier-proxy-login=shared')
      const downloaded = await callBrowserTool(window, 'main', 'browser_download', { url: 'http://carrier-proxy.invalid/download' })
      expect(toolText(downloaded)).toContain('Download completed:')
      const savePath = toolText(downloaded).match(/Path: (.+)/)![1]
      expect(fs.readFileSync(savePath, 'utf8')).toBe('Proxy download fixture\n')
      expect(requests).toEqual(expect.arrayContaining(['http://carrier-proxy.invalid/page', 'http://carrier-proxy.invalid/login', 'http://carrier-proxy.invalid/download']))
    } finally {
      await electronApp.evaluate(async ({ session }) => { await session.fromPartition('persist:browser').setProxy({ mode: 'direct' }) })
      proxy.closeAllConnections()
      await new Promise<void>(resolve => proxy.close(() => resolve()))
    }
  })
})

test.describe('production browser policy', () => {
  test.use({ browserPolicy: { mode: 'allowlist', allowlist: ['127.0.0.1'], userExtensible: true } })
  test.setTimeout(90000)

  test('blocks initial creation, page navigation, redirects and popups without replacing the allowed guest', async ({ electronApp, window, browserSite }) => {
    const blocked = `${browserSite.origin.replace('127.0.0.1', 'localhost')}/page?case=blocked`
    const rejected = await window.evaluate(async url => (window as unknown as { halo: HaloAPI }).halo.createBrowserView('blocked-initial', url), blocked)
    expect(rejected).toMatchObject({ success: false, code: 'BROWSER_POLICY_BLOCKED' })
    const opened = await callBrowserTool(window, 'main', 'browser_navigate', { url: browserSite.pageUrl('allowed') })
    const viewId = opened.viewId!
    await expect.poll(() => guestIdentity(electronApp, browserSite.pageUrl('allowed'))).toBeGreaterThan(0)
    const id = await guestIdentity(electronApp, browserSite.pageUrl('allowed'))
    const readState = () => window.evaluate(async viewId => (await (window as unknown as { halo: HaloAPI }).halo.getBrowserState(viewId)).data, viewId)
    for (const kind of ['page', 'redirect', 'popup']) {
      await test.step(`${kind} navigation respects the allowlist`, async () => {
        const allowed = browserSite.pageUrl(`allowed-${kind}`)
        expect(await window.evaluate(async ({ viewId, url }) => (window as unknown as { halo: HaloAPI }).halo.navigateBrowserView(viewId, url), { viewId, url: allowed })).toMatchObject({ success: true })
        await expect.poll(readState).toMatchObject({ url: allowed, isLoading: false, blockedByPolicy: false })
        expect(await executeBrowser(window, viewId, 'document.readyState')).toBe('complete')
        if (kind === 'page') await executeBrowser(window, viewId, `location.href = ${JSON.stringify(blocked)}`)
        if (kind === 'popup') await executeBrowser(window, viewId, `window.open(${JSON.stringify(blocked)}, '_blank'); true`)
        if (kind === 'redirect') {
          const redirect = `${browserSite.origin}/redirect?target=${encodeURIComponent(blocked)}`
          await window.evaluate(async ({ viewId, url }) => (window as unknown as { halo: HaloAPI }).halo.navigateBrowserView(viewId, url), { viewId, url: redirect })
        }
        await expect.poll(readState).toMatchObject({ blockedByPolicy: true, blockedUrl: blocked })
        expect(await electronApp.evaluate(({ webContents }, id) => !!webContents.fromId(id), id)).toBe(true)
        expect(await electronApp.evaluate(({ webContents }, blocked) => webContents.getAllWebContents().some(contents => contents.getURL() === blocked), blocked)).toBe(false)
      })
    }
    const changed = await window.evaluate(async () => (window as unknown as { halo: HaloAPI }).halo.addBrowserAllowlistEntry('localhost'))
    expect(changed).toMatchObject({ success: true })
    expect(await window.evaluate(async ({ viewId, url }) => (window as unknown as { halo: HaloAPI }).halo.navigateBrowserView(viewId, url), { viewId, url: blocked })).toMatchObject({ success: true })
    await expect.poll(() => guestIdentity(electronApp, blocked)).toBe(id)
    await expect.poll(readState).toMatchObject({ blockedByPolicy: false })
  })
})
