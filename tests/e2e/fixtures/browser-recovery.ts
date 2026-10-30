import fs from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import {
  cleanupTestConfigDir, createTestConfigDir, getAppEntryPath, launchElectronApp,
} from './electron'
import { test as browserTest, expect, guestIdentity } from './browser-site'
import { clickArtifactByName } from '../../perf/lib/open-artifact'

const LOCAL_HTML = '<!doctype html><html><head><title>Local browser entry</title></head><body><p>Local browser entry</p></body></html>'
export const RECOVERY_FILES = { original: 'browser-original.html', fresh: 'browser-fresh.html', modal: 'browser-modal.txt' }
export const MODAL_CONTENT = 'Browser modal fixture\n'

async function attachNativeFailure(app: ElectronApplication, info: TestInfo): Promise<void> {
  const observed = await app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed() && candidate.isVisible())
    if (!main) return { window: null, dom: null, image: null }
    const bounded = async <T,>(operation: Promise<T>, label: string): Promise<{ value: T } | { error: string }> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          operation.then(value => ({ value }), error => ({ error: error instanceof Error ? error.message : String(error) })),
          new Promise<{ error: string }>(resolve => { timer = setTimeout(() => resolve({ error: `${label} did not settle within two seconds` }), 2000) }),
        ])
      } finally { clearTimeout(timer) }
    }
    const contents = main.webContents
    const [dom, image] = await Promise.all([
      bounded(contents.executeJavaScript(`(() => {
        const describe = element => {
          if (!element) return null;
          const style = getComputedStyle(element);
          return { tag: element.tagName, id: element.id, className: element.getAttribute('class'), rect: element.getBoundingClientRect().toJSON(),
            style: Object.fromEntries(['position', 'left', 'top', 'width', 'height', 'display', 'visibility', 'opacity', 'transform', 'transformOrigin', 'zoom', 'pointerEvents', 'zIndex', 'overflowX', 'overflowY'].map(key => [key, style[key]])),
            animations: element.getAnimations().map(animation => ({ name: animation.animationName, playState: animation.playState, currentTime: animation.currentTime, timing: animation.effect?.getComputedTiming() })) };
        };
        const ancestors = element => { const chain = []; for (let node = element; node; node = node.parentElement) chain.push(describe(node)); return chain; };
        const input = document.querySelector('input[placeholder^="Enter URL"]');
        const surface = input?.closest('form')?.parentElement?.parentElement?.lastElementChild;
        return { readyState: document.readyState, focus: document.hasFocus(), activeElement: describe(document.activeElement),
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, displayScale: getComputedStyle(document.documentElement).getPropertyValue('--display-scale'), visualScale: visualViewport?.scale },
          surface: ancestors(surface), guests: Array.from(document.querySelectorAll('webview')).map(element => ({ ...describe(element), pageId: element.dataset.browserPageId, hidden: element.getAttribute('aria-hidden'), ancestors: ancestors(element.parentElement) })),
          dialogs: Array.from(document.querySelectorAll('[role="alertdialog"], [role="dialog"]')).map(ancestors) };
      })()`), 'Failure DOM observation'),
      bounded(contents.capturePage().then(image => ({ empty: image.isEmpty(), size: image.getSize(), png: image.toPNG().toString('base64') })), 'Failure window capture'),
    ])
    return { window: { id: main.id, webContentsId: contents.id, osProcessId: contents.getOSProcessId(), zoom: contents.getZoomFactor(), focused: main.isFocused(), maximized: main.isMaximized(), fullscreen: main.isFullScreen(), bounds: main.getBounds(), contentBounds: main.getContentBounds() }, dom, image }
  })
  const screenshot = observed.image && 'value' in observed.image ? observed.image.value : null
  if (screenshot?.png) await info.attach('native-failure-window', { body: Buffer.from(screenshot.png, 'base64'), contentType: 'image/png' })
  await info.attach('native-failure-layout', { body: JSON.stringify({ ...observed, image: screenshot ? { empty: screenshot.empty, size: screenshot.size } : observed.image }, null, 2), contentType: 'application/json' })
}

