import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeWire, encodeWire } from './wire.js';

const fixture = JSON.parse(readFileSync(new URL('./crates/halo-core/src/js/fixtures/node-values.json', import.meta.url), 'utf8'));

describe('native lossless value wire', () => {
  it('shares the independent Node fixtures with the Rust decoder and preserves callback ownership', () => {
    const callback = () => 1;
    const signal = new AbortController().signal;
    for (const example of fixture.values) {
      const value = decodeWire(example.wire, { callback: id => { expect(id).toBe('callback-fixture'); return callback; }, signal: () => signal });
      expect(JSON.stringify(value) ?? null, example.name).toBe(example.json);
      expect(Boolean(value), example.name).toBe(example.truthy);
      expect(encodeWire(value, { callback: fn => { expect(fn).toBe(callback); return 'callback-fixture'; } }), example.name).toStrictEqual(example.wire);
    }
    const owner = { callback };
    encodeWire(owner, { callback(fn, receiver) { expect(fn).toBe(callback); expect(receiver).toBe(owner); return 'owned'; } });
  });

  it('preserves undefined properties, signed zero, exact binary64 values and ordinary marker-shaped objects', () => {
    const value = JSON.parse('{"__proto__":{"safe":true},"__haloSdkNativeUndefined":true,"__haloSdkNativeCallback":"literal","envelope":{"version":1,"data":null,"extensions":[{"kind":"undefined","path":[]}]}}');
    value.undefined = undefined;
    value.zero = -0;
    value.timestamp = 1794339331661.0015;
    const restored = decodeWire(JSON.parse(JSON.stringify(encodeWire(value)))) as typeof value;
    expect(restored).toStrictEqual(value);
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
    expect(Object.hasOwn(restored, '__proto__')).toBe(true);
    expect(Object.hasOwn(restored, 'undefined')).toBe(true);
    expect(Object.is(restored.zero, -0)).toBe(true);
    expect(Object.is(restored.timestamp, value.timestamp)).toBe(true);
  });

  it('does not mutate the envelope and refuses malformed metadata before using literal data as control', () => {
    const wire = { version: 1, data: { key: null }, extensions: [{ kind: 'undefined', path: ['key'] }] };
    const copy = structuredClone(wire);
    expect(decodeWire(wire)).toStrictEqual({ key: undefined });
    expect(wire).toStrictEqual(copy);
    for (const value of [
      { version: 2, data: null, extensions: [] },
      { version: 1, data: { a: 1 }, extensions: [{ kind: 'undefined', path: ['a'] }] },
      { version: 1, data: {}, extensions: [{ kind: 'undefined', path: ['__proto__'] }] },
      { version: 1, data: [null], extensions: [{ kind: 'undefined', path: [0] }, { kind: 'undefined', path: [0] }] },
      { version: 1, data: null, extensions: [{ kind: 'undefined', path: [] }, { kind: 'undefined', path: [0] }] },
      { version: 1, data: null, extensions: [{ kind: 'text16', path: [], units: [65536] }] },
      { version: 1, data: null, extensions: [{ kind: 'object16', path: [], entries: [
        { key: 'a', value: { version: 1, data: 1, extensions: [] } },
        { key: [97], value: { version: 1, data: 2, extensions: [] } },
      ] }] },
    ]) expect(() => decodeWire(value)).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => encodeWire(cyclic)).toThrow(/cycles/);
    expect(() => encodeWire(1n)).toThrow(/bigint/);
    expect(() => encodeWire(() => {})).toThrow(/owner/);
    expect(() => decodeWire({ version: 1, data: null, extensions: [{ kind: 'callback', path: [], id: 'missing' }] })).toThrow(/owner/);
  });
});
