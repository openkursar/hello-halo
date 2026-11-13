import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { sourceIdentity } = createRequire(import.meta.url)('./source-identity.cjs') as { sourceIdentity(path: string): string };
const directories: string[] = [];
const source = { 'Cargo.lock': 'locked dependencies', 'src/lib.rs': 'pub fn run() {}',
  'assets/search.cjs': 'module.exports = {};', 'assets/adapter.mjs': 'export {};', 'assets/text.json': '{"text":"Runtime text"}' };

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'halo-native-source-'));
  directories.push(directory);
  await mkdir(join(directory, 'src')); await mkdir(join(directory, 'assets'));
  for (const [path, text] of Object.entries(source)) await writeFile(join(directory, path), text);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('native source identity', () => {
  it('remains stable across source snapshots and ignores compiled target output', async () => {
    const first = await fixture(), second = await fixture();
    const identity = sourceIdentity(first);
    await mkdir(join(first, 'target')); await writeFile(join(first, 'target/output.json'), '{"artifact":true}');
    expect(sourceIdentity(first)).toBe(identity);
    expect(sourceIdentity(second)).toBe(identity);
  });

  it('invalidates compiled libraries after embedded adapters or resources change', async () => {
    const directory = await fixture();
    const identity = sourceIdentity(directory);
    for (const [path, text] of Object.entries(source)) {
      await writeFile(join(directory, path), `${text}\nchanged`);
      expect(sourceIdentity(directory), path).not.toBe(identity);
      await writeFile(join(directory, path), text);
    }
    expect(sourceIdentity(directory)).toBe(identity);
  });
});
