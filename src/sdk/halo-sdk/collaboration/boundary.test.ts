import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('collaboration package boundary', () => {
  it('bundles the public library without any execution engine, worker or application runtime', async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
      bundle: true, platform: 'node', format: 'esm', write: false, metafile: true,
    });
    const inputs = Object.keys(result.metafile!.inputs).map(path => path.replaceAll('\\', '/'));
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.every(path => path.startsWith('collaboration/'))).toBe(true);
    expect(Object.values(result.metafile!.outputs).flatMap(output => output.imports).every(entry => entry.path.startsWith('node:'))).toBe(true);
  });

  it('keeps generic turn admission independent of tool schemas and board code', async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL('./turn-gate.ts', import.meta.url))],
      bundle: true, platform: 'node', format: 'esm', write: false, metafile: true,
    });
    const inputs = Object.keys(result.metafile!.inputs).map(path => path.replaceAll('\\', '/'));
    expect(inputs).toEqual(['collaboration/turn-gate.ts']);
    expect(Object.values(result.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
  });
});
