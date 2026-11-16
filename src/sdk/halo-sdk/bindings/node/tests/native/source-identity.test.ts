import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const { sourceIdentity } = createRequire(import.meta.url)('../../../../scripts/source-identity.cjs') as { sourceIdentity(path: string): string };
const directories: string[] = [];
const source = {
  'Cargo.toml': '[workspace]', 'Cargo.lock': 'locked dependencies', 'rust-toolchain.toml': '[toolchain]',
  'crates/halo-core/src/lib.rs': 'pub fn run() {}',
  'crates/halo-core/src/search/supervisor.cjs': 'module.exports = {};',
  'crates/halo-core/src/search/adapter.mjs': 'export {};',
  'crates/halo-core/src/harness/resources/text.json': '{"text":"Runtime text"}',
  'bindings/node/crate/src/lib.rs': 'pub fn bind() {}',
  'scripts/source-identity.cjs': 'module.exports = {};',
};

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'halo-native-source-'));
  directories.push(directory);
  for (const [path, text] of Object.entries(source)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('native source identity', () => {
  it('remains stable across snapshots and excludes compiled output and Node package metadata', async () => {
    const first = await fixture(), second = await fixture();
    const identity = sourceIdentity(first);
    await mkdir(join(first, 'target')); await writeFile(join(first, 'target/output.json'), '{"artifact":true}');
    await mkdir(join(first, 'dist')); await writeFile(join(first, 'dist/build-info.json'), '{"artifact":true}');
    await writeFile(join(first, 'package.json'), '{"version":"changed"}');
    expect(sourceIdentity(first)).toBe(identity);
    expect(sourceIdentity(second)).toBe(identity);
  });

  it('invalidates compiled libraries after either crate, the toolchain or embedded resources change', async () => {
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
