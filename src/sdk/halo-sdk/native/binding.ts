import { isMainThread, workerData } from 'node:worker_threads';
import { getLogger } from '../utils/logger.js';
import { ProviderError, ModelFallbackError, CompactError, AbortError, ResumeHistoryError } from '../utils/errors.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { McpToolIdentityError } from './mcp-errors.js';
import { decodeWire } from './wire.js';

export interface NativeHandle {
  eventConsumed(id?: string, error?: string): void;
  startStream(): void;
  send(input: string, inputId: string, live: boolean): boolean;
  hasPendingInput(): boolean;
  withdrawUnreadInput(): string;
  interrupt(): void;
  abortCleanup(): void;
  close(): void;
  waitClosed(): Promise<void>;
  ownedProcessCount(): number;
  reapOwnedProcesses(): Promise<void>;
  flush(): Promise<void>;
  next(): Promise<string | null>;
  command(name: string, payload: string): Promise<string>;
  contextCall(toolUseId: string, method: string, payload: string): string;
  contextEmit(toolUseId: string, event: string): Promise<void>;
  contextAsync(toolUseId: string, method: string, payload: string, readState?: (path: string) => void): Promise<string>;
  sharedContext(identity: string, expectedOwner?: string): NativeSharedToolState;
  getGoal(): string;
  setGoal(goal: string): string;
  callbackResponse(id: string, result: string, error?: string): void;
}

export interface RuntimeInfo {
  implementation: 'rust';
  abiVersion: number;
  version: string;
  targetArch: string;
  targetOs: string;
  buildId: string;
}

export interface NativeHistoryHandle { cancel(): void; result(): Promise<string> }

export interface NativeProviderRequestHandle {
  next(): Promise<string | null>;
  close(): void;
  waitClosed(): Promise<void>;
  callbackResponse(id: string, result: string, error?: string): void;
}
export interface NativeProviderTransportHandle {}
export interface NativeOperationHandle extends NativeProviderRequestHandle { interrupt(): void }
export interface NativeToolDiscoveryHandle extends NativeValueHandle { readonly identity: string }
export interface NativeLoopHandle extends NativeProviderRequestHandle, Pick<NativeHandle, 'contextCall' | 'contextAsync' | 'contextEmit' | 'sharedContext'> {
  interrupt(): void;
  tokenBudget(): NativeValueHandle;
  toolDiscoveryState(): NativeToolDiscoveryHandle | null;
  contextReceipt(): string;
  eventConsumed(id: string, error?: string): void;
}
export interface NativeCodeSearchHandle {
  search(request: string, id: string, aborted: boolean): Promise<string>;
  cancel(id: string): void;
  dispose(): Promise<void>;
}
export interface NativeToolOwnerHandle {
  execute(implementation: string, input: string, context: string, readState?: (path: string) => void): NativeOperationHandle;
  close(): Promise<void>;
}
export interface NativeMcpClientHandle {
  value(method: string): string;
  close(): void;
  cancel(id: string): void;
  start(method: string, payload: string, id: string, aborted: boolean, callback: NativeCollaborationCallback): Promise<string>;
}
export interface NativeMcpTransportHandle {
  connected(): boolean;
  setRequestHandler(method: string, callbackId: string): void;
  start(method: string, payload: string, id: string, aborted: boolean, callback: NativeCollaborationCallback): Promise<string>;
  cancel(id: string): void;
  close(): Promise<void>;
}

export type NativeCollaborationCallback = (error: Error | null, name: string, input: string, asynchronous: boolean, complete?: (result: string) => void) => string | Promise<string>;
export interface NativeTurnGateHandle { call(name: string, payload: string, callback: NativeCollaborationCallback): string; start(name: string, payload: string, callback: NativeCollaborationCallback): Promise<string> }

export interface NativeCollaborationStoreHandle { call(name: string, payload: string): string; flush(callback: NativeCollaborationCallback): Promise<string> }

