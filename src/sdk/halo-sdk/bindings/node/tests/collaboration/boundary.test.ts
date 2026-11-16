import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('collaboration package boundary', () => {
  it('bundles the browser protocol without any Node or native dependency', async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL('../../collaboration/protocol.ts', import.meta.url))],
      bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true,
    });
    const inputs = Object.keys(result.metafile!.inputs).map(path => path.replaceAll('\\', '/'));
    expect(inputs.every(path => path.includes('bindings/node/collaboration/'))).toBe(true);
    expect(Object.values(result.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
  });

  it('keeps generic turn admission independent of model execution and board operations', async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL('../../native/turn-gate.ts', import.meta.url))],
      bundle: true, platform: 'node', format: 'esm', write: false, metafile: true,
    });
    const inputs = Object.keys(result.metafile!.inputs).map(path => path.replaceAll('\\', '/'));
    expect(inputs.some(path => path.endsWith('/native/binding.ts'))).toBe(true);
    expect(inputs.some(path => /\/(?:worker|core)\/|\/native\/(?:session|query-loop|collaboration-board)\.ts$/.test(path))).toBe(false);
  });
});
