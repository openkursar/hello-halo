import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getArchivedRecordMessages, listArchivedRecords } from '../../index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-archive-'));
  directories.push(directory);
  const cwd = '/test/project/dir';
  const archive = join(directory, 'projects', '-test-project-dir', 'parent', 'subagents');
  const options = { cwd, env: { SDK_STATE: directory }, conventions: { configDirEnv: 'SDK_STATE' } };
  async function seed(id: string, records: Record<string, unknown>[]) {
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, `agent-${id}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  }
  return { options, seed };
}

describe('archived transcript public history API', () => {
  it('returns empty collections for absent archives', async () => {
    const { options } = await fixture();
    expect(await listArchivedRecords('parent', options)).toEqual([]);
    expect(await getArchivedRecordMessages('parent', 'missing', options)).toEqual([]);
  });

  it('reads stored related records, skips non-message records and respects pagination', async () => {
    const { options, seed } = await fixture();
    await seed('child', [
      { type: 'assistant', message: { role: 'assistant', content: 'msg1' }, uuid: 'one' },
      { type: 'result', message: null }, { type: 'system', message: null },
      { type: 'user', message: { role: 'user', content: 'msg2' }, uuid: 'two' },
      { type: 'assistant', message: { role: 'assistant', content: 'msg3' }, uuid: 'three' },
    ]);
    const records = await getArchivedRecordMessages('parent', 'child', options);
    expect(records).toHaveLength(3);
    expect(records[0].type).toBe('assistant');
    expect(records[0].session_id).toBe('child');
    expect(records[1].type).toBe('user');
    const page = await getArchivedRecordMessages('parent', 'child', { ...options, limit: 2, offset: 1 });
    expect(page).toHaveLength(2);
    expect(page.map(record => (record.message as { content: string }).content)).toEqual(['msg2', 'msg3']);
  });

  it('lists every child and isolates configured storage roots', async () => {
    const { options, seed } = await fixture();
    await seed('child-a', [{ type: 'assistant', message: { role: 'assistant', content: 'hi' } }]);
    await seed('child-b', [{ type: 'assistant', message: { role: 'assistant', content: 'hi' } }]);
    expect((await listArchivedRecords('parent', options)).sort()).toEqual(['child-a', 'child-b']);
    expect(await listArchivedRecords('parent', { ...options, env: { SDK_STATE: join(options.env.SDK_STATE, 'other') } })).toEqual([]);
  });
});