export interface NativeSdkCollaborationHandle extends Pick<NativeHandle, 'contextCall' | 'contextAsync' | 'contextEmit' | 'command' | 'sharedContext'> { call(name: string, payload: string, callback: NativeCollaborationCallback): string; start(name: string, payload: string, operationId: string, callback: NativeCollaborationCallback): Promise<string>; cancel(operationId: string): void }

export interface NativeCollaborationRuntimeHandle { call(name: string, payload: string, callback: NativeCollaborationCallback): string; start(name: string, payload: string, operationId: string, callback: NativeCollaborationCallback): Promise<string>; cancel(operationId: string): void; bus(): NativeTurnGateHandle }

export interface NativeCollaborationValueHandle { call(name: string, payload: string): string }

export interface NativeValueHandle { call(name: string, payload: string): string }
export interface NativeSharedToolState { runId: string; readIdentity: string; cost: NativeValueHandle; reads: NativeValueHandle; text: NativeValueHandle;
  catalogOwner: string; catalogScope: string; skills: { snapshot(): string } }

interface NativeBinding {
  configureHttpTrust(certificates: string): bigint;
  redactionValue(method: string, payload: string): string;
  mcpBridgeValue(method: string, payload: string): string;
  mcpBridgeInvoke(descriptor: string, input: string, callback: NativeCollaborationCallback): Promise<string>;
  mcpBridgeFormat(descriptor: string, result: unknown): unknown;
  nativeValue(name: string, payload: string): string;
  estimateTokensText(text: string): number;
  truncateToolResultText(text: string, maximum: number): string;
  splitAtBoundaryRanges(text: string): [number, number];
  parseXmlText(text: unknown, knownNames: string[]): { unchanged: boolean; value?: string };
  NativeCostTracker: new(model: string, contextWindow: number, pricing: string) => NativeValueHandle;
  NativeTokenBudget: new(contextWindow: number, maxOutputTokens: number) => NativeValueHandle;
  NativeSseParser: new() => { feed(text: string): string };
  NativeLoop: new(config: string, tools: string, initial: string, options: string, budget?: NativeValueHandle, discovery?: NativeToolDiscoveryHandle) => NativeLoopHandle;
  NativeToolDiscoveryState: new(payload: string) => NativeToolDiscoveryHandle;
  NativeToolOwner: new(sessionId: string) => NativeToolOwnerHandle;
  NativeCodeSearchService: new(options: string, callback: NativeCollaborationCallback) => NativeCodeSearchHandle;
  codeSearchDiagnostics(): string;
  codeSearchValue(method: string, payload: string): string;
  NativeMcpClient: new(serverNameWire: string, elicitation: boolean) => NativeMcpClientHandle;
  NativeMcpTransport: new(config: string, options: string, callback: NativeCollaborationCallback) => NativeMcpTransportHandle;
  runtimeInfo(): string;
  runtimeDiagnostics(): string;
  readSessionToolContextMode(sessionId: string, options: string): Promise<string>;
  NativeSession: new(options: string, release?: NativeCollaborationCallback) => NativeHandle;
  NativeHistoryRead: new(sessionId: string, options: string) => NativeHistoryHandle;
  NativeProviderTransport: new() => NativeProviderTransportHandle;
  NativeCollaborationValue: new(options: string) => NativeCollaborationValueHandle;
  NativeTurnGate: new(options: string, callback: NativeCollaborationCallback) => NativeTurnGateHandle;
  NativeCollaborationStore: new(options: string, callback: NativeCollaborationCallback) => NativeCollaborationStoreHandle;
  NativeCollaborationWorkspace: new(operation: string, payload: string) => NativeHistoryHandle;
  NativeBlackboardWriter: new(options: string, callback: NativeCollaborationCallback) => Pick<NativeTurnGateHandle, 'call'>;
  NativeSdkCollaboration: new(options: string, callback: NativeCollaborationCallback) => NativeSdkCollaborationHandle;
  NativeMessageBus: new(options: string, callback: NativeCollaborationCallback) => NativeTurnGateHandle;
  NativeCollaborationRuntime: new(options: string, callback: NativeCollaborationCallback) => NativeCollaborationRuntimeHandle;
  NativeProviderRequest: new(options: string, request: string, mode: string, transport: NativeProviderTransportHandle) => NativeProviderRequestHandle;
  NativeOperation: new(operation: string, options: string, payload: string) => NativeOperationHandle;
}