interface RecoveryApplication {
  app: ElectronApplication
  window: Page
  modalPath: string
}

export const test = browserTest.extend<{
  recoveryDisplayScale: number
  recoveryApp: RecoveryApplication
}>({
  recoveryDisplayScale: [1, { option: true }],
  recoveryApp: async ({ recoveryDisplayScale }, use, testInfo) => {
    const entry = getAppEntryPath()
    const profile = createTestConfigDir(entry)
    const configPath = path.join(profile, '.halo', 'config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    config.appearance.displayScale = recoveryDisplayScale
    fs.writeFileSync(configPath, JSON.stringify(config))
    const artifacts = path.join(profile, '.halo', 'temp', 'artifacts')
    for (const name of [RECOVERY_FILES.original, RECOVERY_FILES.fresh]) fs.writeFileSync(path.join(artifacts, name), LOCAL_HTML)
    const modalPath = path.join(artifacts, RECOVERY_FILES.modal)
    fs.writeFileSync(modalPath, MODAL_CONTENT)
    const app = await launchElectronApp(entry, profile)
    const child = app.process()
    await app.context().tracing.start({ screenshots: true, snapshots: true })
    try {
      await use({ app, window: await app.firstWindow(), modalPath })
    } finally {
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          try { await attachNativeFailure(app, testInfo) }
          catch (error) { await testInfo.attach('native-failure-observation-error', { body: error instanceof Error ? error.message : String(error), contentType: 'text/plain' }) }
          const log = path.join(profile, '.halo', 'logs', 'main.log')
          if (fs.existsSync(log)) await testInfo.attach('electron-main-log', { body: fs.readFileSync(log).subarray(-500000), contentType: 'text/plain' })
          const trace = testInfo.outputPath('browser-recovery-trace.zip')
          await app.context().tracing.stop({ path: trace })
          await testInfo.attach('browser-recovery-trace', { path: trace, contentType: 'application/zip' })
        } else {
          await app.context().tracing.stop()
        }
      } finally {
        await app.close()
        await expect.poll(() => child.exitCode, { message: 'The owned application must exit after recovery testing' }).toBe(0)
        cleanupTestConfigDir(profile)
      }
    }
  },
})

export { expect }

export async function openLocalBrowser(window: Page, app: ElectronApplication, fileName: string, url: string): Promise<{ id: number; viewId: string }> {
  await clickArtifactByName(window, fileName)
  const closeSheet = window.getByRole('button', { name: 'Close', exact: true })
  if (await closeSheet.isVisible()) await closeSheet.click()
  await window.getByTitle('Open in browser mode (full render)', { exact: true }).click()
  const address = window.getByPlaceholder(/Enter URL or search Bing/)
  await expect(address).toHaveValue(/^file:\/\//)
  await address.fill(url)
  await address.press('Enter')
  await expect.poll(() => guestIdentity(app, url)).toBeGreaterThan(0)
  const id = await guestIdentity(app, url)
  await expect.poll(() => observeGuest(app, id, 'typeof carrierNonce')).toBe('string')
  const viewId = await window.evaluate(id => {
    const guest = Array.from(document.querySelectorAll('webview')).find(element => (element as HTMLElement & { getWebContentsId: () => number }).getWebContentsId() === id) as HTMLElement
    return guest.dataset.browserPageId!
  }, id)
  return { id, viewId }
}

export async function observeMain<T>(app: ElectronApplication, mainId: number, expression: string): Promise<T> {
  return app.evaluate(({ webContents }, { mainId, expression }) => webContents.fromId(mainId)!.executeJavaScript(expression), { mainId, expression })
}

export async function observeGuest<T>(app: ElectronApplication, guestId: number, expression: string): Promise<T> {
  return app.evaluate(({ webContents }, { guestId, expression }) => webContents.fromId(guestId)!.executeJavaScript(expression), { guestId, expression })
}

async function clickMainTarget(app: ElectronApplication, mainId: number, point: { x: number; y: number }): Promise<void> {
  await app.evaluate(({ BrowserWindow, webContents }, mainId) => {
    const main = webContents.fromId(mainId)!
    const owner = BrowserWindow.fromWebContents(main)
    if (!owner || owner.isDestroyed()) throw new Error('The owned browser window is unavailable for input')
    owner.focus()
  }, mainId)
  await expect.poll(() => app.evaluate(({ BrowserWindow, webContents }, mainId) => BrowserWindow.fromWebContents(webContents.fromId(mainId)!)?.isFocused(), mainId), { message: 'Native input requires the owned application window to be focused' }).toBe(true)
  await app.evaluate(async ({ webContents }, { mainId, point }) => {
    const main = webContents.fromId(mainId)!
    const attached = main.debugger.isAttached()
    if (!attached) main.debugger.attach('1.3')
    try {
      await main.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'none', buttons: 0, ...point })
      await main.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point })
      await main.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point })
    } finally {
      if (!attached && main.debugger.isAttached()) main.debugger.detach()
    }
  }, { mainId, point })
}

