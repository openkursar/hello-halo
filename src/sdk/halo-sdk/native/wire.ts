export type WirePath = readonly (string | number)[];
type JsonData = null | boolean | number | string | JsonData[] | { [key: string]: JsonData };
type NumberName = 'NaN' | 'Infinity' | '-Infinity' | '-0';
interface PathExtension { path: WirePath }
export type WireExtension = PathExtension & (
  | { kind: 'undefined' | 'signal' }
  | { kind: 'number'; value: NumberName }
  | { kind: 'text16'; units: number[] }
  | { kind: 'callback'; id: string }
  | { kind: 'object16'; entries: { key: string | number[]; value: WireDocument }[] }
);
export interface WireDocument { version: 1; data: JsonData; extensions: WireExtension[] }
export interface WireEncoder { callback?(value: Function, owner?: object): string }
export interface WireDecoder { callback?(id: string): unknown; signal?(): AbortSignal }

const nativeWellFormed = (String.prototype as unknown as { isWellFormed?: (this: string) => boolean }).isWellFormed;
function wellFormed(value: string): boolean {
  if (nativeWellFormed) return nativeWellFormed.call(value);
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function units(value: string): number[] {
  return Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
}
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}
function invalid(reason: string): never { throw new TypeError(`Invalid native wire document: ${reason}`); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, names: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) invalid('unexpected fields');
}
function text16(value: unknown): string {
  if (!Array.isArray(value) || value.some(unit => !Number.isInteger(unit) || unit < 0 || unit > 65535)) invalid('invalid UTF-16 units');
  let text = '';
  for (let offset = 0; offset < value.length; offset += 16384) text += String.fromCharCode(...value.slice(offset, offset + 16384));
  return text;
}

export function encodeWire(value: unknown, callbacks: WireEncoder = {}): WireDocument {
  const ancestors = new Set<object>();
  const document = (value: unknown, owner?: object): WireDocument => {
    const extensions: WireExtension[] = [];
    const visit = (value: unknown, path: (string | number)[], owner?: object): JsonData => {
      if (value === undefined) { extensions.push({ kind: 'undefined', path }); return null; }
      if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0)) {
          extensions.push({ kind: 'number', path, value: Object.is(value, -0) ? '-0' : String(value) as NumberName });
          return null;
        }
        return value;
      }
      if (typeof value === 'string') {
        if (wellFormed(value)) return value;
        extensions.push({ kind: 'text16', path, units: units(value) }); return null;
      }
      if (typeof value === 'function') {
        if (!callbacks.callback) throw new TypeError('Native wire callbacks require an owner');
        const id = callbacks.callback(value, owner);
        if (typeof id !== 'string' || !wellFormed(id)) throw new TypeError('Native wire callback identifiers must be well-formed strings');
        extensions.push({ kind: 'callback', path, id }); return null;
      }
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value !== 'object') throw new TypeError(`Native wire values do not support ${typeof value}`);
      if (value instanceof AbortSignal) { extensions.push({ kind: 'signal', path }); return null; }
      if (ancestors.has(value)) throw new TypeError('Native wire values cannot contain cycles');
      ancestors.add(value);
      try {
        if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => visit(value[index], [...path, index]));
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
          throw new TypeError('Native wire values must be plain data outside callback and signal references');
        }
        const keys = Object.keys(value);
        const source = value as Record<string, unknown>;
        if (keys.some(key => !wellFormed(key))) {
          extensions.push({ kind: 'object16', path, entries: keys.map(key => ({ key: wellFormed(key) ? key : units(key), value: document(source[key], value) })) });
          return null;
        }
        const result: { [key: string]: JsonData } = {};
        for (const key of keys) define(result, key, visit(source[key], [...path, key], value));
        return result;
      } finally { ancestors.delete(value); }
    };
    return { version: 1, data: visit(value, [], owner), extensions };
  };
  return document(value);
}

export function decodeWire(document: unknown, callbacks: WireDecoder = {}): unknown {
  if (!record(document)) invalid('expected an object');
  exact(document, ['version', 'data', 'extensions']);
  if (document.version !== 1) invalid('unsupported version');
  if (!Array.isArray(document.extensions)) invalid('extensions must be an array');
  const cloneData = (value: unknown): JsonData => {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && wellFormed(value)) return value;
    if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => cloneData(value[index]));
    if (record(value)) {
      const result: { [key: string]: JsonData } = {};
      for (const key of Object.keys(value)) {
        if (!wellFormed(key)) invalid('unmarked UTF-16 key');
        define(result, key, cloneData(value[key]));
      }
      return result;
    }
    return invalid('data must contain only ordinary JSON values');
  };
  let data: unknown = cloneData(document.data);
  const paths = new Set<string>();
  for (const extension of document.extensions) {
    if (!record(extension) || !Array.isArray(extension.path)) invalid('extension path is required');
    if (extension.path.some(part => typeof part === 'string' ? !wellFormed(part) : !Number.isSafeInteger(part) || part < 0)) invalid('invalid extension path');
    const key = JSON.stringify(extension.path);
    if (paths.has(key)) invalid('duplicate extension path');
    paths.add(key);
  }
  for (const extension of document.extensions) {
    const path = extension.path as (string | number)[];
    for (let end = 0; end < path.length; end++) if (paths.has(JSON.stringify(path.slice(0, end)))) invalid('overlapping extension paths');
    let value: unknown;
    switch (extension.kind) {
      case 'undefined': exact(extension, ['kind', 'path']); value = undefined; break;
      case 'signal':
        exact(extension, ['kind', 'path']);
        if (!callbacks.signal) invalid('signal owner is unavailable');
        value = callbacks.signal(); break;
      case 'number':
        exact(extension, ['kind', 'path', 'value']);
        if (!['NaN', 'Infinity', '-Infinity', '-0'].includes(extension.value)) invalid('invalid number extension');
        value = Number(extension.value); break;
      case 'text16': exact(extension, ['kind', 'path', 'units']); value = text16(extension.units); break;
      case 'callback':
        exact(extension, ['kind', 'path', 'id']);
        if (typeof extension.id !== 'string' || !wellFormed(extension.id)) invalid('invalid callback identifier');
        if (!callbacks.callback) invalid('callback owner is unavailable');
        value = callbacks.callback(extension.id); break;
      case 'object16': {
        exact(extension, ['kind', 'path', 'entries']);
        if (!Array.isArray(extension.entries)) invalid('object entries must be an array');
        const object: Record<string, unknown> = {};
        for (const entry of extension.entries) {
          if (!record(entry)) invalid('invalid object entry');
          exact(entry, ['key', 'value']);
          const key = typeof entry.key === 'string' ? entry.key : text16(entry.key);
          if (typeof entry.key === 'string' && !wellFormed(entry.key)) invalid('unmarked UTF-16 key');
          if (Object.hasOwn(object, key)) invalid('duplicate object key');
          define(object, key, decodeWire(entry.value, callbacks));
        }
        value = object; break;
      }
      default: invalid('unknown extension kind');
    }
    if (path.length === 0) {
      if (data !== null) invalid('extension placeholder must be null');
      data = value;
      continue;
    }
    let target: any = data;
    for (let index = 0; index < path.length; index++) {
      const part = path[index];
      if (typeof part === 'number' ? !Array.isArray(target) : !record(target)) invalid('extension path does not exist');
      if (!Object.hasOwn(target, part)) invalid('extension path does not exist');
      if (index === path.length - 1) {
        if (target[part] !== null) invalid('extension placeholder must be null');
        define(target, String(part), value);
      } else target = target[part];
    }
  }
  return data;
}
