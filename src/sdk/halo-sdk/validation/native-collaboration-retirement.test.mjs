import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const entry = pathToFileURL(join(compiled, process.env.SDK_COLLABORATION_ENTRY ?? 'native/collaboration-sdk.js')).href;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'halo-collaboration-retirement-'));
  const server = join(directory, 'server.cjs');
  const pids = join(directory, 'pids.json');
  const terminated = join(directory, 'term.json');
  await writeFile(server, `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const { createInterface } = require('node:readline');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const ready = new Promise(resolve => child.once('message', () => { writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid])); resolve(); }));
    process.on('SIGTERM', () => writeFileSync(process.argv[3], JSON.stringify({ receivedAt: Date.now() })));
    setInterval(() => {}, 1000);
    createInterface({ input: process.stdin }).on('line', async line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      await ready;
      const result = request.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'retirement', version: '1' } }
        : request.method === 'tools/list' ? { tools: [] } : {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });
  `);
  return { directory, server, pids, terminated, receipt: join(directory, 'logical-close.json'), entry };
}

async function closeScope(input) {
  const { createSdkCollaboration } = await import(input.entry);
  const { readFile, writeFile } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const provider = {
    id: 'retirement-fixture', name: 'Retirement fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false,
      audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request) {
      yield { type: 'message_start', id: 'finished', model: request.model, usage: { input_tokens: 1, output_tokens: 1 } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'The assignment finished.' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
  const binding = createSdkCollaboration({ sessionId: randomUUID(), settings: { maxIdleSessions: 0 },
    getOptions: () => ({ provider, model: 'fixture', cwd: input.directory, env: { HOME: input.directory, USERPROFILE: input.directory },
      persistSession: false, settingSources: [], tools: [], permissionMode: 'bypassPermissions',
      turnEndChecks: { completion: false, openWork: false },
      mcpServers: { retirement: { command: process.execPath, args: [input.server, input.pids, input.terminated] } } }),
    async deliverToSource() { return 'buffered'; },
  });
  const result = await binding.server.instance.callTool('spawn_agent', { name: 'reader', prompt: 'Complete the bounded assignment.' });
  if (result.isError) throw new Error(JSON.stringify(result));
  while (binding.activeCount) await binding.waitForChange(binding.revision);
  const residentCount = binding.residentCount;
  await binding.close();
  const pids = JSON.parse(await readFile(input.pids, 'utf8'));
  const receipt = { pids, residentCount, closedAt: Date.now(), alive: pids.map(pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }) };
  await writeFile(input.receipt, JSON.stringify(receipt));
  return receipt;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function gone(pids) {
  const deadline = performance.now() + 3000;
  while (pids.some(alive) && performance.now() < deadline) await delay(10);
  assert.deepEqual(pids.map(alive), pids.map(() => false), `Owned processes did not exit: ${pids.join(', ')}`);
}
async function cleanup(input) {
  let pids = [];
  try { pids = JSON.parse(await readFile(input.pids, 'utf8')); } catch {}
  for (const pid of pids) {
    if (!alive(pid)) continue;
    if (process.platform !== 'win32') {
      const result = await execute('ps', ['-p', String(pid), '-o', 'command=']).catch(() => ({ stdout: '' }));
      if (result.stdout.includes(input.server)) {
        try { process.kill(-pid, 'SIGKILL'); } catch {}
      }
    }
  }
  await rm(input.directory, { recursive: true, force: true });
}

const posixOnly = process.platform === 'win32' ? 'Requires POSIX process groups and catchable SIGTERM.' : false;

test('standalone collaboration retains retired MCP processes through their grace period without a JavaScript keepalive', { timeout: 20_000, skip: posixOnly }, async () => {
  const input = await fixture();
  try {
    const program = `const closeScope = ${closeScope.toString()}; await closeScope(${JSON.stringify(input)});`;
    await execute(process.execPath, ['--input-type=module', '-e', program], { timeout: 15_000 });
    const exitedAt = Date.now();
    const receipt = JSON.parse(await readFile(input.receipt, 'utf8'));
    const term = JSON.parse(await readFile(input.terminated, 'utf8'));
    assert.equal(receipt.residentCount, 0);
    assert.deepEqual(receipt.alive, [true, true]);
    assert.ok(exitedAt - term.receivedAt >= 4500, 'the host exited before the existing five-second MCP retirement grace elapsed');
    await gone(receipt.pids);
  } finally { await cleanup(input); }
});

test('terminating a Node environment aborts its already retired standalone collaborator processes', { timeout: 15_000, skip: posixOnly }, async () => {
  const input = await fixture();
  let worker;
  try {
    worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const closeScope = ${closeScope.toString()};
      closeScope(workerData).then(value => parentPort.postMessage(value), error => parentPort.postMessage({ error: String(error) }));
    `, { eval: true, workerData: input });
    const receipt = await new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`Environment exited before logical retirement: ${code}`)));
    });
    assert.equal(receipt.error, undefined);
    assert.equal(receipt.residentCount, 0);
    assert.deepEqual(receipt.alive, [true, true]);
    await worker.terminate();
    await gone(receipt.pids);
  } finally { if (worker) await worker.terminate(); await cleanup(input); }
});
