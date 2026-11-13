import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSdk, executionEnvironment } from './build.mjs';

async function fixture(t, script) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'sdk-validation-build-'));
  await fs.mkdir(join(directory, 'scripts'));
  await fs.writeFile(join(directory, 'scripts/build.mjs'), script);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, log: join(directory, 'build.log') };
}

const artifactBuild = altered => `
  import { mkdir, writeFile } from 'node:fs/promises';
  import { createHash } from 'node:crypto';
  const data = Buffer.from('synthetic native artifact');
  const filename = 'halo-sdk.' + process.platform + '-' + process.arch + '.node';
  await mkdir('dist/native', { recursive: true });
  await writeFile('dist/native/' + filename, data);
  await writeFile('dist/native/build-info.json', JSON.stringify({ implementation: 'rust', abiVersion: 1,
    buildId: 'a'.repeat(64), artifacts: [{ platform: process.platform + '-' + process.arch, filename,
      sha256: ${altered ? "'0'.repeat(64)" : "createHash('sha256').update(data).digest('hex')"} }] }));
  await writeFile('target-path.txt', process.env.CARGO_TARGET_DIR);
  console.log('fixture build completed');
`;

test('validation invokes the full SDK build entry and verifies the current native artifact', async t => {
  const { directory, log } = await fixture(t, artifactBuild(false));
  const source = join(directory, 'source');
  const native = await buildSdk(directory, source, log);
  assert.equal(native.buildId, 'a'.repeat(64));
  assert.equal(await fs.readFile(join(directory, 'target-path.txt'), 'utf8'),
    resolve(source, 'native', process.env.CARGO_TARGET_DIR || 'target'));
  assert.match(await fs.readFile(log, 'utf8'), /fixture build completed/);
});

test('validation rejects a mismatched native artifact after an otherwise successful build', async t => {
  const { directory, log } = await fixture(t, artifactBuild(true));
  await assert.rejects(buildSdk(directory, directory, log), /does not match its build manifest/);
});

test('validation preserves build failure and redacts its saved log', async t => {
  const { directory, log } = await fixture(t, "console.error('synthetic-private-value'); process.exit(23);");
  await assert.rejects(buildSdk(directory, directory, log, { scrub: text => text.replaceAll('synthetic-private-value', '[REDACTED]') }), /SDK build failed \(23\)/);
  assert.equal((await fs.readFile(log, 'utf8')).trim(), '[REDACTED]');
});

test('validation cancellation stops its owned build process', { timeout: 15000 }, async t => {
  const { directory, log } = await fixture(t, "import { writeFileSync } from 'node:fs'; writeFileSync('ready', String(process.pid)); setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const pending = buildSdk(directory, directory, log, { signal: controller.signal });
  const rejected = assert.rejects(pending, /requested stop/);
  t.after(async () => { controller.abort(new Error('requested stop')); await pending.catch(() => {}); });
  let pid;
  const deadline = Date.now() + 5000;
  while (!pid && Date.now() < deadline) {
    try { pid = Number(await fs.readFile(join(directory, 'ready'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!pid) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid > 0, 'The build process must start before cancellation');
  controller.abort(new Error('requested stop'));
  await rejected;
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('build and actor environments exclude credentials without removing ordinary runtime settings', () => {
  assert.deepEqual(executionEnvironment({ PATH: '/fixture/bin', SDK_TEST_API_KEY: 'key', DEEPSEEK_API_KEY: 'key',
    NPM_TOKEN: 'token', DATABASE_PASSWORD: 'password', APP_SECRET: 'secret', CARGO_TARGET_DIR: '/fixture/target' }),
  { PATH: '/fixture/bin', CARGO_TARGET_DIR: '/fixture/target' });
});
