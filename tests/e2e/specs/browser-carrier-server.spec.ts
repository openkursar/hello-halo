import fs from 'node:fs'
import type { ElectronApplication } from '@playwright/test'
import { test, expect, toolText, type BrowserToolOutcome, type ContextKind } from '../fixtures/browser-runtime'
import type { BrowserServerRuntimeDriver } from '../fixtures/browser-server-runtime-main'
import { browserGuestFrameColors } from '../fixtures/image-pixels'

async function serverTool(app: ElectronApplication, kind: ContextKind, name: string, args: Record<string, unknown> = {}): Promise<BrowserToolOutcome> {
  const result = await app.evaluate(async (_electron, { kind, name, args }) => (globalThis as unknown as { browserServerTest: BrowserServerRuntimeDriver }).browserServerTest.tool(kind, name, args), { kind, name, args })
  expect(result.result, `server ${kind} ${name} must execute its production handler`).not.toMatchObject({ isError: true })
  return result
}

test.describe('server-mode browser guests', () => {
  test.use({ browserServerMode: true })
  test.setTimeout(120000)

  test('actual headless boot runs watchable contexts, silent automation and temporary search without a main window', async ({ electronApp, browserSite }) => {
    await expect.poll(() => electronApp.evaluate(() => {
      const driver = (globalThis as unknown as { browserServerTest: BrowserServerRuntimeDriver }).browserServerTest
      return { ready: driver.ready, error: driver.error }
    }), { timeout: 30000 }).toEqual({ ready: true, error: '' })
    const state = () => electronApp.evaluate(() => (globalThis as unknown as { browserServerTest: BrowserServerRuntimeDriver }).browserServerTest.state())
    const initial = await state()
    expect(initial.serverMode).toBe(true)
    expect(initial.mainWindow).toBeNull()
    expect(initial.remote.enabled).toBe(true)
    expect(initial.remote.port).toBeGreaterThan(0)
    expect(initial.windows.every(window => !window.visible)).toBe(true)

    for (const kind of ['main', 'human', 'automation'] as ContextKind[]) {
      const opened = await serverTool(electronApp, kind, 'browser_navigate', { url: browserSite.pageUrl(`server-${kind}`) })
      expect(opened.viewId).not.toBeNull()
      const snapshot = toolText(await serverTool(electronApp, kind, 'browser_snapshot'))
      const uid = snapshot.split('\n').find(line => line.includes('textbox "Draft"'))?.match(/uid=(\S+)/)?.[1]
      expect(uid).toBeTruthy()
      const value = `headless ${kind} 中文𠮷🙂`
      await serverTool(electronApp, kind, 'browser_fill', { uid, value })
      expect(toolText(await serverTool(electronApp, kind, 'browser_evaluate', { function: '() => document.querySelector("#draft").value' }))).toContain(value)
      const capture = await serverTool(electronApp, kind, 'browser_screenshot')
      const data = capture.result.content.find(item => item.type === 'image')?.data
      expect(data).toBeTruthy()
      const guest = (await state()).guests.find(guest => guest.id === opened.viewId)
      expect(guest).toBeTruthy()
      const painted = await browserGuestFrameColors(electronApp, guest!.contentsId, data!)
      expect(painted.width).toBeGreaterThan(100)
      expect(painted.blue).toBeGreaterThan(10000)
      const current = await state()
      expect(current.mainWindow).toBeNull()
      expect(current.windows.every(window => !window.visible)).toBe(true)
      expect(current.guests.every(guest => !guest.hostVisible && guest.frameLeaseId === undefined)).toBe(true)
      expect(current.hasUi.find(owner => owner.kind === kind)?.hasUi).toBe(kind !== 'automation')
    }

    const download = await serverTool(electronApp, 'automation', 'browser_download', { url: `${browserSite.origin}/download` })
    const saved = toolText(download).match(/Path: (.+)/)?.[1]
    expect(saved).toBeTruthy()
    expect(fs.readFileSync(saved!, 'utf8')).toBe('Carrier download fixture\n')
    const beforeSearch = (await state()).guests.map(guest => guest.contentsId).sort()
    const search = await electronApp.evaluate(async (_electron, origin) => (globalThis as unknown as { browserServerTest: BrowserServerRuntimeDriver }).browserServerTest.search(origin), browserSite.origin)
    expect(search.blocked).toBeUndefined()
    expect(search.results).toContainEqual(expect.objectContaining({ title: 'Carrier search result', url: `${browserSite.origin}/carrier-search-result` }))
    const afterSearch = await state()
    expect(afterSearch.guests.map(guest => guest.contentsId).sort()).toEqual(beforeSearch)
    expect(afterSearch.pages.some(page => page.id.startsWith('web-search-'))).toBe(false)
    expect(afterSearch.windows.every(window => !window.visible)).toBe(true)
    expect(afterSearch.guests.every(guest => guest.frameLeaseId === undefined)).toBe(true)

    await electronApp.evaluate(() => {
      const driver = (globalThis as unknown as { browserServerTest: BrowserServerRuntimeDriver }).browserServerTest
      for (const kind of ['main', 'human', 'automation'] as const) driver.release(kind)
      driver.closePages()
    })
    const finished = await state()
    expect(finished.mainWindow).toBeNull()
    expect(finished.guests).toEqual([])
    expect(finished.pages).toEqual([])
    expect(finished.webContents.some(contents => contents.type === 'webview')).toBe(false)
  })
})
