import type { BlackboardTask, BlackboardFinding, TeamActivity } from './records.js';
import type { CollaborationMember, CollaborationScopeStore } from './runtime.js';

export type CollaborationMutation =
  | { kind: 'member'; value: CollaborationMember }
  | { kind: 'remove_member'; id: string }
  | { kind: 'task'; value: BlackboardTask }
  | { kind: 'finding'; value: BlackboardFinding }
  | { kind: 'activity'; value: TeamActivity };

export interface MemoryScopeStoreOptions {
  teamId: string;
  epochId: string;
  maxRecords?: number;
  maxBytes?: number;
  persist?: (mutations: readonly CollaborationMutation[]) => Promise<void>;
}

/** A bounded local host store. Durable hosts supply a journal and replay it before use. */
export class MemoryScopeStore implements CollaborationScopeStore {
  readonly teamId: string;
  readonly epochId: string;
  private readonly memberRows = new Map<string, CollaborationMember>();
  private readonly taskRows = new Map<string, BlackboardTask>();
  private readonly findingRows = new Map<string, BlackboardFinding>();
  private readonly activityRows = new Map<string, TeamActivity>();
  private readonly names = new Map<string, string>();
  private readonly sizes = new Map<string, number>();
  private bytes = 0;
  private readonly maxBytes: number;
  private pending: CollaborationMutation[] = [];
  private writing: Promise<void> = Promise.resolve();
  private readonly maxRecords: number;

  constructor(private readonly options: MemoryScopeStoreOptions) {
    this.teamId = options.teamId;
    this.epochId = options.epochId;
    this.maxRecords = options.maxRecords ?? 10000;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new TypeError('maxBytes must be a positive integer');
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1) throw new TypeError('maxRecords must be a positive integer');
  }

  getMember(id: string): CollaborationMember | undefined {
    const member = this.memberRows.get(id);
    return member ? { ...member } : undefined;
  }
  findMember(name: string): CollaborationMember | undefined {
    const id = this.names.get(name);
    return id ? this.getMember(id) : undefined;
  }
  members(): CollaborationMember[] { return [...this.memberRows.values()].map(member => ({ ...member })); }
  tasks(): BlackboardTask[] { return [...this.taskRows.values()].map(task => ({ ...task })); }
  findings(): BlackboardFinding[] { return [...this.findingRows.values()].map(finding => ({ ...finding })); }
  activities(): TeamActivity[] { return [...this.activityRows.values()].map(activity => ({ ...activity })); }

  private capacity(rows: Map<string, unknown>, id: string): void {
    if (!rows.has(id) && rows.size >= this.maxRecords) throw new Error('The local collaboration record limit was reached. Use a host store sized for this workload.');
  }
  private record(mutation: CollaborationMutation): void {
    this.apply(mutation);
    if (this.options.persist) this.pending.push(mutation);
  }
  /** Replay does not produce new writes or start any execution. */
  apply(mutation: CollaborationMutation): void {
    if (mutation.kind === 'remove_member') {
      const previous = this.memberRows.get(mutation.id);
      if (previous) this.names.delete(previous.name);
      this.memberRows.delete(mutation.id);
      const key = `member:${mutation.id}`;
      this.bytes -= this.sizes.get(key) ?? 0;
      this.sizes.delete(key);
      return;
    }
    if (mutation.kind === 'member') {
      this.capacity(this.memberRows, mutation.value.id);
      const existing = this.findMember(mutation.value.name);
      if (existing && existing.id !== mutation.value.id) throw new Error('Duplicate collaboration member name');
      this.account('member', mutation.value);
      const previous = this.memberRows.get(mutation.value.id);
      if (previous && previous.name !== mutation.value.name) this.names.delete(previous.name);
      this.names.set(mutation.value.name, mutation.value.id);
      this.memberRows.set(mutation.value.id, { ...mutation.value });
      return;
    }
    if (mutation.value.teamId !== this.teamId || mutation.value.epochId !== this.epochId) throw new Error('Collaboration record has a different scope');
    if (mutation.kind === 'task') { this.capacity(this.taskRows, mutation.value.id); this.account('task', mutation.value); this.taskRows.set(mutation.value.id, { ...mutation.value }); }
    else if (mutation.kind === 'finding') { this.capacity(this.findingRows, mutation.value.id); this.account('finding', mutation.value); this.findingRows.set(mutation.value.id, { ...mutation.value }); }
    else { this.capacity(this.activityRows, mutation.value.id); this.account('activity', mutation.value); this.activityRows.set(mutation.value.id, { ...mutation.value }); }
  }
  private account(kind: string, row: { id: string }): void {
    let size = 64;
    for (const [key, value] of Object.entries(row)) {
      if (value !== null && value !== undefined && !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new TypeError('Collaboration records contain only scalar fields.');
      }
      if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Collaboration numbers must be finite.');
      size += Buffer.byteLength(key) * 6 + (typeof value === 'string' ? Buffer.byteLength(value) * 6 : 16);
    }
    const key = `${kind}:${row.id}`;
    const next = this.bytes - (this.sizes.get(key) ?? 0) + size;
    if (size > 1024 * 1024 || next > this.maxBytes) throw new Error('The local collaboration byte limit was reached. The record was not accepted.');
    this.bytes = next;
    this.sizes.set(key, size);
  }
  addMember(member: CollaborationMember): void { this.record({ kind: 'member', value: { ...member } }); }
  removeMember(id: string): void { this.record({ kind: 'remove_member', id }); }
  insertTask(task: BlackboardTask): void { this.record({ kind: 'task', value: { ...task } }); }
  getTaskById(id: string): BlackboardTask | null {
    const task = this.taskRows.get(id);
    return task ? { ...task } : null;
  }
  updateTask(id: string, patch: Partial<Pick<BlackboardTask, 'status' | 'resultRef' | 'note'>>, now: number): void {
    const task = this.taskRows.get(id);
    if (!task) throw new Error('Unknown collaboration task');
    this.record({ kind: 'task', value: { ...task, ...patch, updatedAt: now } });
  }
  insertFinding(finding: BlackboardFinding): void { this.record({ kind: 'finding', value: { ...finding } }); }
  insertActivity(activity: TeamActivity): void { this.record({ kind: 'activity', value: { ...activity } }); }

  flush(): Promise<void> {
    const write = this.writing.then(async () => {
      if (!this.pending.length || !this.options.persist) return;
      const batch = this.pending.splice(0);
      try { await this.options.persist(batch); }
      catch (error) {
        // Keep ownership: a caller can explicitly retry flushing, never replay its operation.
        this.pending.unshift(...batch);
        console.error('[Collaboration] Journal write failed; mutations retained', error);
        throw error;
      }
    });
    this.writing = write.catch(() => {});
    return write;
  }
}
