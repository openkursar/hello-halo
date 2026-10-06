// Playwright's focus emulation holds a visible capturer, changing the native hide path under test.
const { app, BrowserWindow, webContents, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { PNG } = require('pngjs')
const executeFile = promisify(execFile)

const payloadArgument = process.argv.at(-1)
assert(typeof payloadArgument === 'string' && payloadArgument.length > 0, 'Native visibility JSON payload is missing')
const payload = JSON.parse(payloadArgument)
assert(payload && typeof payload === 'object' && ['mainEntry', 'profile', 'url'].every(key => typeof payload[key] === 'string' && payload[key].length > 0), 'Native visibility payload requires nonempty mainEntry, profile and url strings')
const projectRoot = fs.realpathSync(path.resolve(path.dirname(payload.mainEntry), '../..'))
const sharpPath = fs.realpathSync(path.join(projectRoot, 'resources/dsh-runtime/node_modules/sharp'))
const sharpRelative = path.relative(projectRoot, sharpPath)
assert(!sharpRelative.startsWith('..') && !path.isAbsolute(sharpRelative), 'Sharp decoder escaped the controlled project resources')
const sharp = require(sharpPath)
const decoderRequire = createRequire(path.join(sharpPath, 'package.json'))
const nativeDecoderPath = fs.realpathSync(decoderRequire.resolve(`@img/sharp-${process.platform}-${process.arch}/sharp.node`))
const nativeRelative = path.relative(projectRoot, nativeDecoderPath)
assert(!nativeRelative.startsWith('..') && !path.isAbsolute(nativeRelative), 'Native decoder escaped the controlled project resources')
const decoder = {
  name: 'sharp', version: JSON.parse(fs.readFileSync(path.join(sharpPath, 'package.json'), 'utf8')).version,
  modulePath: sharpPath, nativePath: nativeDecoderPath,
  nativeSha256: createHash('sha256').update(fs.readFileSync(nativeDecoderPath)).digest('hex'),
  versions: sharp.versions, colorSpace: 'srgb',
}
const output = process.stdout.write.bind(process.stdout)
process.stdout.write = (...args) => process.stderr.write(...args)
app.commandLine.appendSwitch('lang', 'en-US')
app.setPath('appData', path.join(payload.profile, 'electron-data'))
app.setPath('userData', path.join(payload.profile, 'electron-data', 'user'))

const PREFIX = 'HALO_BROWSER_NATIVE_VISIBILITY '
const VIEW_ID = 'native-visibility-page'
const BOUNDS = { x: 240, y: 100, width: 640, height: 480 }
const result = { ok: false, runtime: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, mainBundleSha256: createHash('sha256').update(fs.readFileSync(payload.mainEntry)).digest('hex') }, states: [] }
const focusStarted = process.hrtime.bigint()
let focusSequence = 0
let focusStage = 'startup'
const focusEvents = []
result.focusTrace = { mainProcessPid: process.pid, startedAtMs: Date.now(), events: focusEvents, droppedEvents: 0 }

function focusTime() {
  return { atMs: Date.now(), sinceStartMs: Number(process.hrtime.bigint() - focusStarted) / 1e6 }
}

async function frontmostApplication() {
  if (process.platform !== 'darwin') return { source: 'AppKit.NSWorkspace.frontmostApplication.processIdentifier', pid: null, error: 'not-darwin' }
  const started = focusTime()
  try {
    const { stdout } = await executeFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); var application = $.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({pid:Number(application.processIdentifier)});'], { timeout: 800, killSignal: 'SIGKILL', maxBuffer: 2048, encoding: 'utf8' })
    const value = JSON.parse(stdout.trim())
    assert(Number.isInteger(value.pid) && value.pid > 0, 'Frontmost application returned no valid PID')
    return { source: 'AppKit.NSWorkspace.frontmostApplication.processIdentifier', pid: value.pid, started, finished: focusTime() }
  } catch (error) {
    return { source: 'AppKit.NSWorkspace.frontmostApplication.processIdentifier', pid: null, started, finished: focusTime(), error: String(error.message ?? error).slice(0, 500) }
  }
}

