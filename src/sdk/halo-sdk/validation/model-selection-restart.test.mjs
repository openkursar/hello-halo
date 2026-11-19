import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { distribution } from './fixtures/model-selection-entry.mjs';

test('durable process restart restores original binding across profile update/deletion; revocation never falls back or replays Write', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'halo-selection-restart-'));
  const output = join(directory, 'once.txt');
  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      let data = '';
      for await (const chunk of request) data += chunk;
      const body = JSON.parse(data);
      requests.push({ body, authorization: request.headers.authorization });
      const tool = requests.length === 1;
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'restart-write-once', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: output, content: 'original effect' }) } }] } : { role: 'assistant', content: 'Retained original B context.' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [value, finish] of [[delta, null], [{}, tool ? 'tool_calls' : 'stop']]) response.write(`data: ${JSON.stringify({ id: 'restart-local', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); response.writeHead(500); response.end(String(error)); }
  });
  const run = phase => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/model-selection-restart-phase.mjs', import.meta.url)), directory, url, phase], { cwd: directory, env: { ...process.env, SDK_BEHAVIOR_TEST_ROOT: distribution, SDK_TEST_API_KEY: '', SDK_TEST_API_URL: '', SDK_TEST_MODEL: '' } });
    let log = '';
    let timedOut = false;
    let killTimer;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, 12_000);
    t.signal.addEventListener('abort', terminate, { once: true });
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      t.signal.removeEventListener('abort', terminate);
      if (code === 0 && !timedOut) resolve(log);
      else reject(new Error(`${phase} exited ${code}/${signal}${timedOut ? ' after deadline' : ''}: ${log}`));
    });
  });
  let url;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    url = `http://127.0.0.1:${server.address().port}/v1`;
    await run('initial');
    assert.equal(requests.length, 2);
    assert.equal(await readFile(output, 'utf8'), 'original effect');
    await writeFile(output, 'sentinel: no replay');
    for (const phase of ['updated', 'deleted']) {
      const before = requests.length;
      await run(phase);
      assert.equal(requests.length, before + 1);
      assert.match(JSON.stringify(requests.at(-1).body.messages), /restart-write-once/);
      assert.match(JSON.stringify(requests.at(-1).body.messages), /original effect/);
      assert.equal(await readFile(output, 'utf8'), 'sentinel: no replay');
    }
    const before = requests.length;
    const revokedLog = await run('revoked');
    assert.match(revokedLog, /Member execution failed:.*Original account B revoked/);
    assert.equal(requests.length, before, 'Revoked restore must issue no request to original B, root A or replacement C.');
    assert.ok(requests.every(request => request.authorization === 'Bearer restart-B-canary' && request.body.model === 'same-wire-model'));
    assert.equal(await readFile(output, 'utf8'), 'sentinel: no replay');
    assert.deepEqual(errors, [], 'The local protocol peer must not fail.');
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
