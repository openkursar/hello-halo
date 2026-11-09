import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export async function measurePreviewMemory(sdk, directory) {
  assert.ok(global.gc, 'Preview memory validation requires --expose-gc');
  await fs.mkdir(directory, { recursive: true });
  const file = join(directory, 'long-line.txt');
  await fs.writeFile(file, Buffer.alloc(8 * 1024 * 1024, 120));
  const reader = sdk.getAllTools().find(tool => tool.name === 'Read');
  const context = { cwd: directory, sessionId: 'preview-memory', env: {},
    abortSignal: new AbortController().signal, currentTurn: 0, costTracker: new sdk.CostTracker('test') };
  await reader.execute({ file_path: file, limit: 1 }, context);
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const previews = [];
  for (let index = 0; index < 20; index++) {
    const result = await reader.execute({ file_path: file, limit: 1 }, context);
    assert.equal(result.isError, false);
    assert.ok(result.content.length < 41_000);
    previews.push(result.content);
  }
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
  const retainedHeapGrowthBytes = process.memoryUsage().heapUsed - before;
  assert.equal(previews.length, 20);
  await fs.rm(file);
  return { previews: previews.length, inputBytes: 8 * 1024 * 1024, retainedHeapGrowthBytes,
    limitBytes: 8 * 1024 * 1024 };
}
