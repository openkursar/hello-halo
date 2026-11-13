import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const redaction = await import(pathToFileURL(join(compiled, process.env.SDK_REDACTION_ENTRY ?? 'index.js')).href);
const { decodeWire } = await import(pathToFileURL(join(process.env.SDK_WIRE_TEST_ROOT ?? compiled, 'native/wire.js')).href);
const cases = JSON.parse(await readFile(new URL('../native/crates/halo-core/src/redaction/fixtures/golden.json', import.meta.url), 'utf8'));

test('native redaction matches its golden fixtures, including non-finite limits and lone UTF-16 units', () => {
  for (const fixture of cases) {
    const input = decodeWire(fixture.input);
    const expected = decodeWire(fixture.expected);
    const actual = fixture.method === 'headers' ? redaction.redactHeaders(input)
      : fixture.method === 'secrets' ? redaction.redactSecrets(input) : redaction.truncateField(...input);
    assert.deepEqual(actual, expected, fixture.name);
  }
});

test('header redaction preserves enumeration, caller references and ordinary object assignment semantics', () => {
  const kept = { __haloSdkNativeUndefined: true, __haloSdkNativeNumber: 'NaN' };
  const callback = () => {};
  const input = Object.create({ Authorization: 'inherited' });
  Object.assign(input, { '10': 'ten', '2': 'two', Keep: kept, Callback: callback, BigInt: 2n, Missing: undefined });
  Object.defineProperty(input, 'Hidden', { value: 'not enumerable' });
  input[Symbol('secret')] = 'symbol';
  let reads = 0;
  Object.defineProperty(input, 'COOKIE', { enumerable: true, get() { reads++; return 'private'; } });
  Object.defineProperty(input, '__proto__', { enumerable: true, value: kept });
  const result = redaction.redactHeaders(input);
  assert.deepEqual(Object.keys(result), ['2', '10', 'Keep', 'Callback', 'BigInt', 'Missing', 'COOKIE']);
  assert.equal(result.Keep, kept);
  assert.equal(result.Callback, callback);
  assert.equal(result.BigInt, 2n);
  assert.equal(Object.getPrototypeOf(result), kept);
  assert.equal(result.COOKIE, '[REDACTED]');
  assert.equal(reads, 1);
  assert.equal(Object.hasOwn(result, 'Authorization'), false);
  assert.equal(Object.hasOwn(result, 'Hidden'), false);
  assert.equal(Object.getOwnPropertySymbols(result).length, 0);
  assert.equal(input.Keep, kept);
  assert.deepEqual(redaction.redactHeaders(new Headers({ Authorization: 'private', Accept: 'text/plain' })), {});
});

test('redaction keeps the SDK pattern set, resets matching on every call and uses the default truncation boundary', () => {
  const text = `sk-${'C'.repeat(30)} and sk-${'D'.repeat(30)}`;
  assert.equal(redaction.redactSecrets(text), '[REDACTED] and [REDACTED]');
  assert.equal(redaction.redactSecrets(text), '[REDACTED] and [REDACTED]');
  assert.equal(redaction.redactSecrets('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(redaction.truncateField('x'.repeat(2048)), 'x'.repeat(2048));
  assert.equal(redaction.truncateField('x'.repeat(2049)), 'x'.repeat(2048) + '…(truncated, total 2049 chars)');
  assert.equal(redaction.truncateField('A😀Z', 2), 'A\ud83d…(truncated, total 4 chars)');
});
