import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { processIdentity } from './metrics.mjs';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function readJson(path) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error; }
}
async function until(read, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(100); }
  throw new Error('Validation supervision check timed out');
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function setup(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'sdk-supervision-'));
  t.after(async () => {
    const background = await readJson(join(directory, 'background.json'));
    if (background?.pid && await processIdentity(background.pid) === background.identity) {
      process.kill(-background.pid, 'SIGTERM');
      await until(() => !alive(background.pid), 15000);
    }
    const state = await readJson(join(directory, 'run-state.json'));
    if (state?.snapshot) await fs.rm(join(state.snapshot, '..'), { recursive: true, force: true });
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('background validation outlives its launcher and persists complete measurements', { skip: process.platform === 'win32', timeout: 120000 }, async t => {
  const directory = await setup(t);
  const launching = execute(process.execPath, [runner, '--background', '--rounds', '1', '--concurrency', '1',
    '--duration-seconds', '2', '--cancel-cycles', '1', '--keep-sandbox', '--output', directory], { timeout: 10000 });
  const launcherPid = launching.child.pid;
  await launching;
  assert.equal(alive(launcherPid), false);
  const background = await readJson(join(directory, 'background.json'));
  assert.ok(alive(background.pid));
  const pgid = Number((await execute('ps', ['-o', 'pgid=', '-p', String(background.pid)])).stdout.trim());
  assert.equal(pgid, background.pid);
  const state = await until(async () => {
    const value = await readJson(join(directory, 'run-state.json'));
    return value?.status === 'exited' && value;
  });
  assert.equal(state.exitCode, 0);
  assert.equal(state.passed, true);
  const report = await readJson(join(directory, 'report.json'));
  assert.equal(report.passed, true);
  const events = (await fs.readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === 'source' && event.snapshotSha256 === report.source.snapshotSha256));
  assert.ok(events.some(event => event.type === 'actor-event' && event.message.label === 'final'));
  assert.ok(events.some(event => event.type === 'os-sample'));
  assert.equal(events.filter(event => event.type === 'scenario-result').length, 3);
  assert.equal(events.at(-1).type, 'supervisor-exit');
});

test('losing the supervisor leaves recorded evidence and releases its actor', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const directory = await setup(t);
  const child = spawn(process.execPath, [runner, '--duration-seconds', '60', '--rounds', '1', '--concurrency', '1',
    '--keep-sandbox', '--output', directory], { stdio: 'ignore' });
  const exit = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); });
  const progress = await until(() => readJson(join(directory, 'progress.json')));
  const state = await readJson(join(directory, 'run-state.json'));
  assert.ok(progress.rounds >= 1);
  assert.ok(alive(state.actorPid));
  child.kill('SIGKILL');
  await exit;
  await until(() => !alive(state.actorPid), 15000);
  assert.equal(await readJson(join(directory, 'report.json')), undefined);
  const journal = await fs.readFile(join(directory, 'events.jsonl'), 'utf8');
  assert.match(journal, /"type":"source"/);
  assert.match(journal, /"type":"os-sample"/);
  assert.match(journal, /"type":"progress"/);
});

test('background credentials reach only the configured endpoint and stay out of evidence', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const directory = await setup(t);
  const key = 'fixture-' + randomUUID();
  let requests = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ' + key);
    requests++;
    response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Synthetic credential failure ' + key } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const child = spawn(process.execPath, [runner, '--background', '--live', '--key-stdin', '--provider-type', 'openai-compat',
    '--base-url', 'http://127.0.0.1:' + server.address().port, '--model', 'fixture', '--keep-sandbox', '--output', directory], { stdio: ['pipe', 'ignore', 'inherit'] });
  const exit = once(child, 'exit');
  child.stdin.end(key + '\n');
  assert.equal((await exit)[0], 0);
  const state = await until(async () => { const value = await readJson(join(directory, 'run-state.json')); return value?.status === 'exited' && value; });
  assert.equal(state.exitCode, 1);
  assert.equal(state.passed, false);
  assert.ok(requests > 0);
  for (const name of await fs.readdir(directory)) {
    const content = await fs.readFile(join(directory, name));
    assert.equal(content.includes(Buffer.from(key)), false, name);
  }
});
