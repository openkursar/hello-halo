import { parentPort, threadId, workerData } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setLogger, type Logger, type LogFields, type LogLevel } from '../utils/logger.js';
import { setChildProcessObserver, getProcessTreeContext, killProcessTree as killTree } from '../utils/processes.js';
import { setSessionOwnershipCoordinator } from '../utils/session-ownership.js';
import type { SDKSession, SessionCloseOptions, SessionRuntimeStats } from '../core/session.js';
import type { Options } from '../types/config.js';
import type { SDKMessage } from '../core/query-types.js';
import { RpcPeer, aborted, serializeError } from './rpc.js';
import { decodeOptions, type EncodedOptions, type WorkerSetup } from './options.js';
import { StreamWriter } from './stream.js';
import { WORKER_PROTOCOL_VERSION } from './protocol.js';
import { bindCodeSearchBridge, codeSearchBridge, includesCodeSearch } from '../core/code-search.js';
import { bindReadDenyFloor, readDenyFloor } from '../core/read-policy.js';

if (!parentPort) throw new Error('SDK worker entry requires a parent port');
if (workerData.protocolVersion !== WORKER_PROTOCOL_VERSION) throw new Error('SDK worker protocol version mismatch');
const port = parentPort;
const peer = new RpcPeer(frame => port.postMessage(frame));
const execution = new AsyncLocalStorage<string>();
const children = new Map<string, { scope: string; child: ChildProcess; exited: Promise<void> }>();
let level: LogLevel = workerData.logLevel;
const priorities = ['debug', 'info', 'warn', 'error', 'silent'];

function logger(component: string): Logger {
  const enabled = (candidate: LogLevel) => level !== 'silent' && priorities.indexOf(candidate) >= priorities.indexOf(level);
  const write = (candidate: LogLevel, message: string, fields?: LogFields | Error) => {
    if (enabled(candidate)) peer.notify('log', { level: candidate, component, message, fields });
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: name => logger(component ? `${component}:${name}` : name), isLevelEnabled: enabled,
  };
}
setLogger(logger(''));
const { setFileLockCoordinator } = await import('../tools/file-access.js');

setChildProcessObserver(child => {
  const id = randomUUID();
  const scope = execution.getStore() ?? '';
  let finish!: () => void;
  const exited = new Promise<void>(resolve => { finish = resolve; });
  children.set(id, { scope, child, exited });
  const announce = () => { if (child.pid) peer.notify('child', { id, scope, pid: child.pid, context: getProcessTreeContext(child) }); };
  if (child.pid) announce(); else child.once('spawn', announce);
  const end = () => { children.delete(id); peer.notify('childExit', { id }); finish(); };
  child.once('close', end);
  child.once('error', () => { if (!child.pid) end(); });
  const owner = sessions.get(scope);
  if (scope && (!owner || owner.cleanup.signal.aborted)) {
    logger('Worker').warn('Child process stopped after session retirement', { scope, pid: child.pid });
    const stop = () => { if (child.pid) killTree(child.pid, 'SIGKILL'); };
    if (child.pid) stop(); else child.once('spawn', stop);
  }
});

setFileLockCoordinator(async key => {
  const scope = execution.getStore();
  const record = scope ? sessions.get(scope) : undefined;
  if (!scope || !record) throw new Error('File operation has no worker session owner');
  const lockId = randomUUID();
  try { await peer.request(scope, 'lock', { key, lockId }, { signal: record.session?.abortController?.signal ?? record.abort.signal }); }
  catch (error) { peer.notify('unlock', { lockId }); throw error; }
  return () => peer.notify('unlock', { lockId });
});

setSessionOwnershipCoordinator(async ({ path: key, sessionId }, signal) => {
  const scope = execution.getStore();
  if (!scope) throw new Error('Transcript has no worker session owner');
  const lockId = randomUUID();
  try { await peer.request(scope, 'lease', { key, sessionId, lockId }, { signal }); }
  catch (error) { peer.notify('unlock', { lockId }); throw error; }
  return () => peer.notify('unlock', { lockId });
});

interface Execution {
  sessionId: string;
  stream(): AsyncGenerator<SDKMessage, void, undefined>;
  close(options?: SessionCloseOptions): void;
  flush(): Promise<void>;
  interrupt(): Promise<void>;
  getRuntimeStats(): Promise<SessionRuntimeStats>;
  [key: string]: any;
}
interface RecordState {
  abort: AbortController;
  lifetime: AbortController;
  cleanup: AbortController;
  created: Promise<Execution>;
  session?: Execution;
  closing?: Promise<void>;
  stream?: { id: string; writer: StreamWriter; iterator: AsyncGenerator<SDKMessage, void, undefined>; task: Promise<void>; returning: boolean; terminal: boolean };
  active: boolean;
}
const sessions = new Map<string, RecordState>();
const inspections = new Map<string, { abort: AbortController; task: Promise<unknown> }>();
const sdk = await import('../index.js');

