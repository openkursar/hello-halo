/**
 * @module tools/file-read-state.test
 * Unit tests for the shared read-state map helper.
 */

import { describe, it, expect } from 'vitest';
import type { FileReadState } from '../types/tool.js';
import { isFileStateFresh, setFileReadState } from './file-read-state.js';
import { hashFileContent } from './file-access.js';

function entry(name: string): FileReadState {
  return { content: name, timestamp: 1 };
}

describe('setFileReadState', () => {
  it('no-ops when the map is absent', () => {
    expect(() => setFileReadState(undefined, '/a', entry('a'))).not.toThrow();
  });

  it('records entries and refreshes insertion order on re-record', () => {
    const map = new Map<string, FileReadState>();
    setFileReadState(map, '/a', entry('a'));
    setFileReadState(map, '/b', entry('b'));
    setFileReadState(map, '/a', entry('a2'));

    expect(map.get('/a')?.content).toBe('a2');
    expect([...map.keys()]).toEqual(['/b', '/a']);
  });

  it('drops oversized text while retaining a full-file digest and authorization', () => {
    const map = new Map<string, FileReadState>();
    const content = 'large'.repeat(100_000);
    setFileReadState(map, '/large', { content, timestamp: 1 });
    const state = map.get('/large')!;
    expect(state.content).toBeUndefined();
    expect(state.contentHash).toBe(hashFileContent(content));
    expect(state.isPartialView).toBeUndefined();
    expect(isFileStateFresh(state, hashFileContent(content), 1, false)).toBe(true);
    expect(isFileStateFresh(state, hashFileContent(content), 2, true)).toBe(true);
  });

  it('bounds retained text to 2 MiB and tolerates external map mutations', () => {
    const map = new Map<string, FileReadState>();
    const content = '界'.repeat(2048);
    for (let i = 0; i < 600; i++) {
      setFileReadState(map, `/file-${i}`, { content, timestamp: 1 });
    }
    expect([...map.values()].reduce((sum, state) => sum + (state.content?.length ?? 0) * 2, 0)).toBe(2 * 1024 * 1024);
    map.clear();
    setFileReadState(map, '/after-clear', { content, timestamp: 1 });
    map.delete('/after-clear');
    setFileReadState(map, '/after-delete', { content: '🙂'.repeat(2048), timestamp: 1 });
    expect(map.size).toBe(1);
    expect(map.get('/after-delete')?.content).toBeUndefined();
    expect(map.get('/after-delete')?.contentHash).toHaveLength(64);
  });

  it('never treats a partial-view digest as a whole-file digest', () => {
    const map = new Map<string, FileReadState>();
    setFileReadState(map, '/partial', { content: 'fragment', timestamp: 1, isPartialView: true });
    expect(map.get('/partial')?.contentHash).toBeUndefined();
    expect(isFileStateFresh(map.get('/partial')!, hashFileContent('fragment'), 1, true)).toBe(false);
  });

  it('evicts the oldest entry once 512 files are tracked', () => {
    const map = new Map<string, FileReadState>();
    for (let i = 0; i < 512; i++) {
      setFileReadState(map, `/file-${i}`, entry(String(i)));
    }
    expect(map.size).toBe(512);

    setFileReadState(map, '/file-new', entry('new'));
    expect(map.size).toBe(512);
    expect(map.has('/file-0')).toBe(false);
    expect(map.has('/file-1')).toBe(true);
    expect(map.has('/file-new')).toBe(true);
  });
});