async function nativeClickElement(app: ElectronApplication, mainId: number, selector: string, text?: string): Promise<void> {
  const point = () => observeMain<{ x: number; y: number } | null>(app, mainId, `(() => {
    const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && ${text === undefined ? 'true' : `candidate.textContent.trim() === ${JSON.stringify(text)}`};
    });
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const hit = document.elementFromPoint(point.x, point.y);
    return hit && (element === hit || element.contains(hit)) ? point : null;
  })()`)
  await expect.poll(point, { message: `The recovered UI must expose a hittable ${text ?? selector}` }).not.toBeNull()
  const target = await point()
  expect(target).not.toBeNull()
  await clickMainTarget(app, mainId, target!)
}

export async function openRecoveredBrowser(app: ElectronApplication, mainId: number, fileName: string, url: string): Promise<{ id: number; viewId: string }> {
  // Playwright permanently marks the original Page crashed; native input still targets the recovered window.
  await expect.poll(() => observeMain(app, mainId, '!!document.querySelector(\'button[title="Open workspace resources"], button[title="Close workspace resources"]\')')).toBe(true)
  if (await observeMain(app, mainId, '!!document.querySelector(\'button[title="Open workspace resources"]\')')) {
    await nativeClickElement(app, mainId, 'button[title="Open workspace resources"]')
  }
  await nativeClickElement(app, mainId, '[role="treeitem"] span', fileName)
  await nativeClickElement(app, mainId, 'button[title="Open in browser mode (full render)"]')
  await expect.poll(() => observeMain(app, mainId, 'document.querySelector(\'input[placeholder^="Enter URL"]\')?.value')).toMatch(/^file:\/\//)
  await nativeClickElement(app, mainId, 'input[placeholder^="Enter URL"]')
  const sendInput = async (commands: Array<{ method: string; params: Record<string, unknown> }>) => app.evaluate(async ({ webContents }, { mainId, commands }) => {
    const main = webContents.fromId(mainId)!
    const attached = main.debugger.isAttached()
    if (!attached) main.debugger.attach('1.3')
    try {
      for (const command of commands) await main.debugger.sendCommand(command.method, command.params)
    } finally {
      if (!attached && main.debugger.isAttached()) main.debugger.detach()
    }
  }, { mainId, commands })
  const modifiers = process.platform === 'darwin' ? 4 : 2
  await sendInput([
    { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers, commands: process.platform === 'darwin' ? ['selectAll'] : [] } },
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers } },
  ])
  await expect.poll(() => observeMain(app, mainId, `(() => {
    const input = document.querySelector('input[placeholder^="Enter URL"]');
    return document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length;
  })()`)).toBe(true)
  await sendInput([{ method: 'Input.insertText', params: { text: url } }])
  await expect.poll(() => observeMain(app, mainId, 'document.querySelector(\'input[placeholder^="Enter URL"]\')?.value')).toBe(url)
  await sendInput([
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r', unmodifiedText: '\r' } },
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 } },
  ])
  await expect.poll(() => guestIdentity(app, url)).toBeGreaterThan(0)
  const id = await guestIdentity(app, url)
  const viewId = await observeMain<string>(app, mainId, `Array.from(document.querySelectorAll('webview')).find(element => element.getWebContentsId() === ${id})?.dataset.browserPageId`)
  expect(viewId).toEqual(expect.any(String))
  return { id, viewId }
}

