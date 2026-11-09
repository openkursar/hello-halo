import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const env = { ...process.env, SDK_TEST_API_KEY: '', DEEPSEEK_API_KEY: '' };

test('help does not start live work or ask for credentials', async () => {
  const result = await execute(process.execPath, [runner, '--help', '--live'], { env, timeout: 5000 });
  assert.match(result.stdout, /SDK validation:/);
  assert.doesNotMatch(result.stdout, /Waiting for test credential/);
});

test('a misspelled live flag cannot silently run an offline suite', async () => {
  await assert.rejects(execute(process.execPath, [runner, '--liv'], { env, timeout: 5000 }), error => {
    assert.match(error.stderr, /Unknown option/);
    return true;
  });
});

test('missing live credentials fail instead of skipping the suite', async () => {
  await assert.rejects(execute(process.execPath, [runner, '--live'], { env, timeout: 5000 }), error => {
    assert.match(error.stderr, /Live validation requires SDK_TEST_API_KEY/);
    return true;
  });
});

test('a custom provider requires an explicit destination and model', async () => {
  await assert.rejects(execute(process.execPath, [runner, '--live', '--provider-type', 'openai-compat'], { env, timeout: 5000 }), error => {
    assert.match(error.stderr, /requires explicit --base-url and --model/);
    return true;
  });
});

test('provider URLs cannot place credentials in saved reports', async () => {
  await assert.rejects(execute(process.execPath, [runner, '--live', '--base-url', 'https://user:password@example.test'], { env, timeout: 5000 }), error => {
    assert.match(error.stderr, /without credentials, query or fragment/);
    return true;
  });
});

test('custom endpoints never inherit a DeepSeek credential implicitly', async () => {
  const customEnv = { ...env, DEEPSEEK_API_KEY: 'synthetic-deepseek-credential' };
  delete customEnv.SDK_TEST_API_KEY;
  await assert.rejects(execute(process.execPath, [runner, '--live', '--provider-type', 'openai-compat',
    '--base-url', 'https://example.test/v1', '--model', 'fixture'], { env: customEnv, timeout: 5000 }), error => {
    assert.match(error.stderr, /Live validation requires SDK_TEST_API_KEY/);
    return true;
  });
});