async function focusSnapshot(record, stage, readFrontmost = false) {
  focusStage = `${record.state}:${stage}`
  const snapshot = { stage, ...focusTime(), native: nativeState(main), eventSequence: focusSequence }
  snapshot.host = await hostState(main)
  snapshot.hostSampledAt = focusTime()
  if (readFrontmost) snapshot.frontmost = await frontmostApplication()
  record.focusTimeline.push(snapshot)
  return snapshot
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function bounded(request, label, timeout = 6000) {
  let timer
  try {
    return await Promise.race([request, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout} ms`)), timeout)
    })])
  } finally { clearTimeout(timer) }
}

async function poll(read, accept, label, timeout = 6000) {
  const end = Date.now() + timeout
  let value
  while (Date.now() < end) {
    value = await bounded(Promise.resolve().then(read), label, Math.min(3000, Math.max(1, end - Date.now())))
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`${label} did not settle: ${JSON.stringify(value)}`)
}

function nativeState(window) {
  return { visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused() }
}

function hostState(window) {
  return bounded(window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('textarea');
    if (!input) throw new Error('Actual chat composer is missing');
    return { draft: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, active: document.activeElement === input, marked: input.dataset.nativeVisibilityComposer === 'owned', documentFocus: document.hasFocus(), visibility: document.visibilityState };
  })()`), 'host composer state')
}

async function call(window, method, args) {
  const response = await bounded(window.webContents.executeJavaScript(`window.halo[${JSON.stringify(method)}](...${JSON.stringify(args)})`), method)
  assert(response && response.success === true, `${method}: ${JSON.stringify(response)}`)
  return response.data
}

function execute(window, code) {
  return call(window, 'executeBrowserJS', [VIEW_ID, code])
}

function guestState(window) {
  return execute(window, '({ url:location.href, nonce:window.carrierNonce, draft:document.querySelector("#draft").value, scroll:scrollY, ticks:window.ticks, visibility:document.visibilityState })')
}

async function imageEvidence(encoded, rgb, state) {
  assert(typeof encoded === 'string' && encoded.length > 0, 'Capture returned no encoded image string')
  const image = encoded.startsWith('data:') ? nativeImage.createFromDataURL(encoded) : nativeImage.createFromBuffer(Buffer.from(encoded, 'base64'))
  assert(!image.isEmpty(), 'Capture returned an empty native image')
  const png = image.toPNG()
  const decoded = PNG.sync.read(png)
  let rawCurrentPixels = 0
  const colors = new Map()
  for (let index = 0; index < decoded.data.length; index += 4) {
    if (decoded.data[index + 3] > 0 && rgb.every((value, channel) => Math.abs(decoded.data[index + channel] - value) <= 8)) rawCurrentPixels++
    const color = ((decoded.data[index] << 24) | (decoded.data[index + 1] << 16) | (decoded.data[index + 2] << 8) | decoded.data[index + 3]) >>> 0
    colors.set(color, (colors.get(color) ?? 0) + 1)
  }
  const dominantRgba = [...colors].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([color, pixels]) => ({ rgba: [color >>> 24, (color >>> 16) & 255, (color >>> 8) & 255, color & 255], pixels }))
  const metadata = await sharp(png).metadata()
  const managed = await sharp(png).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  assert(managed.info.channels === 4, 'Color-managed decoder did not produce RGBA')
  let currentPixels = 0
  const managedColors = new Map()
  for (let index = 0; index < managed.data.length; index += 4) {
    if (managed.data[index + 3] > 0 && rgb.every((value, channel) => Math.abs(managed.data[index + channel] - value) <= 8)) currentPixels++
    const color = ((managed.data[index] << 24) | (managed.data[index + 1] << 16) | (managed.data[index + 2] << 8) | managed.data[index + 3]) >>> 0
    managedColors.set(color, (managedColors.get(color) ?? 0) + 1)
  }
  const managedDominantRgba = [...managedColors].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([color, pixels]) => ({ rgba: [color >>> 24, (color >>> 16) & 255, (color >>> 8) & 255, color & 255], pixels }))
  const chunks = []
  let icc
  for (let offset = 8; offset + 12 <= png.length;) {
    const bytes = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    assert(offset + bytes + 12 <= png.length, 'PNG chunk exceeded its encoded size')
    if (!chunks.includes(type)) chunks.push(type)
    if (type === 'iCCP') {
      const data = png.subarray(offset + 8, offset + 8 + bytes)
      const separator = data.indexOf(0)
      icc = { name: data.toString('latin1', 0, separator), compressedBytes: bytes - separator - 2 }
    }
    offset += bytes + 12
  }
  const evidence = { width: managed.info.width, height: managed.info.height, currentPixels, pngBytes: png.length, pngSha256: createHash('sha256').update(png).digest('hex'), decoder, png: { bitDepth: decoded.depth, colorType: decoded.colorType, gamma: decoded.gamma, chunks, icc, iccSha256: metadata.icc ? createHash('sha256').update(metadata.icc).digest('hex') : null, rawCurrentPixels, dominantRgba, managedDominantRgba } }
  if (currentPixels < 10000 || decoded.width < 320 || decoded.height < 240) {
    const directory = path.join(payload.profile, 'native-visibility-artifacts')
    fs.mkdirSync(directory, { recursive: true })
    evidence.artifact = path.join(directory, `${state}.png`)
    fs.writeFileSync(evidence.artifact, png)
    process.stderr.write(`${state} PNG diagnostics: ${JSON.stringify(evidence)}\n`)
  }
  return evidence
}

