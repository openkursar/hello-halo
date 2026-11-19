import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import childProcess from 'node:child_process';
import workerThreads from 'node:worker_threads';
import timers from 'node:timers';
import timersPromises from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const url = new URL(process.argv[2]);
const directory = fs.realpathSync(fileURLToPath(new URL('../', url)));
const observed = [];
const originalImmediate = timers.setImmediate;
const originalWrite = fs.writeSync;
const reject = name => () => { observed.push(name); throw new Error(`Unexpected import side effect: ${name}`); };
for (const owner of [fs, fsPromises]) {
  for (const name of ['readdir', 'readdirSync', 'opendir', 'opendirSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'watch', 'watchFile', 'rm', 'rmSync']) {
    if (typeof owner[name] === 'function') owner[name] = reject(`fs.${name}`);
  }
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execFile', 'execSync', 'execFileSync', 'fork']) childProcess[name] = reject(`child_process.${name}`);
workerThreads.Worker = class { constructor() { reject('worker_threads.Worker')(); } };
for (const name of ['connect', 'createConnection', 'createServer']) net[name] = reject(`net.${name}`);
net.Socket.prototype.connect = reject('net.Socket.connect');
net.Server.prototype.listen = reject('net.Server.listen');
globalThis.fetch = reject('fetch');
for (const owner of [globalThis, timers, timersPromises]) for (const name of ['setTimeout', 'setInterval', 'setImmediate']) {
  if (typeof owner[name] === 'function') owner[name] = reject(`timers.${name}`);
}
process.dlopen = reject('process.dlopen');
syncBuiltinESMExports();
const handles = new Set(process._getActiveHandles());
const requests = new Set(process._getActiveRequests());
await import(url.href);
await new Promise(resolve => originalImmediate(resolve));
assert.deepEqual(observed, []);
assert.deepEqual(process._getActiveHandles().filter(handle => !handles.has(handle)), []);
assert.deepEqual(process._getActiveRequests().filter(request => !requests.has(request)), []);
originalWrite(1, JSON.stringify({ entry: url.pathname, runtimeDirectory: directory, observed, newHandles: 0, newRequests: 0 }) + '\n');
