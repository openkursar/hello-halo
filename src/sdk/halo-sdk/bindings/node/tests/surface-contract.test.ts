import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdk = fileURLToPath(new URL('../../..', import.meta.url));
const skipped = new Set(['node_modules', 'dist', 'target', 'tests', 'fixtures', 'swe-bench-eval', '.git', '.temp']);
function sources(directory: string, files: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    if (skipped.has(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) sources(path, files);
    else if (/\.(?:ts|rs)$/.test(path) && !/\.(?:test|spec)\.ts$/.test(path) && !path.endsWith('_tests.rs')) files.push(path);
  }
  return files;
}
function implementation(source: string): string {
  return source.replace(/#\[cfg\(test\)\]\s*(?:#\[[^\]]+\]\s*)*mod\s+\w+\s*\{[\s\S]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const files = sources(join(sdk, 'bindings/node')).concat(sources(join(sdk, 'crates/halo-core/src')))
  .map(path => ({ path: relative(sdk, path).replaceAll('\\', '/'), code: implementation(readFileSync(path, 'utf8')) }));
const runtime = files.filter(file => !file.path.includes('/contracts/') && !file.path.includes('/types/'));
const config = readFileSync(join(sdk, 'bindings/node/types/config.ts'), 'utf8');
const messages = readFileSync(join(sdk, 'bindings/node/contracts/core/query-types.ts'), 'utf8');
function interfaceBody(source: string, name: string): string {
  const match = new RegExp(`export interface ${name} (?:extends [^{]+)?\\{`).exec(source);
  if (!match) throw new Error(`Missing interface ${name}`);
  const open = source.indexOf('{', match.index);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`Unterminated interface ${name}`);
}
const mentioned = (value: string) => runtime.some(file => file.code.includes(`'${value}'`) || file.code.includes(`"${value}"`));

describe('public surface contract', () => {
  it('every configuration field is read by the Rust implementation or Node adapter', () => {
    const fields = [...interfaceBody(config, 'Options').matchAll(/^\s{2}(?:readonly\s+)?([a-zA-Z_$][\w$]*)\??\s*:/gm)].map(match => match[1]);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.filter(field => !runtime.some(file => new RegExp(`\\b${field}\\b`).test(file.code)))).toEqual([]);
  });

  it('every hook and stream kind is produced by runtime code, not declarations alone', () => {
    const hooks = /export type HookEvent =([\s\S]*?);/.exec(config)![1];
    const union = messages.slice(messages.indexOf('export type SDKMessage ='), messages.indexOf('export type AssistantMessageError'));
    const literals = [...hooks.matchAll(/'([^']+)'/g), ...union.matchAll(/(?:type|subtype): '([^']+)'/g)].map(match => match[1]);
    expect(literals.length).toBeGreaterThan(0);
    expect([...new Set(literals)].filter(value => !mentioned(value))).toEqual([]);
  });

  it('keeps the core independent of Node and Halo and has no retired TypeScript engine', () => {
    const manifest = readFileSync(join(sdk, 'crates/halo-core/Cargo.toml'), 'utf8');
    expect(manifest).not.toMatch(/napi|halo-node|electron/);
    const emitted = files.filter(file => file.path.startsWith('bindings/node/') && !file.path.includes('/crate/'));
    expect(emitted.every(file => !/from ['"][^'"]*(?:src\/main|electron)[^'"]*['"]/.test(file.code))).toBe(true);
    for (const retired of ['core', 'llm', 'tools', 'prompt', 'skills', 'commands']) {
      const path = join(sdk, retired);
      if (readdirSync(sdk).includes(retired)) expect(sources(path)).toEqual([]);
    }
  });
});
