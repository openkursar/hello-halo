import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBlackboardWriter,
  resolvePublishedArtifact,
  findConflictingPublisher,
  isPublishedArtifactRef,
} from './index.js';
import type { BlackboardTask, BlackboardFinding, TeamActivity, BlackboardWriteStore } from './index.js';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  let nextId = 0;
  const tasks = new Map<string, BlackboardTask>();
  const findings: BlackboardFinding[] = [];
  const activities: TeamActivity[] = [];
  const order: string[] = [];
  const store: BlackboardWriteStore = {
    insertTask: task => { order.push('persist'); tasks.set(task.id, { ...task }); },
    getTaskById: id => tasks.get(id) ?? null,
    updateTask: (id, patch, now) => { order.push('persist'); Object.assign(tasks.get(id)!, patch, { updatedAt: now }); },
    insertFinding: finding => { order.push('persist'); findings.push({ ...finding }); },
    insertActivity: activity => { order.push('persist'); activities.push({ ...activity }); },
  };
  const onChange = vi.fn(() => { order.push('change'); });
  const onWrite = vi.fn(() => { order.push('replicate'); });
  const writer = createBlackboardWriter({ store, onChange, onWrite, clock: () => 100, createId: () => String(++nextId) });
  return { writer, store, tasks, findings, activities, order, onChange, onWrite };
}

const taskInput = { teamId: 'team', epochId: 'work', callerAppId: 'owner', title: 'Inspect', assigneeAppId: 'member' };

describe('shared board writes', () => {
  it('persists before notification and replication without an execution callback', () => {
    const f = fixture();
    const { taskId } = f.writer.postTask(taskInput);
    expect(f.order).toEqual(['persist', 'change', 'replicate']);
    expect(f.tasks.get(taskId)).toMatchObject({ status: 'pending', createdAt: 100, updatedAt: 100, assigneeAppId: 'member' });
    expect(f.onWrite).toHaveBeenCalledWith(expect.objectContaining({ op: 'post_task', taskId }));
    f.writer.updateTask({ teamId: 'team', epochId: 'work', taskId, status: 'done', note: 'Evidence checked' });
    expect(f.tasks.get(taskId)).toMatchObject({ status: 'done', note: 'Evidence checked', title: 'Inspect' });
  });

  it('does not change or publish a task from another work scope', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    const { taskId } = f.writer.postTask(taskInput);
    f.onWrite.mockClear();
    f.onChange.mockClear();
    expect(() => f.writer.updateTask({ teamId: 'team', epochId: 'other', taskId, status: 'done' })).toThrow('not in this collaboration');
    expect(f.tasks.get(taskId)?.status).toBe('pending');
    expect(f.onWrite).not.toHaveBeenCalled();
    expect(f.onChange).not.toHaveBeenCalled();
    expect(() => f.writer.postTask({ ...taskInput, epochId: 'other', parentId: taskId })).toThrow('parent task');
    expect(f.tasks.size).toBe(1);
  });

  it('retains the committed write and still notifies replication when a view observer fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture();
    const notify = vi.fn();
    const writer = createBlackboardWriter({ store: f.store, onChange: () => { throw new Error('view disconnected'); }, onWrite: notify });
    const { findingId } = writer.postFinding({ teamId: 'team', epochId: 'work', callerAppId: 'member', content: 'Finding' });
    expect(f.findings[0]).toMatchObject({ id: findingId, body: 'Finding' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not announce an uncommitted write', () => {
    const f = fixture();
    f.store.insertTask = () => { throw new Error('storage unavailable'); };
    expect(() => f.writer.postTask(taskInput)).toThrow('storage unavailable');
    expect(f.onWrite).not.toHaveBeenCalled();
    expect(f.onChange).not.toHaveBeenCalled();
  });

  it('keeps findings and reply records distinct and retains correlation', () => {
    const f = fixture();
    f.writer.postFinding({ teamId: 'team', epochId: 'work', callerAppId: 'member', content: 'Shared fact' });
    f.writer.postActivity({ teamId: 'team', epochId: 'work', actorAppId: 'member', targetAppId: 'owner', kind: 'reply', subject: 'Report', body: 'Directed reply', correlationId: 'request', id: 'reply-id' });
    expect(f.findings).toHaveLength(1);
    expect(f.activities).toEqual([expect.objectContaining({ id: 'reply-id', correlationId: 'request', targetAppId: 'owner', body: 'Directed reply' })]);
  });

  it('refuses ambiguous artifact ownership instead of choosing a machine arbitrarily', () => {
    const store = {
      listFindingsByEpoch: () => [{ ref: 'report.md', authorAppId: 'alice' }],
      listTasksByEpoch: () => [{ resultRef: 'report.md', assigneeAppId: 'bob' }],
    };
    expect(resolvePublishedArtifact(store, 'team', 'work', 'report.md')).toEqual({ kind: 'ambiguous', authorAppIds: ['alice', 'bob'] });
    expect(isPublishedArtifactRef(store, 'team', 'work', 'report.md')).toBe(false);
    expect(findConflictingPublisher(store, 'team', 'work', 'report.md', 'alice')).toBe('bob');
  });
});
