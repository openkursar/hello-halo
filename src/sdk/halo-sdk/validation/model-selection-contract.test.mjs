import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { entryUrl } from './fixtures/model-selection-entry.mjs';

const reference = process.env.SDK_REFERENCE_TEST_ROOT;
test('unregistered collaboration declarations, guidance and parser remain byte-identical to the reference SDK', { skip: !reference }, async () => {
  const descriptor = join(resolve(reference), 'package.json');
  const referenceEntry = existsSync(descriptor)
    ? resolve(reference, JSON.parse(readFileSync(descriptor, 'utf8')).exports['./collaboration'].import)
    : resolve(reference, 'native/collaboration.js');
  const fixture = fileURLToPath(new URL('./fixtures/model-selection-compatibility.mjs', import.meta.url));
  const run = async url => (await promisify(execFile)(process.execPath, [fixture, fileURLToPath(url)], {
    env: { ...process.env, SDK_TEST_API_KEY: '', SDK_TEST_API_URL: '', SDK_TEST_MODEL: '' },
    timeout: 10_000, maxBuffer: 1024 * 1024,
  })).stdout;
  const [baseline, candidate] = await Promise.all([run(pathToFileURL(referenceEntry)), run(new URL(entryUrl('collaboration')))]);
  assert.equal(candidate, baseline);
  assert.equal(JSON.parse(candidate).rejected.length, 6);
  assert.ok(JSON.parse(candidate).rejected.every(result => result.error));
});

for (const name of ['collaboration', 'collaboration/protocol']) {
  test(`${name}: cold public import starts no native engine, worker, timer, scan or connection`, { timeout: 10_000 }, async t => {
    const url = entryUrl(name);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/model-selection-import.mjs', import.meta.url)), url], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SDK_TEST_API_KEY: '', SDK_TEST_API_URL: '', SDK_TEST_MODEL: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const abort = () => child.kill('SIGKILL');
    t.signal.addEventListener('abort', abort, { once: true });
    try {
      const status = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      assert.deepEqual(status, { code: 0, signal: null }, stderr);
      assert.deepEqual(JSON.parse(stdout).observed, []);
      assert.equal(JSON.parse(stdout).newHandles, 0);
      assert.equal(JSON.parse(stdout).newRequests, 0);
    } finally { t.signal.removeEventListener('abort', abort); }
  });
}
