import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireBuildLock, createStagingDirectory, distributionState, prepareBuildWorkspace, publishDistribution,
} from './build-distribution.mjs';

const sdk = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const ifMissing = process.argv.includes('--if-missing');

async function build() {
  const lock = await acquireBuildLock(sdk);
  try {
    if (ifMissing) {
      const state = await distributionState(sdk);
      if (state.complete) {
        console.log('[halo-sdk] Reusing the existing distribution (run npm run build to rebuild)');
        return;
      }
    }
    await prepareBuildWorkspace(sdk);
    if (ifMissing && (await distributionState(sdk)).complete) {
      console.log('[halo-sdk] Reusing the existing distribution (run npm run build to rebuild)');
      return;
    }
    const staging = await createStagingDirectory(sdk);
    try {
      const { buildWorker } = await import('./build-worker.mjs');
      const { buildNative } = await import('./build-native.mjs');
      const { pruneRuntime } = await import('./prune-runtime.mjs');
      for (const [name, script, args] of [
        ['Harness generation', join(sdk, 'scripts/generate-native-text.mjs'), []],
        ['TypeScript build', require.resolve('typescript/bin/tsc'), ['--outDir', staging]],
      ]) {
        const result = spawnSync(process.execPath, [script, ...args], { cwd: sdk, stdio: 'inherit' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`${name} failed (${result.status ?? result.signal})`);
      }
      await buildWorker(join(staging, 'worker/entry.js'));
      await buildNative({ outputDirectory: join(staging, 'native') });
      await pruneRuntime(sdk, { distDirectory: staging });
      await publishDistribution(sdk, staging);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(error => {
        console.warn(`[halo-sdk] Could not remove failed build staging ${staging}: ${error.message}`);
      });
      console.error('[halo-sdk] Build failed; the existing distribution was left unchanged');
      throw error;
    }
  } finally {
    await lock.release();
  }
}

if (process.argv.includes('--check-distribution')) {
  const state = await distributionState(sdk);
  if (!state.complete) {
    console.error(`[halo-sdk] ${state.reason}`);
    process.exitCode = 1;
  }
} else if (ifMissing && (await distributionState(sdk)).complete) {
  console.log('[halo-sdk] Reusing the existing distribution (run npm run build to rebuild)');
} else {
  await build();
}
