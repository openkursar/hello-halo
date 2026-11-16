import { describe, expect, it } from 'vitest';
import { MemoryScopeStore } from '../../native/collaboration.js';

describe('bounded board reads', () => {
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