async function prepareWithSignal<T>(prepare: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(aborted());
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return prepare(); }), cancelled]);
  } finally { signal.removeEventListener('abort', cancel); }
}

function searchConfiguration(config: Options['codeSearch']): string {
  return JSON.stringify(config && Object.fromEntries(Object.entries(config)
    .filter(entry => entry[1] !== undefined).sort(([a], [b]) => a.localeCompare(b)))) ?? '';
}

async function create(scope: string, value: { encoded: EncodedOptions; setup?: WorkerSetup; prompt?: string }, signal: AbortSignal): Promise<{ sessionId: string }> {
  if (sessions.has(scope)) throw new Error('Duplicate worker session');
  const record: RecordState = {
    abort: new AbortController(), lifetime: new AbortController(), cleanup: new AbortController(), created: null!, active: false,
  };
  sessions.set(scope, record);
  const cancel = () => record.abort.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  record.created = execution.run(scope, async () => {
    let options: Options = decodeOptions(value.encoded, peer, scope, record.lifetime.signal);
    const searchBridge = codeSearchBridge(options);
    const hostReadDenyRoots = readDenyFloor(options);
    const configuredSearch = searchConfiguration(options.codeSearch);
    const { providerConfig, ...sessionOptions } = options as Options & { providerConfig?: import('../llm/provider.js').ProviderConfig };
    options = providerConfig ? { ...sessionOptions, provider: sdk.createProvider(providerConfig) } : sessionOptions;
    options.abortController = record.abort;
    if (value.setup) {
      if (new URL(value.setup.module).protocol !== 'file:') throw new TypeError('Worker setup must be a local file URL');
      const module = await prepareWithSignal(() => import(value.setup!.module), record.abort.signal);
      const setup = module[value.setup.exportName ?? 'setup'];
      if (typeof setup !== 'function') throw new TypeError('Worker setup export is not a function');
      options = await prepareWithSignal(() => setup(options, value.setup!.data), record.abort.signal);
    }
    if (includesCodeSearch(options)) {
      if (!searchBridge || searchConfiguration(options.codeSearch) !== configuredSearch) {
        throw new TypeError('CodeSearch must be configured by the worker host; setup cannot enable or replace its backend');
      }
      bindCodeSearchBridge(options, searchBridge);
    }
    bindReadDenyFloor(options, hostReadDenyRoots);
    options.abortController = record.abort;
    if (record.abort.signal.aborted) throw aborted();
    let session: Execution;
    if (value.prompt !== undefined) {
      const query = sdk.query({ options, prompt: value.prompt });
      session = {
        sessionId: options.sessionId ?? scope,
        stream: () => query,
        close: () => query.close(), interrupt: () => query.interrupt(),
        getRuntimeStats: () => query.getRuntimeStats(),
        flush: async () => { await query.return(undefined); }, query,
      };
    } else session = await sdk.createSession(options) as SDKSession as unknown as Execution;
    record.session = session;
    if (record.abort.signal.aborted) { session.close({ signal: record.cleanup.signal }); await session.flush(); throw aborted(); }
    return session;
  });
  try { return { sessionId: (await record.created).sessionId }; }
  catch (error) {
    await close(scope);
    throw error;
  }
  finally { signal.removeEventListener('abort', cancel); }
}

async function close(scope: string): Promise<void> {
  const inspection = inspections.get(scope);
  if (inspection) {
    inspection.abort.abort();
    await inspection.task.catch(() => {});
    return;
  }
  const record = sessions.get(scope);
  if (!record) return;
  if (record.closing) return record.closing;
  record.closing = (async () => {
    let stage = 'preparation';
    const cleanupDeadline = setTimeout(() => {
      if (!record.cleanup.signal.aborted) {
        logger('Worker').warn('Session cleanup grace expired; cancelling advisory work', { scope, stage, timeoutMs: workerData.cleanupHookTimeoutMs });
        record.cleanup.abort();
      }
    }, workerData.cleanupHookTimeoutMs);
    try {
      record.abort.abort();
      peer.cancelScope(scope, undefined, false);
      record.stream?.writer.stop();
      const session = await record.created.catch(() => undefined);
      if (session) {
        session.close({ signal: record.cleanup.signal });
        stage = 'stream';
        await record.stream?.task;
        stage = 'session-resources';
        await session.flush();
      }
      record.lifetime.abort();
      peer.cancelScope(scope, undefined, false);
      stage = 'child-processes';
      const owned = [...children.values()].filter(child => child.scope === scope);
      for (const { child } of owned) if (child.pid) killTree(child.pid, 'SIGKILL');
      await Promise.all(owned.map(child => child.exited));
      sessions.delete(scope);
    } finally { clearTimeout(cleanupDeadline); }
  })();
  return record.closing;
}