let binding: NativeBinding | undefined;
let sourceLibraryPath: string | undefined;

export function nativeBinaryPath(): string {
  if (!isMainThread && typeof workerData?.haloSdkNativeLibraryPath === 'string') return workerData.haloSdkNativeLibraryPath.replace(/\.asar([/\\])/, '.asar.unpacked$1');
  const modulePath = fileURLToPath(import.meta.url);
  const directory = dirname(modulePath);
  const filename = `halo-sdk.${process.platform}-${process.arch}.node`;
  if (modulePath.endsWith('.ts')) {
    if (sourceLibraryPath) return sourceLibraryPath;
    const path = join(directory, '..', 'dist', 'native', filename);
    const manifest = JSON.parse(readFileSync(join(dirname(path), 'build-info.json'), 'utf8')) as { buildId?: string };
    const { sourceIdentity } = createRequire(import.meta.url)(join(directory, 'source-identity.cjs')) as { sourceIdentity(path: string): string };
    if (manifest.buildId !== sourceIdentity(directory)) throw new Error('Native SDK sources differ from the compiled library; run the SDK build before loading source modules');
    sourceLibraryPath = path;
    return path;
  }
  const path = join(directory, filename);
  return path.replace(/\.asar([/\\])/, '.asar.unpacked$1');
}

export function loadBinding(): NativeBinding {
  if (binding) return binding;
  const path = nativeBinaryPath();
  const loaded = createRequire(import.meta.url)(path) as NativeBinding;
  const info = JSON.parse(loaded.runtimeInfo()) as RuntimeInfo;
  if (info.implementation !== 'rust' || info.abiVersion !== 1) {
    throw new Error(`Incompatible Halo SDK native library at ${path}`);
  }
  const manifest = JSON.parse(readFileSync(join(dirname(path), 'build-info.json'), 'utf8')) as {
    implementation?: string; abiVersion?: number; buildId?: string; artifacts?: { platform?: string; filename?: string }[];
  };
  if (manifest.implementation !== 'rust' || manifest.abiVersion !== info.abiVersion || manifest.buildId !== info.buildId ||
    !manifest.artifacts?.some(artifact => artifact.platform === `${process.platform}-${process.arch}` && artifact.filename === basename(path))) {
    throw new Error(`Halo SDK native library does not match its build manifest at ${path}`);
  }
  binding = loaded;
  return loaded;
}

export function runtimeInfo(): RuntimeInfo { return JSON.parse(loadBinding().runtimeInfo()) as RuntimeInfo; }

interface NativeErrorEnvelope { message?: string; code?: string; details?: Record<string, unknown>; harness?: unknown; host_data?: unknown }

export function nativeErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof Error)) return undefined;
  try {
    const detail = JSON.parse(error.message) as NativeErrorEnvelope;
    if (detail.host_data !== undefined) {
      const data = decodeWire(detail.host_data);
      if (data !== null && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
    }
    return detail.details;
  } catch { return undefined; }
}