let main
let guest
let initial
let baselineGuest
let guestDebuggerAttached
let mainDebuggerAttached
let focusListeners
const created = new Promise(resolve => {
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('did-finish-load', () => {
      if (window.webContents.getURL().split('?')[0].endsWith('/index.html')) resolve(window)
    })
  })
})

async function run() {
  try {
    await import(pathToFileURL(payload.mainEntry).href)
    main = await bounded(created, 'real main window load', 20000)
    focusListeners = ['focus', 'blur'].map(event => {
      const listener = () => {
        focusEvents.push({ event, sequence: ++focusSequence, stage: focusStage, ...focusTime(), native: main.isDestroyed() ? null : nativeState(main) })
        if (focusEvents.length > 64) { focusEvents.shift(); result.focusTrace.droppedEvents++ }
      }
      main.on(event, listener)
      return { event, listener }
    })
    await poll(() => main.webContents.executeJavaScript('window.halo?.getBootstrapStatus?.().then(response => response.success ? response.data : null)'), value => value?.extendedReady === true, 'public bootstrap readiness', 20000)
    await poll(() => main.webContents.executeJavaScript(`(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const skip = buttons.find(button => button.textContent.trim() === 'Skip for now');
      if (skip) { skip.click(); return false; }
      const conversation = buttons.find(button => button.getAttribute('aria-label') === 'Conversation' || button.getAttribute('title') === 'Conversation' || button.textContent.trim() === 'Conversation');
      if (!conversation) return false; conversation.click(); return true;
    })()`), Boolean, 'actual Conversation button')
    await poll(() => main.webContents.executeJavaScript('!!document.querySelector("textarea")'), Boolean, 'actual chat composer')
    await poll(() => nativeState(main), state => state.visible && !state.minimized, 'initial native reveal', 10000)
    await main.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'native host draft');
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dataset.nativeVisibilityComposer = 'owned'; input.focus(); input.setSelectionRange(3, 9, 'forward');
    })()`)
    initial = { native: nativeState(main), mainThrottling: main.webContents.getBackgroundThrottling() }
    mainDebuggerAttached = main.webContents.debugger.isAttached()
    await call(main, 'createBrowserView', [VIEW_ID, payload.url])
    await call(main, 'showBrowserView', [VIEW_ID, BOUNDS])
    await poll(() => execute(main, '({url:location.href,ready:document.readyState})'), state => state.url === payload.url && state.ready === 'complete', 'actual guest navigation')
    const matches = webContents.getAllWebContents().filter(contents => contents.getURL() === payload.url)
    assert(matches.length === 1, `Expected one actual guest, found ${matches.length}`)
    guest = matches[0]
    guestDebuggerAttached = guest.debugger.isAttached()
    initial.guestThrottling = guest.getBackgroundThrottling()
    result.identity = { mainWindowId: main.id, mainContentsId: main.webContents.id, guestContentsId: guest.id, mainPid: main.webContents.getOSProcessId(), guestPid: guest.getOSProcessId(), guestType: guest.getType(), url: guest.getURL() }
    result.captureBaseline = { host: main.webContents.isBeingCaptured(), guest: guest.isBeingCaptured() }
    assert(!result.captureBaseline.host && !result.captureBaseline.guest, 'Native fixture started with a nonzero capturer count')
    await execute(main, 'document.querySelector("#draft").value = "native guest draft"; scrollTo(0, 500); true')
    baselineGuest = await poll(() => guestState(main), state => state.scroll > 400, 'actual guest scroll')
    assert(typeof baselineGuest.nonce === 'string', 'Fixture has no document nonce')
    if (!guestDebuggerAttached) guest.debugger.attach('1.3')

    for (const [index, state] of ['parked', 'minimized', 'hidden'].entries()) {
      main.restore()
      main.showInactive()
      await poll(() => nativeState(main), value => value.visible && !value.minimized, 'native state reset')
      await poll(() => ({ host: main.webContents.isBeingCaptured(), guest: guest.isBeingCaptured() }), value => !value.host && !value.guest, 'capture counters returned to zero')
      await main.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('textarea');
        if (!input) throw new Error('Actual chat composer is missing');
        input.focus(); input.setSelectionRange(3, 9, 'forward');
      })()`)
      const hostPrepared = await poll(() => hostState(main), value => value.draft === 'native host draft' && value.start === 3 && value.end === 9 && value.active && value.marked, `${state} actual composer focus and selection before the native transition`)
      assert(hostPrepared.draft === 'native host draft' && hostPrepared.start === 3 && hostPrepared.end === 9 && hostPrepared.active && hostPrepared.marked, `${state} real composer was not focused before the native transition: ${JSON.stringify(hostPrepared)}`)
      await call(main, 'hideBrowserView', [VIEW_ID])
      if (state === 'minimized') main.minimize()
      if (state === 'hidden') main.hide()
      const nativeBefore = await poll(() => nativeState(main), value => state === 'parked' ? value.visible && !value.minimized : state === 'minimized' ? value.minimized : !value.visible && !value.minimized, `native ${state}`)
      const hostBefore = await hostState(main)
      const rgb = [[220, 40, 40], [40, 190, 40], [40, 40, 220]][index]
      const record = { state, rgb, nativeBefore, hostPrepared, hostBefore, guestBefore: await guestState(main), captureBefore: { host: main.webContents.isBeingCaptured(), guest: guest.isBeingCaptured() }, focusTimeline: [] }
      result.states.push(record)
      try {
        await focusSnapshot(record, 'native-transition')
        assert(hostBefore.draft === 'native host draft' && hostBefore.start === 3 && hostBefore.end === 9 && hostBefore.marked, `${state} real composer precondition was not preserved`)
        await focusSnapshot(record, 'before-execute')
        focusStage = `${state}:execute`
        await execute(main, `document.body.style.backgroundColor = 'rgb(${rgb.join(',')})'; true`)
        await focusSnapshot(record, 'after-execute')
        const beforeTicks = (await guestState(main)).ticks
        await focusSnapshot(record, 'before-timer')
        focusStage = `${state}:timer`
        record.timer = await poll(() => guestState(main), value => value.ticks > beforeTicks + 2, `${state} guest timer`, 5000)
        await focusSnapshot(record, 'after-timer', true)
        await focusSnapshot(record, 'before-AX')
        focusStage = `${state}:AX`
        record.ax = await bounded(guest.debugger.sendCommand('Accessibility.getFullAXTree'), `${state} AX`).then(tree => ({ nodes: tree.nodes.length, draft: tree.nodes.some(node => node.name?.value === 'Draft') }))
        await focusSnapshot(record, 'after-AX')
        assert(record.ax.draft, `${state} accessibility tree lost the Draft input`)
        assert(!record.captureBefore.host && !record.captureBefore.guest, `${state} started with a capturer active`)
        await focusSnapshot(record, 'before-capture', true)
        focusStage = `${state}:capture`
        const nativeCaptureBefore = nativeState(main)
        const captureStarted = focusTime()
        const captureSequence = focusSequence
        const captured = await bounded(main.webContents.executeJavaScript(`(async () => {
          const hostState = () => {
            const input = document.querySelector('textarea');
            if (!input) throw new Error('Actual chat composer is missing');
            return { draft: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, active: document.activeElement === input, marked: input.dataset.nativeVisibilityComposer === 'owned', documentFocus: document.hasFocus(), visibility: document.visibilityState };
          };
          const hostBefore = hostState();
          const startedAtMs = Date.now();
          const response = await window.halo.captureBrowserView(${JSON.stringify(VIEW_ID)});
          const finishedAtMs = Date.now();
          const hostAfter = hostState();
          return { response, hostBefore, hostAfter, startedAtMs, finishedAtMs };
        })()`), `${state} captureBrowserView`)
        record.captureBoundary = { started: captureStarted, finished: focusTime(), nativeBefore: nativeCaptureBefore, nativeAfter: nativeState(main), eventSequenceBefore: captureSequence, eventSequenceAfter: focusSequence, hostBefore: captured.hostBefore, hostAfter: captured.hostAfter, rendererStartedAtMs: captured.startedAtMs, rendererFinishedAtMs: captured.finishedAtMs }
        await focusSnapshot(record, 'after-capture', true)
        assert(captured.response && captured.response.success === true, `captureBrowserView: ${JSON.stringify(captured.response)}`)
        focusStage = `${state}:decode`
        record.nativePNG = await imageEvidence(captured.response.data, rgb, state)
        await focusSnapshot(record, 'after-decode', true)
        assert(record.nativePNG.width >= 320 && record.nativePNG.height >= 240, `Capture dimensions: ${JSON.stringify(record.nativePNG)}`)
        assert(record.nativePNG.currentPixels >= 10000, `Capture did not paint the current RGB ${rgb}: ${JSON.stringify(record.nativePNG)}`)
        record.nativeAfter = nativeState(main)
        record.hostAfter = await hostState(main)
        record.guestAfter = await guestState(main)
        record.captureAfter = { host: main.webContents.isBeingCaptured(), guest: guest.isBeingCaptured() }
        record.throttlingAfter = { host: main.webContents.getBackgroundThrottling(), guest: guest.getBackgroundThrottling() }
        assert(JSON.stringify(record.captureBoundary.nativeAfter) === JSON.stringify(record.captureBoundary.nativeBefore), `${state} capture call changed native visibility, minimization or focus`)
        assert(record.captureBoundary.eventSequenceAfter === record.captureBoundary.eventSequenceBefore, `${state} focus or blur occurred during the capture call`)
        const { visibility: _captureBeforeVisibility, ...captureComposerBefore } = record.captureBoundary.hostBefore
        const { visibility: _captureAfterVisibility, ...captureComposerAfter } = record.captureBoundary.hostAfter
        assert(JSON.stringify(captureComposerAfter) === JSON.stringify(captureComposerBefore), `${state} capture call changed the real composer's draft, selection or focus`)
        assert(JSON.stringify(record.nativeAfter) === JSON.stringify(nativeBefore), `${state} native state changed across preparation, capture or decoding; inspect focusTimeline`)
        const { visibility: _beforeVisibility, ...composerBefore } = hostBefore
        const { visibility: _afterVisibility, ...composerAfter } = record.hostAfter
        assert(JSON.stringify(composerAfter) === JSON.stringify(composerBefore), `${state} composer changed across preparation, capture or decoding; inspect focusTimeline`)
        assert(record.guestAfter.nonce === baselineGuest.nonce && record.guestAfter.draft === baselineGuest.draft && record.guestAfter.scroll === baselineGuest.scroll && webContents.fromId(guest.id) === guest, `${state} capture changed guest identity or retained page state`)
        assert(!record.captureAfter.host && !record.captureAfter.guest, `${state} capture left a capturer active`)
        assert(record.throttlingAfter.host === initial.mainThrottling && record.throttlingAfter.guest === initial.guestThrottling, `${state} capture did not restore background throttling`)
        record.ok = true
      } catch (error) {
        record.ok = false
        record.error = error instanceof Error ? error.message : String(error)
        record.captureAfter = { host: main.webContents.isBeingCaptured(), guest: guest.isBeingCaptured() }
        record.throttlingAfter = { host: main.webContents.getBackgroundThrottling(), guest: guest.getBackgroundThrottling() }
        record.nativeAfter = nativeState(main)
        record.hostAfter = await hostState(main).catch(() => undefined)
        record.guestAfter = await guestState(main).catch(() => undefined)
        process.stderr.write(`${state}: ${error instanceof Error ? error.stack : error}\n`)
      }
    }
    result.ok = result.states.length === 3 && result.states.every(state => state.ok)
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`)
  } finally {
    try {
      if (main && !main.isDestroyed()) {
        if (focusListeners) for (const { event, listener } of focusListeners) main.removeListener(event, listener)
        if (initial) {
          main.webContents.setBackgroundThrottling(initial.mainThrottling)
          if (initial.native.minimized) main.minimize()
          else main.restore()
          if (initial.native.visible) main.showInactive()
          else main.hide()
        }
        if (guest && !guest.isDestroyed()) {
          guest.setBackgroundThrottling(initial.guestThrottling)
          if (!guestDebuggerAttached && guest.debugger.isAttached()) guest.debugger.detach()
        }
        if (!mainDebuggerAttached && main.webContents.debugger.isAttached()) main.webContents.debugger.detach()
        await call(main, 'destroyBrowserView', [VIEW_ID])
        await poll(() => !guest || !webContents.fromId(guest.id), Boolean, 'native guest destruction')
        result.cleanup = { guestReleased: !guest || !webContents.fromId(guest.id), viewState: await call(main, 'getBrowserState', [VIEW_ID]), nativeRestored: nativeState(main), throttlingRestored: main.webContents.getBackgroundThrottling() }
        assert(result.cleanup.viewState === null, 'Public guest state survived destruction')
        if (initial) {
          assert(result.cleanup.throttlingRestored === initial.mainThrottling, 'Main background throttling was not restored')
          assert(result.cleanup.nativeRestored.visible === initial.native.visible && result.cleanup.nativeRestored.minimized === initial.native.minimized, 'Native window visibility or minimization was not restored')
        }
      }
      assert(createHash('sha256').update(fs.readFileSync(payload.mainEntry)).digest('hex') === result.runtime.mainBundleSha256, 'Main bundle changed during native visibility acceptance')
    } catch (error) {
      result.ok = false
      result.cleanupError = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${error instanceof Error ? error.stack : error}\n`)
    }
    output(`${PREFIX}${JSON.stringify(result)}\n`, () => {
      const exitCode = result.ok ? 0 : 1
      process.exitCode = exitCode
      app.quit()
      setTimeout(() => app.exit(exitCode), 1500).unref()
    })
  }
}

void run()
