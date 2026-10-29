import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ownedProcessGroupExists, redact, terminateOwnedProcessTree } from './process.mjs'

const inside = (parent, child) => { const relative = path.relative(parent, child); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function within(promise, timeoutMs, signal) {
  let timer, onAbort
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        onAbort = () => reject(new Error('GUI readiness was interrupted'))
        timer = setTimeout(() => reject(new Error('GUI readiness exceeded its time budget')), Math.max(1, timeoutMs))
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

function isolatedEnvironment(profile) {
  const environment = { ...process.env, HOME: profile, USERPROFILE: profile }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('HALO_TEST_') || /KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL|COOKIE/i.test(key)) environment[key] = ''
  }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_OVERRIDE_DIST_PATH', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR']) delete environment[key]
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete environment[key]
  return environment
}

async function closeProbe(application, diagnostic) {
  const child = application.process()
  if (!child?.pid) return { complete: false, forced: false, reason: 'The launched probe has no owned process identity' }
  let closed = child.exitCode !== null || child.signalCode !== null
  const completion = closed ? Promise.resolve() : new Promise(resolve => child.once('close', () => { closed = true; resolve() }))
  let forced = false
  try { await within(Promise.all([application.close(), completion]), 1500) }
  catch { diagnostic('The probe did not close gracefully; checking its owned process tree') }
  const running = () => process.platform === 'win32' ? !closed : ownedProcessGroupExists(child.pid)
  try {
    if (running()) {
      forced = true
      if (!await terminateOwnedProcessTree(child.pid, diagnostic)) return { complete: false, forced, reason: 'The owned probe process tree could not be terminated' }
    }
    await within(completion, 2000)
    const deadline = Date.now() + 1000
    while (running() && Date.now() < deadline) await delay(25)
    if (running()) return { complete: false, forced, reason: 'The probe still has an owned process group after cleanup' }
    return { complete: true, forced, exitCode: child.exitCode, signal: child.signalCode }
  } catch (error) {
    diagnostic(`Probe cleanup failed: ${error.message}`)
    return { complete: false, forced, reason: 'The owned probe process could not be confirmed closed' }
  }
}

