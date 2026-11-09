/**
 * @module surface-contract
 * Guards the invariant that the SDK's declared surface matches what it can do:
 *
 *   1. Every public config knob is read somewhere.
 *   2. Every hook event is dispatched somewhere.
 *   3. Every stream message kind is produced somewhere.
 *
 * A declaration that no code reads is indistinguishable, to a consumer, from a
 * feature that silently does nothing — and once published it becomes a
 * compatibility contract. These checks keep the surface equal to the behavior.
 *
 * @license MIT
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK_ROOT = fileURLToPath(new URL('.', import.meta.url));
const SKIP_DIRS = ['node_modules', 'dist', 'swe-bench-eval', '.git'];

interface SourceFile {
  /** Path relative to the SDK root. */
  path: string;
  /** File contents with comments removed, so a mention in prose never counts. */
  code: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const allFiles: SourceFile[] = walk(SDK_ROOT).map((file) => ({
  path: relative(SDK_ROOT, file).split('\\').join('/'),
  code: stripComments(readFileSync(file, 'utf8')),
}));

/** Files that declare the public surface rather than implementing it. */
const isDeclarationFile = (path: string) =>
  path.startsWith('types/') || path.endsWith('-types.ts') || path.endsWith('query-types.ts');

/**
 * Implementation files that could plausibly read a knob, dispatch an event, or
 * produce a message. Tests are excluded on purpose: a value only its own test
 * touches is still unreachable in production.
 */
const implementationFiles = allFiles.filter(
  (f) => !f.path.endsWith('.test.ts') && !f.path.endsWith('.spec.ts') && !isDeclarationFile(f.path),
);

const configSource = allFiles.find((f) => f.path === 'types/config.ts');
const queryTypesSource = allFiles.find((f) => f.path === 'core/query-types.ts');

/** Body of an `export interface <name> {` declaration, by brace matching. */
function interfaceBody(source: string, name: string): string {
  const start = source.search(new RegExp(`export interface ${name} (?:extends [^{]+)?\\{`));
  expect(start, `${name} interface not found`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated ${name} interface`);
}

/** Members of an `export type <name> =` string-literal union. */
function unionMembers(source: string, name: string): string[] {
  const start = source.search(new RegExp(`export type ${name} =`));
  expect(start, `${name} union not found`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(';', start);
  const body = source.slice(start, end);
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** `type: 'x'` / `subtype: 'x'` literals inside the SDKMessage union. */
function streamKinds(): { kind: string; literal: string }[] {
  const source = queryTypesSource!.code;
  const start = source.indexOf('export type SDKMessage =');
  expect(start, 'SDKMessage union not found').toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n\nexport type AssistantMessageError', start);
  const body = source.slice(start, end);
  const kinds: { kind: string; literal: string }[] = [];
  for (const match of body.matchAll(/(type|subtype): '([^']+)'/g)) {
    kinds.push({ kind: match[1], literal: match[2] });
  }
  return kinds;
}

const mentions = (literal: string) =>
  implementationFiles.filter((f) => f.code.includes(literal));

describe('public surface contract', () => {
  it('every Options field is read by implementation code', () => {
    const body = interfaceBody(configSource!.code, 'Options');
    const fields = [...body.matchAll(/^\s{2}(?:readonly\s+)?([a-zA-Z_$][\w$]*)\??\s*:/gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(0);

    const readers = implementationFiles.filter((f) => f.path !== 'types/config.ts');
    const unread = fields.filter(
      (field) => !readers.some((f) => new RegExp(`\\b${field}\\b`).test(f.code)),
    );

    expect(
      unread,
      `Options fields declared but never read — implement the knob or delete it:\n  ${unread.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every hook event is dispatched by implementation code', () => {
    const events = unionMembers(configSource!.code, 'HookEvent');
    expect(events.length).toBeGreaterThan(0);

    const undispatched = events.filter((event) => mentions(`'${event}'`).length === 0);

    expect(
      undispatched,
      `Hook events declared but never dispatched — wire a dispatch site or delete them:\n  ${undispatched.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every stream message kind is produced by implementation code', () => {
    const kinds = streamKinds();
    expect(kinds.length).toBeGreaterThan(0);

    const unproduced = kinds
      .filter(({ literal }) => mentions(`'${literal}'`).length === 0)
      .map(({ kind, literal }) => `${kind}: '${literal}'`);

    expect(
      unproduced,
      `Stream kinds declared but never produced — a consumer's switch can never reach them:\n  ${unproduced.join('\n  ')}`,
    ).toEqual([]);
  });
});
