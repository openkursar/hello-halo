import { describe, expect, it } from 'vitest';
import { BoardPages, type BoardSnapshot } from './board-pages.js';
import { MemoryScopeStore } from './memory-store.js';

function board(): BoardSnapshot {
  return { members: [{ name: 'lead' }], tasks: Array.from({ length: 180 }, (_, id) => ({ id, title: `Task ${id}` })),
    findings: [{ content: '完整内容🌱'.repeat(20000) }], activities: [{ kind: 'message', subject: 'Finished' }] };
}

describe('bounded board reads', () => {
  it('preserves every record including oversized Unicode content through artifact pages', () => {
    const pages = new BoardPages();
    const full = board();
    const preview = pages.preview('one', () => full);
    expect(Buffer.byteLength(preview)).toBeLessThan(26 * 1024);
    const summary = JSON.parse(preview);
    expect(summary.truncated).toBe(true);
    expect(summary.counts.tasks).toBe(180);
    let ref: string | null = summary.archive;
    let text = '';
    let reads = 0;
    while (ref) {
      const page = pages.read(ref)!;
      expect(Buffer.byteLength(page)).toBeLessThan(26 * 1024);
      const newline = page.indexOf('\n');
      ref = JSON.parse(page.slice(0, newline)).next;
      text += page.slice(newline + 1);
      expect(++reads).toBeLessThan(30);
    }
    const restored = text.trim().split('\n').map(row => JSON.parse(row));
    expect(restored.filter(row => row.section === 'tasks').map(row => row.record)).toEqual(full.tasks);
    expect(restored.find(row => row.section === 'findings').record).toEqual(full.findings[0]);
    expect(restored.at(-1).record).toEqual(full.activities[0]);
  });

  it('reuses an unchanged snapshot and reports expired references instead of mixing newer data', () => {
    const pages = new BoardPages();
    const first = JSON.parse(pages.preview('one', board));
    expect(JSON.parse(pages.preview('one', () => { throw new Error('Must not reread'); })).archive).toBe(first.archive);
    pages.preview('two', board);
    expect(pages.read(first.archive)).toContain('Task 0');
    pages.preview('three', board);
    expect(() => pages.read(first.archive)).toThrow(/expired/);
    expect(pages.read('ordinary-file.txt')).toBeUndefined();
  });

  it('rejects byte-budget overflow without changing committed records or name lookup', () => {
    const store = new MemoryScopeStore({ teamId: 't', epochId: 'e', maxBytes: 2000 });
    store.addMember({ id: 'one', name: 'first', parentId: 'root', prompt: 'Work', createdAt: 1 });
    expect(() => store.addMember({ id: 'one', name: 'wrong', parentId: 'root', prompt: 'x'.repeat(5000), createdAt: 1 })).toThrow(/byte limit/);
    expect(store.findMember('first')?.id).toBe('one');
    expect(store.findMember('wrong')).toBeUndefined();
    expect(() => store.addMember({ id: 'bad', name: 'bad', parentId: 'root', prompt: { nested: 'large' } as never, createdAt: 1 })).toThrow(/scalar/);
    expect(store.getMember('bad')).toBeUndefined();
    store.addMember({ id: 'one', name: 'renamed', parentId: 'root', prompt: 'Work', createdAt: 1 });
    expect(store.findMember('first')).toBeUndefined();
    expect(store.findMember('renamed')?.id).toBe('one');
    store.removeMember('one');
    store.addMember({ id: 'two', name: 'next', parentId: 'root', prompt: 'Work', createdAt: 1 });
    expect(store.members()).toHaveLength(1);
  });
});