export async function probeGuiReadiness(root, { outputDirectory, timeoutMs = 15000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('GUI readiness timeout must be between 1 and 120000 milliseconds')
  root = await fs.realpath(root)
  const outputBase = path.join(root, 'tests/acceptance/output')
  const directory = path.resolve(root, outputDirectory ?? path.join(outputBase, 'gui-readiness', randomUUID()))
  if (directory === outputBase || !inside(outputBase, directory)) throw new Error('GUI readiness evidence must use a new directory under tests/acceptance/output')
  let ancestor = path.dirname(directory)
  for (;;) {
    try { await fs.lstat(ancestor); break }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor) }
  }
  if (await fs.realpath(ancestor) !== ancestor) throw new Error('GUI readiness evidence cannot pass through an output directory link')
  await fs.mkdir(path.dirname(directory), { recursive: true })
  if (await fs.realpath(path.dirname(directory)) !== path.dirname(directory)) throw new Error('GUI readiness output leaves its owned directory')
  await fs.mkdir(directory)
  const profile = path.join(directory, 'profile')
  const entry = path.join(profile, 'main.cjs')
  const pageFile = path.join(profile, 'index.html')
  const eventFile = path.join(profile, 'lifecycle.jsonl')
  await fs.mkdir(path.join(profile, 'app-data'), { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(profile, 'user-data'), { mode: 0o700 })
  const nonce = randomUUID()
  await fs.writeFile(pageFile, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'"><title>GUI readiness</title><button id="confirm">Confirm readiness</button><output id="result" aria-live="polite">Waiting</output><script nonce="${nonce}">document.getElementById('confirm').addEventListener('click',()=>{document.getElementById('result').textContent='Ready'});</script>`)
  await fs.writeFile(entry, `
const fs = require('node:fs');
const { app, BrowserWindow, session } = require('electron');
const record = (phase, error) => fs.appendFileSync(${JSON.stringify(eventFile)}, JSON.stringify({ phase, at: new Date().toISOString(), appReady: app.isReady(), error }) + '\\n');
app.setPath('appData', ${JSON.stringify(path.join(profile, 'app-data'))});
app.setPath('userData', ${JSON.stringify(path.join(profile, 'user-data'))});
app.commandLine.appendSwitch('disable-background-networking');
record('started');
let window;
app.whenReady().then(async () => {
  record('app-ready');
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, done) => done({ cancel: true }));
  window = new BrowserWindow({ width: 420, height: 240, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  record('window-created');
  await window.loadFile(${JSON.stringify(pageFile)});
  record('page-loaded');
}).catch(error => { record('startup-failed', error.message); app.exit(1) });
app.on('window-all-closed', () => app.quit());
`)
  const record = {
    version: 1, kind: 'host-gui-readiness', ready: false, status: 'unavailable', phase: 'dependencies',
    startedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    observations: { electronConnected: false, appReady: null, windowCreated: false, clickConfirmed: false },
    cleanup: { complete: true, forced: false },
    evidence: { directory: path.relative(root, directory).split(path.sep).join('/'), log: 'probe.log', result: 'readiness.json' },
  }
  let application, page, log = '', failure
  const diagnostic = value => { log = (log + redact(value, root).replaceAll(profile, '<probe-profile>') + '\n').slice(-1024 * 1024) }
  const interrupted = new AbortController()
  const onSignal = () => interrupted.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(1, deadline - Date.now())
  try {
    const require = createRequire(path.join(root, 'package.json'))
    const electronPackage = require.resolve('electron/package.json')
    const playwrightPackage = require.resolve('playwright/package.json')
    const relativeExecutable = (await fs.readFile(path.join(path.dirname(electronPackage), 'path.txt'), 'utf8')).trim()
    const distribution = path.join(path.dirname(electronPackage), 'dist')
    const executablePath = path.resolve(distribution, relativeExecutable)
    if (!relativeExecutable || path.isAbsolute(relativeExecutable) || !inside(distribution, executablePath)) throw new Error('Installed Electron has no valid prepared runtime path')
    if (!(await fs.stat(executablePath)).isFile()) throw new Error('Installed Electron runtime is not a file')
    record.dependencies = { electron: require(electronPackage).version, playwright: require(playwrightPackage).version }
    const loaded = await import(pathToFileURL(require.resolve('playwright')).href)
    const electron = (loaded.default ?? loaded)._electron
    if (typeof electron?.launch !== 'function') throw new Error('Installed Playwright does not expose Electron launch')
    record.phase = 'launch'
    if (interrupted.signal.aborted) throw new Error('GUI readiness was interrupted')
    application = await electron.launch({ executablePath, args: [entry], cwd: root, env: isolatedEnvironment(profile), timeout: remaining() })
    record.observations.electronConnected = true
    const child = application.process()
    child?.stdout?.on('data', diagnostic)
    child?.stderr?.on('data', diagnostic)
    record.phase = 'app-ready'
    const observed = await within(application.evaluate(({ app }) => ({ ready: app.isReady(), versions: { electron: process.versions.electron, node: process.versions.node } })), remaining(), interrupted.signal)
    record.observations.appReady = observed.ready
    record.runtime = observed.versions
    if (!observed.ready) await within(application.evaluate(({ app }) => app.whenReady()), remaining(), interrupted.signal)
    record.observations.appReady = true
    record.phase = 'window'
    page = await within(application.firstWindow({ timeout: remaining() }), remaining(), interrupted.signal)
    record.observations.windowCreated = true
    await within(page.waitForLoadState('domcontentloaded', { timeout: remaining() }), remaining(), interrupted.signal)
    record.phase = 'click'
    await within(page.getByRole('button', { name: 'Confirm readiness', exact: true }).click({ timeout: remaining() }), remaining(), interrupted.signal)
    const result = await within(page.locator('#result').textContent({ timeout: remaining() }), remaining(), interrupted.signal)
    if (result !== 'Ready') throw new Error('The probe click did not produce its expected page result')
    record.observations.clickConfirmed = true
    record.phase = 'complete'
  } catch (error) {
    failure = { stage: record.phase, message: redact(error.message, root).replaceAll(profile, '<probe-profile>') }
    diagnostic(`Readiness failed during ${record.phase}: ${error.message}`)
  } finally {
    if (page) {
      try {
        await within(page.screenshot({ path: path.join(directory, 'window.png'), timeout: 1000 }), 1000)
        record.evidence.screenshot = 'window.png'
      } catch { diagnostic('No probe screenshot was available before cleanup') }
    }
    if (application) record.cleanup = await closeProbe(application, diagnostic)
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    try { diagnostic(await fs.readFile(eventFile, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') diagnostic('The probe lifecycle log could not be read') }
    if (record.cleanup.complete) {
      try { await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
      catch (error) {
        diagnostic(`The isolated probe profile could not be removed: ${error.message}`)
        record.cleanup = { ...record.cleanup, complete: false, reason: 'The isolated probe profile could not be removed' }
      }
    }
    if (!record.cleanup.complete) record.evidence.retainedProfile = 'profile'
  }
  if (!record.cleanup.complete) failure = { stage: 'cleanup', message: record.cleanup.reason }
  record.ready = record.observations.clickConfirmed && !failure && record.cleanup.complete
  record.status = record.ready ? 'ready' : 'unavailable'
  if (failure) record.failure = failure
  record.finishedAt = new Date().toISOString()
  await fs.writeFile(path.join(directory, 'probe.log'), log, { flag: 'wx' })
  await fs.writeFile(path.join(directory, 'readiness.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
  return record
}
