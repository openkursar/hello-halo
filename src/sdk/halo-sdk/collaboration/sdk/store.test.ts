import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openFileScopeStore, type FileScopeStoreHandle } from './store.js';
import type { CollaborationMember } from '../runtime.js';

let directory: string;
const handles: FileScopeStoreHandle[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'collaboration-journal-')); });
afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.close()));
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function member(name = 'reader'): CollaborationMember {
  return { id: randomUUID(), name, parentId: 'coordinator', prompt: 'Inspect assigned work', createdAt: Date.now(), state: 'idle' };
}

async function opened() {
  const handle = await openFileScopeStore({ path: join(directory, 'events.jsonl'), teamId: 'team', epochId: 'work' });
  handles.push(handle);
  return handle;
}

describe('local collaboration journal', () => {
  it('restores durable identities and state without starting execution', async () => {
    const first = await opened();
    const row = member();
    first.store.addMember(row);
    await first.store.flush();
    first.store.addMember({ ...row, state: 'stopped', model: 'configured-model' });
    await first.close();
    const next = await opened();
    expect(next.store.getMember(row.id)).toMatchObject({ name: 'reader', state: 'stopped', model: 'configured-model' });
  });

  it('preserves an interrupted trailing record and resumes after exact UTF-8 byte offsets', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await opened();
    const row = member('研究员');
    first.store.addMember(row);
    await first.close();
    await appendFile(join(directory, 'events.jsonl'), '\n\n{"type":"mutation","value":"unfinished');
    const restored = await opened();
    expect(restored.store.getMember(row.id)?.name).toBe('研究员');
    const next = member('reviewer');
    restored.store.addMember(next);
    await restored.close();
    const again = await opened();
    expect(again.store.members()).toHaveLength(2);
    const recovery = (await readdir(directory)).find(name => name.includes('.recovery-'));
    expect(recovery).toBeDefined();
    expect(await readFile(join(directory, recovery!), 'utf8')).toContain('unfinished');
  });

  it('adds a separator before appending to a valid journal with no trailing newline', async () => {
    const first = await opened();
    first.store.addMember(member());
    await first.close();
    const path = join(directory, 'events.jsonl');
    await writeFile(path, (await readFile(path, 'utf8')).trimEnd());
    const next = await opened();
    next.store.addMember(member('other'));
    await next.close();
    expect((await opened()).store.members()).toHaveLength(2);
  });

  it('refuses damaged middle records without replacing the journal with empty state', async () => {
    const first = await opened();
    first.store.addMember(member());
    await first.close();
    const path = join(directory, 'events.jsonl');
    const original = await readFile(path, 'utf8');
    const broken = `${original}broken record\n${original.split('\n')[1]}\n`;
    await writeFile(path, broken);
    await expect(opened()).rejects.toThrow('damaged non-final');
    expect(await readFile(path, 'utf8')).toBe(broken);
    await writeFile(path, original);
    expect((await opened()).store.members()).toHaveLength(1);
  });

  it('does not let a second owner read before the first owner flushes and releases', async () => {
    const first = await opened();
    const row = member();
    first.store.addMember(row);
    let entered = false;
    const second = opened().then(handle => { entered = true; return handle; });
    await Promise.resolve();
    expect(entered).toBe(false);
    await first.close();
    expect((await second).store.getMember(row.id)?.name).toBe('reader');
  });
});