function startStream(scope: string, streamId: string): void {
  const record = sessions.get(scope);
  if (!record?.session || record.closing) throw new Error('Worker session is unavailable');
  if (record.stream) throw new Error('A stream is already being consumed');
  const writer = new StreamWriter(scope, streamId, batch => peer.notify('stream', batch));
  const iterator = record.session.stream();
  const task = execution.run(scope, async () => {
    try {
      for await (const message of iterator) {
        if (message.type === 'system' && message.subtype === 'init') record.active = true;
        if (message.type === 'result') { record.active = false; if (record.stream) record.stream.terminal = true; }
        await writer.push(message);
      }
      await writer.finish();
    } catch (error) {
      if (!record.closing && !record.stream?.returning) {
        logger('Worker').warn('Session stream failed', { scope, error: serializeError(error) });
        await writer.finish(serializeError(error)).catch(() => {});
      }
    } finally {
      writer.stop();
      record.stream = undefined;
      record.active = false;
    }
  });
  record.stream = { id: streamId, iterator, writer, task, returning: false, terminal: false };
}

const sessionMethods = new Set(['interrupt', 'flush', 'setModel', 'setMaxThinkingTokens', 'setPermissionMode', 'getGoal', 'setGoal', 'getRuntimeStats']);
const queryMethods = new Set(['supportedCommands', 'supportedModels', 'mcpServerStatus', 'reconnectMcpServer', 'toggleMcpServer', 'setMcpServers', 'stopTask', 'initializationResult', 'accountInfo']);
peer.onRequest = (method, value, scope, signal) => execution.run(scope, async () => {
  if (method === 'readSessionToolContextMode') {
    if (sessions.has(scope) || inspections.has(scope)) throw new Error('Duplicate worker inspection');
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const task = sdk.readSessionToolContextMode(value.sessionId, value.options, { signal: abort.signal });
    inspections.set(scope, { abort, task });
    try { return await task; }
    finally { signal.removeEventListener('abort', cancel); inspections.delete(scope); }
  }
  if (method === 'create') return create(scope, value, signal);
  if (method === 'close') return execution.run(value.scope, () => close(value.scope));
  if (method === 'shutdown') {
    await Promise.all([...sessions.keys(), ...inspections.keys()].map(id => execution.run(id, () => close(id))));
    return;
  }
  const record = sessions.get(scope);
  if (!record?.session || record.closing) throw new Error('Worker session is unavailable');
  const session = record.session;
  if (method === 'stream') return startStream(scope, value.streamId);
  if (method === 'returnStream') {
    const stream = record.stream;
    if (!stream || stream.id !== value.streamId) return;
    stream.returning = true;
    stream.writer.stop();
    if (!stream.terminal) await session.interrupt();
    await stream.iterator.return(undefined);
    await stream.task;
    return;
  }
  if (method === 'send') {
    const onConsumed = () => peer.notify('consumed', { scope, id: value.id });
    if (value.live) {
      if (!session.sendIntoLiveTurn(value.message, { onConsumed, onWithdrawn: () => peer.notify('withdrawn', { scope, id: value.id }) })) {
        throw new Error('Worker session refused live input');
      }
    } else await session.send(value.message, { onConsumed });
    return;
  }
  if (method === 'withdraw') return session.withdrawUnreadInput();
  if (method === 'call') {
    const target = value.query ? session.query : session;
    if (!(value.query ? queryMethods : sessionMethods).has(value.method) || typeof target?.[value.method] !== 'function') {
      throw new Error('Unsupported worker session method');
    }
    return target[value.method](...value.args);
  }
  throw new Error('Unknown worker operation');
});
peer.onEvent = (event, value) => {
  if (event === 'ack') sessions.get(value.scope)?.stream?.writer.ack(value.sequence);
  if (event === 'abortCleanup') sessions.get(value.scope)?.cleanup.abort();
  if (event === 'logLevel') level = value;
};
port.on('message', frame => {
  try { peer.receive(frame); }
  catch (error) { logger('Worker').error('Worker protocol failed', { error: serializeError(error) }); process.exit(1); }
});
process.on('unhandledRejection', error => {
  logger('Worker').error('Unhandled worker rejection', { error: serializeError(error) });
  process.exit(1);
});
const heartbeat = setInterval(() => {
  void Promise.all([...sessions.values()].map(record => record.session?.getRuntimeStats())).then(stats => peer.notify('heartbeat', {
    active: [...sessions.values()].filter(record => record.active).length,
    collaborators: stats.reduce((count, state) => count + (state?.activeCollaborators ?? 0), 0),
    sessions: sessions.size, pending: peer.pendingCount, children: children.size,
  })).catch(error => logger('Worker').warn('Worker state sampling failed', { error: serializeError(error) }));
}, workerData.heartbeatIntervalMs);
heartbeat.unref();
peer.notify('ready', { threadId, protocolVersion: WORKER_PROTOCOL_VERSION });
