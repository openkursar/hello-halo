import { loadBinding, nativeError, parseNativeValue, stringifyNativeValue } from './binding.js';
import { createCollaborationCallbacks } from './collaboration-callbacks.js';
import type { CollaborationMember, CollaborationScopeStore } from '../collaboration/runtime.js';
import type { BlackboardTask, BlackboardFinding, TeamActivity } from '../collaboration/records.js';
import type { CollaborationMutation, MemoryScopeStoreOptions } from '../collaboration/memory-store.js';

export type { CollaborationMutation, MemoryScopeStoreOptions } from '../collaboration/memory-store.js';
const scalarRecord = (row: object): unknown[] => Object.entries(row).map(([key, value]) => [key, value === null ? 'null' : typeof value, value]);

export class MemoryScopeStore implements CollaborationScopeStore {
  readonly teamId: string;
  readonly epochId: string;
  private readonly handle;
  private readonly callbacks;
  constructor(options: MemoryScopeStoreOptions) {
    this.teamId = options.teamId;
    this.epochId = options.epochId;
    this.callbacks = createCollaborationCallbacks((name, input) => {
      if (name !== 'persist') throw new Error(`Unknown native collaboration store callback: ${name}`);
      return options.persist?.(parseNativeValue(JSON.stringify(input.mutations)));
    });
    try {
      this.handle = new (loadBinding().NativeCollaborationStore)(stringifyNativeValue({
        teamId: options.teamId, epochId: options.epochId, maxBytes: options.maxBytes ?? null,
        maxRecords: options.maxRecords ?? null, persist: !!options.persist,
      }), this.callbacks.callback);
    } catch (error) { throw nativeError(error); }
  }
  private call<T>(name: string, input: unknown): T {
    try { return parseNativeValue(this.handle.call(name, stringifyNativeValue(input))) as T; }
    catch (error) { throw nativeError(error); }
  }
  private write(mutation: CollaborationMutation, replay = false): void {
    this.call(replay ? 'apply' : 'record', mutation.kind === 'remove_member'
      ? mutation : { kind: mutation.kind, row: scalarRecord(mutation.value) });
  }
  getMember(id: string): CollaborationMember | undefined { return this.call<CollaborationMember | null>('get', { kind: 'member', id }) ?? undefined; }
  findMember(name: string): CollaborationMember | undefined { return this.call<CollaborationMember | null>('findMember', { name }) ?? undefined; }
  members(): CollaborationMember[] { return this.call('rows', { kind: 'member' }); }
  tasks(): BlackboardTask[] { return this.call('rows', { kind: 'task' }); }
  findings(): BlackboardFinding[] { return this.call('rows', { kind: 'finding' }); }
  activities(): TeamActivity[] { return this.call('rows', { kind: 'activity' }); }
  apply(mutation: CollaborationMutation): void { this.write(mutation, true); }
  addMember(value: CollaborationMember): void { this.write({ kind: 'member', value }); }
  removeMember(id: string): void { this.write({ kind: 'remove_member', id }); }
  insertTask(value: BlackboardTask): void { this.write({ kind: 'task', value }); }
  getTaskById(id: string): BlackboardTask | null { return this.call('get', { kind: 'task', id }); }
  updateTask(id: string, patch: Partial<Pick<BlackboardTask, 'status' | 'resultRef' | 'note'>>, now: number): void {
    this.call('updateTask', { id, patch: scalarRecord(patch), now });
  }
  insertFinding(value: BlackboardFinding): void { this.write({ kind: 'finding', value }); }
  insertActivity(value: TeamActivity): void { this.write({ kind: 'activity', value }); }
  async flush(): Promise<void> {
    try { await this.handle.flush(this.callbacks.callback); }
    catch (error) { throw this.callbacks.error(error); }
  }
}