export function nativeError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  try {
    const detail = JSON.parse(error.message) as NativeErrorEnvelope;
    if (typeof detail.message === 'string') {
      const metadata = nativeErrorDetails(error) ?? detail.details;
      const message = typeof metadata?.message === 'string' ? metadata.message : detail.message;
      const name = metadata?.name;
      const Constructor = name === 'TypeError' ? TypeError : name === 'RangeError' ? RangeError : Error;
      const failure = name === 'ProviderError' ? new ProviderError(message, metadata)
        : name === 'ModelFallbackError' ? new ModelFallbackError(message, metadata)
        : name === 'McpToolIdentityError' ? new McpToolIdentityError(message)
        : detail.code === 'COMPACT_ERROR' ? new CompactError(message)
        : detail.code === 'ABORTED' || detail.code === 'ABORT_ERR' ? new AbortError(message)
        : detail.code === 'RESUME_HISTORY_UNAVAILABLE' && ['missing', 'unreadable', 'incomplete'].includes(String(metadata?.reason)) ? new ResumeHistoryError(metadata!.reason as 'missing' | 'unreadable' | 'incomplete')
        : new Constructor(message);
      const fields = { ...metadata };
      if (name === 'McpToolIdentityError') delete fields.name;
      for (const [key, value] of Object.entries(fields)) Object.defineProperty(failure, key, {
        value, writable: true, configurable: true, enumerable: Object.hasOwn(failure, key) ? Object.prototype.propertyIsEnumerable.call(failure, key) : true,
      });
      return Object.assign(failure, { code: metadata && Object.hasOwn(metadata, 'code') ? metadata.code : detail.code,
        details: metadata, ...(detail.harness === undefined ? {} : { harness: detail.harness }) });
    }
  } catch { /* Native loader and JavaScript errors already carry their original message. */ }
  return error;
}

export function callbackError(error: unknown): string {
  const encode = (error: unknown): string => {
    const failure = error as Error & { code?: string; reason?: string; statusCode?: number; status?: number;
      retryable?: boolean; retriesExhausted?: boolean; requestRejected?: boolean; provider?: string; harness?: unknown };
    return JSON.stringify({ name: failure?.name ?? 'Error', code: failure?.code,
      message: failure?.message ?? String(error), reason: failure?.reason, statusCode: failure?.statusCode,
      status: failure?.status, retryable: failure?.retryable, retriesExhausted: failure?.retriesExhausted,
      requestRejected: failure?.requestRejected, provider: failure?.provider, harness: failure?.harness, stringValue: String(error) });
  };
  try { return encode(error); }
  catch (failure) {
    // Error metadata is host code too; its failure must still settle the native callback.
    try { return encode(failure); }
    catch { return '{"code":"HOST_CALLBACK_ERROR_ENCODING"}'; }
  }
}

export function parseNativeValue(raw: string): any {
  const restore = (value: any): any => {
    if (Array.isArray(value)) return value.map(restore);
    if (!value || typeof value !== 'object') return value;
    if (value.__haloSdkNativeUndefined === true && Object.keys(value).length === 1) return undefined;
    if (typeof value.__haloSdkNativeNumber === 'string' && Object.keys(value).length === 1) {
      if (value.__haloSdkNativeNumber === '-0') return -0;
      if (value.__haloSdkNativeNumber === 'NaN') return NaN;
      if (value.__haloSdkNativeNumber === 'Infinity') return Infinity;
      if (value.__haloSdkNativeNumber === '-Infinity') return -Infinity;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, restore(child)]));
  };
  return restore(JSON.parse(raw));
}

export function stringifyNativeValue(value: unknown): string {
  return JSON.stringify(value, (_key, child) => {
    if (child === undefined) return { __haloSdkNativeUndefined: true };
    if (typeof child === 'number' && (!Number.isFinite(child) || Object.is(child, -0))) return { __haloSdkNativeNumber: Object.is(child, -0) ? '-0' : String(child) };
    return child;
  });
}

export function routeNativeLog(record: { component: string; level: string; message: string; fields?: Record<string, unknown> }): void {
  const logger = getLogger(record.component);
  const level = record.level;
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
    if (logger.isLevelEnabled(level)) logger[level](record.message, record.fields);
  }
}
