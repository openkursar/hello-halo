import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationRuntime, MemoryScopeStore, type CollaborationExecutor, type MemberExecutionRequest, type TurnCompletion } from './index.js';

const hosts: CollaborationRuntime[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(options: { maxConcurrentTurns?: number; maxMembers?: number; idleTimeoutMs?: number } = {}) {
  const store = new MemoryScopeStore({ teamId: 'team', epochId: 'work' });
  const calls: MemberExecutionRequest[] = [];
  const finishes = new Map<string, (outcome: TurnCompletion) => void>();
  const executor: CollaborationExecutor = {
    execute: vi.fn(request => new Promise(resolve => {
      calls.push(request);
      request.ready();
      const finish = (outcome: TurnCompletion) => { request.signal.removeEventListener('abort', abort); resolve(outcome); };
      const abort = () => finish({ kind: 'error', message: 'stopped' });
      finishes.set(request.member.name, finish);
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
    })),
    inject: vi.fn(() => true),
    interrupt: vi.fn(async () => true),
    release: vi.fn(async () => {}),
    readMember: vi.fn(async () => 'record'),
    readArtifact: vi.fn(async () => 'artifact'),
    validateArtifact: vi.fn(async ref => ref),
  };
  const source = vi.fn(async () => 'dispatched' as const);
  const host = new CollaborationRuntime({ store, executor, deliverToSource: source, maxConcurrentTurns: 2, maxMembers: 8, ...options });
  hosts.push(host);
  return { host, store, calls, finishes, executor, source, server: host.serverFor() };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await Promise.resolve();
  expect(condition()).toBe(true);
}

describe('collaboration execution', () => {
  it('advertises lead and accepts a member reply there without a board lookup or alias retry', async () => {
    const f = fixture();
    await f.host.spawn(f.host.coordinatorId, { prompt: 'Inspect and report to lead.', name: 'reader' });
    await until(() => f.calls.length === 1);
    const result = await f.calls[0].server.instance.callTool('team_send', { to: 'lead', message: 'Checked.' });
    expect(result?.isError).toBeFalsy();
    expect(f.source).toHaveBeenCalledWith(expect.objectContaining({ toAppId: f.host.coordinatorId, body: 'Checked.' }), expect.anything());
    const board = JSON.stringify(await f.server.instance.callTool('team_read_board', {}));
    expect(board).toContain('lead');
    expect(board).not.toContain('coordinator');
    await expect(f.host.spawn(f.host.coordinatorId, { prompt: 'Another task.', name: 'lead' })).rejects.toThrow('other than all or lead');
  });

  it('creates members incrementally without a team or goal argument, and reuses idle members', async () => {
    const f = fixture();
    await f.host.spawn(f.host.coordinatorId, { prompt: 'inspect', name: 'reader' });
    await until(() => f.calls.length === 1);
    const id = f.calls[0].member.id;
    expect(f.calls[0].member.parentId).toBe(f.host.coordinatorId);
    f.finishes.get('reader')!({ kind: 'result', content: 'evidence' });
    await until(() => f.host.activeCount === 0);
    await f.host.send(f.host.coordinatorId, 'reader', 'check one more file');
    await until(() => f.calls.length === 2);
    expect(f.calls[1].member.id).toBe(id);
    expect(f.store.members()).toHaveLength(1);
    await f.host.spawn(f.host.coordinatorId, { prompt: 'review', name: 'reviewer' });
    expect(f.store.members()).toHaveLength(2);
  });

  it('delivers to a working member without restarting its execution', async () => {
    const f = fixture();
    await f.host.spawn(f.host.coordinatorId, { prompt: 'inspect', name: 'reader' });
    await until(() => f.calls.length === 1);
    const receipt = JSON.parse(await f.host.send(f.host.coordinatorId, 'reader', 'also check cancellation'));
    expect(receipt.delivery).toBe('mid_turn');
    expect(f.executor.inject).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(1);
  });

  it('keeps nested delegation in the same root budget and allows queued work after the parent ends', async () => {
    const f = fixture({ maxConcurrentTurns: 1, maxMembers: 2 });
    await f.host.spawn(f.host.coordinatorId, { prompt: 'inspect', name: 'reader' });
    await until(() => f.calls.length === 1);
    const childTools = f.calls[0].server;
    expect((await childTools.instance.callTool('spawn_agent', { prompt: 'check assumptions', name: 'checker' }))?.isError).toBeFalsy();
    expect(f.calls).toHaveLength(1);
    expect(f.store.members()).toHaveLength(2);
    f.finishes.get('reader')!({ kind: 'result', content: 'handed off' });
    await until(() => f.calls.length === 2);
    expect(f.calls[1].member.name).toBe('checker');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await f.calls[1].server.instance.callTool('spawn_agent', { prompt: 'one more' }))?.isError).toBe(true);
    expect(f.store.members()).toHaveLength(2);
  });

  it('resolves concurrent name collisions inside one creation sequence', async () => {
    const f = fixture();
    const handles = await Promise.all([
      f.host.spawn(f.host.coordinatorId, { name: 'reader', prompt: 'one' }),
      f.host.spawn(f.host.coordinatorId, { name: 'reader', prompt: 'two' }),
    ]);
    expect(handles).toEqual(['reader', 'reader-2']);
    expect(new Set(f.store.members().map(member => member.id)).size).toBe(2);
  });

  it('keeps stopped identity, rejects late dispatch and permits a new controller instruction', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    await f.host.spawn(f.host.coordinatorId, { name: 'reader', prompt: 'work' });
    await until(() => f.calls.length === 1);
    const oldTools = f.calls[0].server;
    await f.host.stop(f.host.coordinatorId, 'reader');
    await until(() => f.host.activeCount === 0);
    expect((await oldTools.instance.callTool('spawn_agent', { prompt: 'late work' }))?.isError).toBe(true);
    expect(f.source).not.toHaveBeenCalled();
    expect(f.store.members()[0].state).toBe('stopped');
    await f.host.send(f.host.coordinatorId, 'reader', 'continue with the new requirement');
    await until(() => f.calls.length === 2);
    expect(f.store.members()).toHaveLength(1);
  });

  it('discards old pending instructions before an explicit continuation', async () => {
    const f = fixture();
    await f.host.spawn(f.host.coordinatorId, { name: 'reader', prompt: 'First assignment.' });
    await until(() => f.calls.length === 1);
    vi.mocked(f.executor.inject).mockReturnValue(false);
    await f.host.send(f.host.coordinatorId, 'reader', 'OBSOLETE_PENDING_REQUEST');
    await f.host.stop(f.host.coordinatorId, 'reader');
    await until(() => f.host.activeCount === 0);
    await f.host.send(f.host.coordinatorId, 'reader', 'NEW_EXPLICIT_REQUEST');
    await until(() => f.calls.length === 2);
    expect(JSON.stringify(f.calls[1].deliveries)).toContain('NEW_EXPLICIT_REQUEST');
    expect(JSON.stringify(f.calls[1].deliveries)).not.toContain('OBSOLETE_PENDING_REQUEST');
  });

  it('does not let a peer bypass a stop by addressing the member identifier', async () => {
    const f = fixture();
    await f.host.spawn(f.host.coordinatorId, { name: 'reader', prompt: 'Inspect.' });
    await f.host.spawn(f.host.coordinatorId, { name: 'peer', prompt: 'Review.' });
    await until(() => f.calls.length === 2);
    const reader = f.store.findMember('reader')!;
    const peer = f.store.findMember('peer')!;
    await f.host.stop(f.host.coordinatorId, 'reader');
    await until(() => f.host.activeCount === 1);
    await expect(f.host.send(peer.id, reader.id, 'Must not resume.')).rejects.toThrow(/controller/);
    expect(f.calls).toHaveLength(2);
    await f.host.send(f.host.coordinatorId, reader.id, 'Continue explicitly.');
    await until(() => f.calls.length === 3);
    expect(f.calls[2].member.id).toBe(reader.id);
  });

  it('stops all nested executions and never expands the standing organization', async () => {
    const f = fixture();
    await f.host.spawn(f.host.coordinatorId, { name: 'reader', prompt: 'work' });
    await until(() => f.calls.length === 1);
    await f.host.spawn(f.calls[0].member.id, { name: 'checker', prompt: 'check' });
    await until(() => f.calls.length === 2);
    const result = JSON.parse(await f.host.stop(f.host.coordinatorId, 'all'));
    await until(() => f.host.activeCount === 0);
    expect(result).toHaveLength(2);
    expect(f.store.members().every(member => member.state === 'stopped')).toBe(true);
    expect(f.source).not.toHaveBeenCalled();
  });

  it('does not announce quiescence until the source accepted the end notice', async () => {
    const f = fixture();
    let accept!: () => void;
    f.source.mockImplementation(() => new Promise(resolve => { accept = () => resolve('dispatched'); }));
    await f.host.spawn(f.host.coordinatorId, { name: 'reader', prompt: 'work' });
    await until(() => f.calls.length === 1);
    f.finishes.get('reader')!({ kind: 'result', content: 'evidence' });
    await until(() => f.source.mock.calls.length === 1);
    expect(f.host.activeCount).toBe(1);
    accept();
    await until(() => f.host.activeCount === 0);
  });

  it('releases only idle execution resources and preserves reusable identity', async () => {
    vi.useFakeTimers();
    const f = fixture({ idleTimeoutMs: 100 });
    await f.host.spawn(f.host.coordinatorId, { name: 'reader', prompt: 'work' });
    await until(() => f.calls.length === 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.executor.release).not.toHaveBeenCalled();
    f.finishes.get('reader')!({ kind: 'result', content: 'result' });
    await until(() => f.host.activeCount === 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.executor.release).toHaveBeenCalledTimes(1);
    expect(f.store.members()).toHaveLength(1);
    await f.host.send(f.host.coordinatorId, 'reader', 'continue');
    await until(() => f.calls.length === 2);
    expect(f.calls[1].member.id).toBe(f.calls[0].member.id);
  });

  it('waits for an idle resource release already in progress before closing the host', async () => {
    vi.useFakeTimers();
    const f = fixture({ idleTimeoutMs: 10 });
    let released!: () => void;
    const release = new Promise<void>(resolve => { released = resolve; });
    vi.mocked(f.executor.release).mockReturnValue(release);
    await f.host.spawn(f.host.coordinatorId, { name: 'worker', prompt: 'Inspect.' });
    await until(() => f.calls.length === 1);
    f.finishes.get('worker')!({ kind: 'result', content: 'finished' });
    await until(() => f.host.activeCount === 0);
    await vi.advanceTimersByTimeAsync(11);
    expect(f.executor.release).toHaveBeenCalledOnce();
    let closed = false;
    const closing = f.host.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    released();
    await closing;
    expect(closed).toBe(true);
    expect(f.executor.release).toHaveBeenCalledOnce();
  });

  it('exposes omitted board records through the same scoped artifact tool', async () => {
    const f = fixture();
    for (let index = 0; index < 160; index++) f.store.insertFinding({ id: `finding-${index}`, teamId: 'team', epochId: 'work',
      authorAppId: f.host.coordinatorId, body: `Evidence ${index}`, ref: null, createdAt: index });
    const board = JSON.parse((await f.server.instance.callTool('team_read_board', {}))!.content[0].text);
    expect(board.truncated).toBe(true);
    let next = board.archive;
    let text = '';
    while (next) {
      const result = await f.server.instance.callTool('team_read_artifact', { ref: next });
      expect(result?.isError).not.toBe(true);
      const page = result!.content[0].text;
      const newline = page.indexOf('\n');
      next = JSON.parse(page.slice(0, newline)).next;
      text += page.slice(newline + 1);
    }
    expect(text).toContain('Evidence 0');
    expect(text).toContain('Evidence 159');
    expect(f.executor.readArtifact).not.toHaveBeenCalled();
    const other = fixture();
    expect((await other.server.instance.callTool('team_read_artifact', { ref: board.archive }))?.isError).toBe(true);
    expect(other.executor.readArtifact).not.toHaveBeenCalled();
  });

  it('records board tasks without executing them and restricts updates to the assignee', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    await f.host.spawn(f.host.coordinatorId, { name: 'reader', prompt: 'work' });
    await until(() => f.calls.length === 1);
    await f.server.instance.callTool('team_post_task', { title: 'Check', assignee: 'reader' });
    expect(f.calls).toHaveLength(1);
    expect(f.store.tasks()).toHaveLength(1);
    await f.host.spawn(f.host.coordinatorId, { name: 'other', prompt: 'other' });
    await until(() => f.calls.length === 2);
    expect((await f.calls[1].server.instance.callTool('team_update_task', { taskId: f.store.tasks()[0].id, status: 'done' }))?.isError).toBe(true);
    expect(f.store.tasks()[0].status).toBe('pending');
  });

  it('rejects a delayed publication from the previous execution after the member was stopped and resumed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    await f.host.spawn(f.host.coordinatorId, { name: 'reader', prompt: 'work' });
    await until(() => f.calls.length === 1);
    let release!: () => void;
    vi.mocked(f.executor.validateArtifact).mockImplementation(() => new Promise(resolve => { release = () => resolve('report.md'); }));
    const late = f.calls[0].server.instance.callTool('team_post_finding', { ref: 'report.md' });
    await Promise.resolve();
    await f.host.stop(f.host.coordinatorId, 'reader');
    await until(() => f.host.activeCount === 0);
    await f.host.send(f.host.coordinatorId, 'reader', 'new work');
    await until(() => f.calls.length === 2);
    release();
    expect((await late)?.isError).toBe(true);
    expect(f.store.findings()).toHaveLength(0);
  });
});
