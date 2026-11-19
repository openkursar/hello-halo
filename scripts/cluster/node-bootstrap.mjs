import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const hiddenFixture = fileURLToPath(new URL('../../tests/e2e/fixtures/hidden-windows.cjs', import.meta.url))

export function prepareNodeEntry(appEntry, nodeDir, environment = process.env) {
  if (environment.HALO_E2E_HIDDEN_WINDOWS !== '1') return appEntry
  if (environment.HALO_E2E_PACKAGED_APP) throw new Error('Hidden cluster windows require a controlled source bootstrap')
  const bootstrap = path.join(nodeDir, `cluster-bootstrap-${crypto.randomUUID()}.cjs`)
  const userData = path.join(nodeDir, 'electron-data', 'user')
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(bootstrap, `const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');
if (app.isPackaged) throw new Error('Hidden cluster windows require a controlled source bootstrap');
app.setAppPath(${JSON.stringify(path.dirname(appEntry))});
app.setPath('appData', ${JSON.stringify(path.dirname(userData))});
app.setPath('userData', ${JSON.stringify(userData)});
require(${JSON.stringify(hiddenFixture)});
const snapshots = new Map();
const liveWindows = new Map();
const history = [];
const writeObservation = (name, phase) => {
  const target = require('node:path').join(${JSON.stringify(nodeDir)}, name);
  const temporary = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, phase, appPath: app.getAppPath(), windows: [...snapshots.values()], presented, history, state: globalThis.acceptanceHiddenWindows }), { flag: 'wx' });
  fs.renameSync(temporary, target);
};
let presented = false;
const sample = (window, phase) => {
  const previous = snapshots.get(window.id) || { id: window.id, loaded: false };
  const destroyed = window.isDestroyed?.() === true;
  const snapshot = { ...previous, closed: destroyed, ...(destroyed ? {} : { visible: window.isVisible(), focused: window.isFocused() }), ...(phase === 'did-finish-load' ? { loaded: true } : {}) };
  presented ||= snapshot.visible === true || snapshot.focused === true || phase === 'show' || phase === 'focus';
  snapshots.set(window.id, snapshot);
};
app.on('browser-window-created', (_event, window) => {
  if (snapshots.size >= 128) throw new Error('Hidden cluster window observation exceeded its 128-window bound');
  liveWindows.set(window.id, window);
  sample(window, 'created');
  for (const event of ['show', 'focus', 'close', 'closed']) window.on(event, () => {
    sample(window, event);
    if (event === 'closed') liveWindows.delete(window.id);
  });
  window.webContents.once('did-finish-load', () => {
    sample(window, 'did-finish-load');
    writeObservation('hidden-windows-ready.json', 'did-finish-load');
  });
});
process.on('SIGTERM', () => {
  if (process.listeners('SIGTERM').length === 1) app.quit();
});
app.on('before-quit', () => {
  for (const window of liveWindows.values()) sample(window, 'before-quit');
  const enumerated = BrowserWindow.getAllWindows();
  for (const window of enumerated) {
    if (!snapshots.has(window.id)) throw new Error('Hidden cluster encountered an unobserved window');
    sample(window, 'before-quit');
  }
  history.push({ phase: 'before-quit', liveWindowCount: liveWindows.size, enumeratedWindowCount: enumerated.length });
  if (history.length > 16) history.shift();
  writeObservation('hidden-windows-final.json', 'before-quit');
});
import(${JSON.stringify(pathToFileURL(appEntry).href)});
`)
  return bootstrap
}

function readObservation(nodeDir, name) {
  const file = path.join(nodeDir, name)
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let record
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size > 65536) throw new Error('Hidden window evidence must be a bounded regular file')
    record = JSON.parse(fs.readFileSync(descriptor, 'utf8'))
  } finally { fs.closeSync(descriptor) }
  return record
}

export function verifyHiddenNodeFinal(nodeDir, pid, appEntry) {
  return verifyObservation(readObservation(nodeDir, 'hidden-windows-final.json'), pid, appEntry, 'before-quit')
}

export async function waitHiddenNodeReady(nodeDir, pid, appEntry, deadline, environment = process.env) {
  if (environment.HALO_E2E_HIDDEN_WINDOWS !== '1') return
  if (!Number.isFinite(deadline)) throw new Error('Hidden node readiness requires a finite startup deadline')
  while (Date.now() < deadline) {
    let record
    try { record = readObservation(nodeDir, 'hidden-windows-ready.json') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (record?.pid === pid) return verifyObservation(record, pid, appEntry, 'did-finish-load')
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))))
  }
  throw new Error('Hidden cluster renderer did not produce a current loaded observation before its startup deadline')
}

function verifyObservation(record, pid, appEntry, phase) {
  if (record.pid !== pid || record.phase !== phase || record.presented !== false || record.appPath !== path.dirname(appEntry) || !Array.isArray(record.windows) || !record.windows.length || !record.windows.some(window => window.loaded === true) || !record.state || !Number.isSafeInteger(record.state.created) || record.state.created < 1 || record.windows.some(window => window.visible !== false || window.focused !== false)) {
    throw new Error('Hidden cluster node has missing or invalid final window evidence')
  }
  return record
}