export async function clickGuestAction(app: ElectronApplication, mainId: number, guestId: number): Promise<void> {
  const host = await observeMain<{ x: number; y: number }>(app, mainId, `(() => {
    const guest = Array.from(document.querySelectorAll('webview')).find(element => element.getWebContentsId() === ${guestId});
    const rect = guest.getBoundingClientRect(); return { x: rect.x, y: rect.y };
  })()`)
  const action = await observeGuest<{ x: number; y: number }>(app, guestId, `(() => {
    const rect = document.querySelector('#action').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`)
  const scale = await app.evaluate(({ webContents }, mainId) => webContents.fromId(mainId)!.getZoomFactor(), mainId)
  const before = await observeGuest<number>(app, guestId, 'pageClicks')
  const point = { x: host.x + action.x / scale, y: host.y + action.y / scale }
  const hit = await observeMain(app, mainId, `(() => {
    const element = document.elementFromPoint(${point.x}, ${point.y});
    return { tag: element?.tagName, guestId: element?.tagName === 'WEBVIEW' ? element.getWebContentsId() : null };
  })()`)
  expect(hit, 'The host input point must hit the intended visible guest').toEqual({ tag: 'WEBVIEW', guestId })
  const installObserver = `(() => {
    if (window.browserRecoveryInput) return;
    window.browserRecoveryInput = [];
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) document.addEventListener(type, event => {
      window.browserRecoveryInput.push({ type: event.type, trusted: event.isTrusted, x: event.clientX, y: event.clientY, target: event.target.id || event.target.tagName });
      if (window.browserRecoveryInput.length > 20) window.browserRecoveryInput.shift();
    }, { capture: true, passive: true });
  })()`
  await observeMain(app, mainId, installObserver)
  await observeGuest(app, guestId, installObserver)
  try {
    await clickMainTarget(app, mainId, point)
    await expect.poll(() => observeGuest(app, guestId, 'pageClicks'), { message: 'A real click must reach the visible guest action' }).toBe(before + 1)
    expect(await observeGuest(app, guestId, 'window.browserRecoveryInput.findLast(event => event.type === "click")')).toMatchObject({ trusted: true, target: 'action' })
  } finally {
    const diagnostics = await app.evaluate(async ({ BrowserWindow, webContents }, { mainId, guestId, point, host, action, scale, before }) => {
      const main = webContents.fromId(mainId)!
      const guest = webContents.fromId(guestId)!
      const state = '({ focus: document.hasFocus(), active: document.activeElement?.id || document.activeElement?.tagName, events: window.browserRecoveryInput })'
      const hit = await main.executeJavaScript(`(() => { const hit = document.elementFromPoint(${point.x}, ${point.y}); return { tag: hit?.tagName, page: hit?.dataset.browserPageId }; })()`)
      return { mainId, guestId, windowFocused: BrowserWindow.fromWebContents(main)?.isFocused(), focusedContentsId: webContents.getFocusedWebContents()?.id, host, action, point, scale, before, hit, main: await main.executeJavaScript(state), guest: await guest.executeJavaScript(state), clicks: await guest.executeJavaScript('pageClicks') }
    }, { mainId, guestId, point, host, action, scale, before })
    await test.info().attach(`browser-input-${guestId}-${before}`, { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' })
  }
}

export async function browserGeometry(app: ElectronApplication, mainId: number, guestId: number) {
  await expect.poll(() => observeMain(app, mainId, `(() => {
    const input = document.querySelector('input[placeholder^="Enter URL"]');
    const surface = input?.closest('form')?.parentElement?.parentElement?.lastElementChild;
    if (!surface) return ['Browser surface is unavailable'];
    const running = [];
    for (let element = surface; element; element = element.parentElement) {
      for (const animation of element.getAnimations()) if (animation.playState === 'running') running.push(animation.animationName || element.tagName);
    }
    return running;
  })()`), { message: 'The browser surface must finish its layout animation before measurement' }).toEqual([])
  await observeMain(app, mainId, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const geometry = await observeMain<{
    surface: { x: number; y: number; width: number; height: number }
    guest: { x: number; y: number; width: number; height: number }
    width: number
    height: number
    hidden: string | null
  }>(app, mainId, `(() => {
    const input = document.querySelector('input[placeholder^="Enter URL"]');
    const surface = input.closest('form').parentElement.parentElement.lastElementChild;
    const guest = Array.from(document.querySelectorAll('webview')).find(element => element.getWebContentsId() === ${guestId});
    return { surface: surface.getBoundingClientRect().toJSON(), guest: guest.getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight, hidden: guest.getAttribute('aria-hidden') };
  })()`)
  const scale = await app.evaluate(({ webContents }, mainId) => webContents.fromId(mainId)!.getZoomFactor(), mainId)
  expect(geometry.hidden).toBe('false')
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(geometry.surface[key] - geometry.guest[key]), `Guest and canvas ${key}`).toBeLessThan(2)
  expect(geometry.guest.x).toBeGreaterThanOrEqual(0)
  expect(geometry.guest.y).toBeGreaterThanOrEqual(0)
  expect(geometry.guest.x + geometry.guest.width).toBeLessThanOrEqual(geometry.width + 1)
  expect(geometry.guest.y + geometry.guest.height).toBeLessThanOrEqual(geometry.height + 1)
  await expect.poll(async () => {
    const viewport = await observeGuest<{ width: number; height: number }>(app, guestId, '({ width: innerWidth, height: innerHeight })')
    return Math.max(Math.abs(viewport.width - geometry.guest.width * scale), Math.abs(viewport.height - geometry.guest.height * scale))
  }).toBeLessThan(3)
  expect(await app.evaluate(({ webContents }, guestId) => webContents.fromId(guestId)!.getZoomFactor(), guestId)).toBe(1)
  return { ...geometry, scale }
}

export async function capturePaintedGuest(app: ElectronApplication, mainId: number, guestId: number) {
  const geometry = await browserGeometry(app, mainId, guestId)
  const capture = await app.evaluate(async ({ webContents }, { mainId, guestId, geometry }) => {
    const guest = webContents.fromId(guestId)!
    const main = webContents.fromId(mainId)!
    const image = await guest.capturePage()
    const bitmap = image.toBitmap()
    let bluePixels = 0
    for (let offset = 0; offset < bitmap.length; offset += 4) if (bitmap[offset] > 200 && bitmap[offset + 1] > 120 && bitmap[offset + 2] < 40) bluePixels++
    const host = await main.capturePage()
    const ratio = host.getSize().width / geometry.width
    const center = { x: Math.round((geometry.guest.x + geometry.guest.width / 2) * ratio), y: Math.round((geometry.guest.y + geometry.guest.height / 2) * ratio), width: 1, height: 1 }
    return { ...image.getSize(), bluePixels, visiblePixel: Array.from(host.crop(center).toBitmap().subarray(0, 3)), png: host.toPNG().toString('base64') }
  }, { mainId, guestId, geometry })
  expect(capture.width).toBeGreaterThan(100)
  expect(capture.height).toBeGreaterThan(100)
  expect(capture.bluePixels).toBeGreaterThan(10000)
  expect(capture.visiblePixel).toEqual([255, 180, 0])
  return { geometry, capture }
}
