import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorker } from './build-worker.mjs';
import { buildNative } from './build-native.mjs';
import { pruneRuntime } from './prune-runtime.mjs';

const sdk = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
await rm(join(sdk, 'dist'), { recursive: true, force: true });
for (const [name, script] of [
  ['Harness generation', join(sdk, 'scripts/generate-native-text.mjs')],
  ['TypeScript build', require.resolve('typescript/bin/tsc')],
]) {
  const result = spawnSync(process.execPath, [script], { cwd: sdk, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed (${result.status ?? result.signal})`);
}
await buildWorker();
await buildNative();
await pruneRuntime(sdk);
