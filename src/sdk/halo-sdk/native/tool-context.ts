import { randomUUID } from 'node:crypto';
import { backgroundTasks } from './background-tasks.js';
import { type CostTracker, wrapCostTracker } from './values.js';
import type { FileReadState, ToolContext } from '../types/tool.js';
import type { SkillCatalog } from '../skills/index.js';
import { nativeError, parseNativeValue, stringifyNativeValue, type NativeCollaborationCallback, type NativeHandle, type NativeSharedToolState } from './binding.js';
import { registerToolAuthority, registerToolFormatter } from './tool-authority.js';

export interface ToolContextTransport {
  call(method: string, args?: unknown[]): any;
  emit(event: Record<string, unknown>): Promise<void>;
  asyncCall(method: string, args?: unknown[], signal?: AbortSignal, advisoryCancellation?: boolean): Promise<any>;
}

class NativeReadState extends Map<string, FileReadState> {
  private readonly references = new Map<string, { version: number; value: WeakRef<FileReadState> }>();
  constructor(private readonly transport: Pick<ToolContextTransport, 'call'>) { super(); }
  override get size(): number { return this.transport.call('readFileState.size'); }
  override get(key: string): FileReadState | undefined {
    const entry = this.transport.call('readFileState.getEntry', [key]) as { valueVersion: number; value: FileReadState } | null;
    if (entry === null) { this.references.delete(key); return undefined; }
    const previous = this.references.get(key);
    const retained = previous?.version === entry.valueVersion ? previous.value.deref() : undefined;
    if (retained) return retained;
    const value = new Proxy(entry.value, {
      get: (target, property, receiver) => {
        const latest = this.transport.call('readFileState.getEntry', [key]) as typeof entry;
        if (latest?.valueVersion === entry.valueVersion) {
          for (const name of Object.keys(target)) if (!(name in latest.value)) Reflect.deleteProperty(target, name);
          Object.assign(target, latest.value);
        }
        return Reflect.get(target, property, receiver);
      },
      set: (target, property, next) => {
        Reflect.set(target, property, next);
        if (typeof property === 'string') this.transport.call('readFileState.patchEntry', [key, entry.valueVersion, property, next, false]);
        return true;
      },
      deleteProperty: (target, property) => {
        Reflect.deleteProperty(target, property);
        if (typeof property === 'string') this.transport.call('readFileState.patchEntry', [key, entry.valueVersion, property, null, true]);
        return true;
      },
    });
    this.references.set(key, { version: entry.valueVersion, value: new WeakRef(value) });
    return value;
  }
  override has(key: string): boolean { return this.transport.call('readFileState.has', [key]); }
  override set(key: string, value: FileReadState): this { this.references.delete(key); this.transport.call('readFileState.set', [key, value]); return this; }
  override delete(key: string): boolean { this.references.delete(key); return this.transport.call('readFileState.delete', [key]); }
  override clear(): void { this.references.clear(); this.transport.call('readFileState.clear'); }
  override *entries(): MapIterator<[string, FileReadState]> {
    let sequence = 0;
    while (true) {
      const entry = this.transport.call('readFileState.next', [sequence]) as { sequence: number; key: string } | null;
      if (!entry) return;
      sequence = entry.sequence;
      const value = this.get(entry.key);
      if (value !== undefined) yield [entry.key, value];
    }
  }
  override *keys(): MapIterator<string> { for (const [key] of this.entries()) yield key; }
  override *values(): MapIterator<FileReadState> { for (const [, value] of this.entries()) yield value; }
  override [Symbol.iterator](): MapIterator<[string, FileReadState]> { return this.entries(); }
  override forEach(callback: (value: FileReadState, key: string, map: Map<string, FileReadState>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
}

export class ToolContextCache {
  private readonly costs = new Map<string, WeakRef<CostTracker>>();
  private readonly reads = new Map<string, WeakRef<NativeReadState>>();
  private readonly catalogs = new Map<string, Map<string, SkillCatalog>>();
  private catalogsClosed = false;
  private onUsage?: Parameters<typeof wrapCostTracker>[1];
  setUsageObserver(observer: Parameters<typeof wrapCostTracker>[1]): void { this.onUsage = observer; }
  releaseCallback(): NativeCollaborationCallback {
    const catalogs = this.catalogs;
    return (error, name, input) => {
      if (error) throw error;
      if (name !== 'context.releaseOwner') throw new Error(`Unknown native context notification: ${name}`);
      catalogs.delete(JSON.parse(input).owner);
      return '{"ok":true,"value":null}';
    };
  }
  closeCatalogs(): void { this.catalogsClosed = true; this.catalogs.clear(); }
  private catalog(shared: NativeSharedToolState): SkillCatalog {
    if (this.catalogsClosed) throw new Error('Tool context is no longer available');
    let scopes = this.catalogs.get(shared.catalogOwner);
    const retained = scopes?.get(shared.catalogScope);
    if (retained) return retained;
    const catalog = parseNativeValue(shared.skills.snapshot()) as SkillCatalog;
    for (const entry of catalog) { Object.freeze(entry.source); Object.freeze(entry); }
    Object.freeze(catalog);
    if (!scopes) { scopes = new Map(); this.catalogs.set(shared.catalogOwner, scopes); }
    scopes.set(shared.catalogScope, catalog);
    return catalog;
  }
  resolve(shared: NativeSharedToolState): { costTracker: CostTracker; readFileState: NativeReadState; skillCatalog: SkillCatalog } {
    const skillCatalog = this.catalog(shared);
    let costTracker = this.costs.get(shared.runId)?.deref();
    if (!costTracker) { costTracker = wrapCostTracker(shared.cost, this.onUsage); this.costs.set(shared.runId, new WeakRef(costTracker)); }
    let readFileState = this.reads.get(shared.readIdentity)?.deref();
    if (!readFileState) {
      const reads = shared.reads;
      readFileState = new NativeReadState({ call: (method, args = []) => {
        try { return parseNativeValue(reads.call(method, stringifyNativeValue(args))); }
        catch (error) { throw nativeError(error); }
      } });
      this.reads.set(shared.readIdentity, new WeakRef(readFileState));
    }
    return { costTracker, readFileState, skillCatalog };
  }
  clear(): void { this.costs.clear(); this.reads.clear(); this.closeCatalogs(); this.onUsage = undefined; }
}

interface FileReadCapture {
  capture(operationId: string, path: string): void;
  release(operationId: string): void;
}

export function createToolContext(handle: Pick<NativeHandle, 'contextCall' | 'contextAsync' | 'contextEmit' | 'sharedContext'>, value: Record<string, unknown>, signal: AbortSignal, cache = new ToolContextCache(), fileReads?: FileReadCapture): ToolContext {
  const { nativeContextId, nativeCatalogOwner, recordFileChange: _recordFileChange, ...publicValue } = value;
  const id = typeof nativeContextId === 'string' ? nativeContextId : String(value.toolUseId);
  let shared: ReturnType<ToolContextCache['resolve']>;
  let text: NativeSharedToolState['text'];
  try { const state = handle.sharedContext(id, typeof nativeCatalogOwner === 'string' ? nativeCatalogOwner : undefined); shared = cache.resolve(state); text = state.text; } catch (error) { throw nativeError(error); }
  const transport: ToolContextTransport = {
    call(method, args = []) {
      try { return parseNativeValue(handle.contextCall(id, method, stringifyNativeValue(args))); }
      catch (error) { throw nativeError(error); }
    },
    async asyncCall(method, args = [], signal, advisoryCancellation = false) {
      if (!advisoryCancellation) signal?.throwIfAborted();
      const operationId = randomUUID();
      handle.contextCall(id, 'context.begin', JSON.stringify([operationId, method]));
      const cancel = () => handle.contextCall(id, 'context.cancel', JSON.stringify([operationId]));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      try { return parseNativeValue(await handle.contextAsync(id, method, stringifyNativeValue({ operationId, args }),
        fileReads ? path => fileReads.capture(operationId, path) : undefined)); }
      catch (error) { throw nativeError(error); }
      finally {
        signal?.removeEventListener('abort', cancel);
        fileReads?.release(operationId);
        handle.contextCall(id, 'context.end', JSON.stringify([operationId]));
      }
    },
    async emit(event) {
      try { await handle.contextEmit(id, JSON.stringify(event)); }
      catch (error) { throw nativeError(error); }
    },
  };
  const context = { ...publicValue, sessionId: String(value.sessionId), cwd: String(value.cwd),
    currentTurn: Number(value.currentTurn), env: value.env as ToolContext['env'],
    abortSignal: signal, ...shared,
    services: { backgroundTasks: backgroundTasks(transport) }, onToolMessage: event => transport.emit(event),
  } as ToolContext;
  registerToolFormatter(context, (method, value) => {
    try { return parseNativeValue(text.call(method, stringifyNativeValue([value]))); }
    catch (error) { throw nativeError(error); }
  });
  registerToolAuthority(context, (name, input) => transport.asyncCall('builtin.execute', [name, input, {
    sessionId: context.sessionId, cwd: context.cwd, env: context.env, currentTurn: context.currentTurn, toolUseId: context.toolUseId,
  }], context.abortSignal, true));
  return context;
}
