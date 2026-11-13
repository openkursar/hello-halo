import { getSessionOwnershipCoordinator } from '../utils/session-ownership.js';
import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import type { Options, QueryConfig } from '../types/config.js';
import type { QueryLoopOptions } from '../core/query-types.js';
import type { LlmProvider, ProviderRequest, StreamEvent } from '../types/provider.js';
import type { Tool, ToolContext } from '../types/tool.js';
import type { BackgroundTask } from '../tools/bash/background.js';
import type { SdkMcpServerInstance } from '../tools/mcp/sdk-server.js';
import { zodToJsonSchema } from '../tools/mcp/zod-to-json-schema.js';
import { getLogger } from '../utils/logger.js';
import { isAbortError } from '../utils/errors.js';
import { callbackError, nativeError, type NativeHandle, type NativeLoopHandle } from './binding.js';
import { createToolContext, ToolContextCache } from './tool-context.js';
import { nativeToolImplementation, nativeToolDefinition } from './tool-identities.js';
import { codeSearchBridge, includesCodeSearch } from '../core/code-search.js';
import { readDenyFloor } from '../core/read-policy.js';
import type { CodeSearchService } from '../search/types.js';
import { wrapToolDiscoveryState } from './tool-discovery.js';
import { nativeProviderDescriptor, type NativeProviderDescriptor } from './provider-identities.js';
import { mcpToolRegistration, type McpToolRegistration } from './mcp-tool-identities.js';
import { prepareHttpAttempt } from './http-trust.js';
import { decodeWire } from './wire.js';

const CALLBACK = '__haloSdkNativeCallback';
const SIGNAL = '__haloSdkNativeSignal';
const UNDEFINED = '__haloSdkNativeUndefined';
type Callback = (...args: any[]) => unknown;
const asyncLoopCallbacks = new Set(['onContextMessage', 'onAssistantBlock', 'onAssistantMessage', 'onToolResultMessage', 'onCompact', 'getPendingUserMessage']);
const voidLoopCallbacks = new Set(['onUsage', 'onHistoryCompacted', 'onToolContextChange']);
interface HookChain {
  input: Record<string, any>;
  originalToolInput: unknown;
  lastNative: Record<string, unknown>;
  references: Map<string, object>;
  identities: WeakMap<object, string>;
  nextReference: number;
}

type Server = SdkMcpServerInstance & { _registeredTools?: Record<string, any> };

export class NativeCallbacks {
  private readonly context = new AsyncResource('AgentSdkNativeSession');
  private readonly callbacks = new Map<string, Callback>();
  private readonly active = new Map<string, AbortController>();
  private readonly streams = new Map<string, { iterator: AsyncGenerator<StreamEvent, void, undefined>; controller: AbortController }>();
  private readonly tools = new Map<string, Tool>();
  private readonly servers = new Map<string, Server>();
  private readonly registeredTools = new Map<string, Map<string, any>>();
  private readonly mcpRegistrations = new Map<string, WeakRef<McpToolRegistration>>();
  private readonly mcpRegistrationIds = new WeakMap<McpToolRegistration, string>();
  private readonly mcpFinalizer = new FinalizationRegistry<string>(id => this.mcpRegistrations.delete(id));
  private provider?: LlmProvider;
  private codeSearch?: CodeSearchService;
  private handle?: Pick<NativeHandle, 'contextCall' | 'contextAsync' | 'contextEmit' | 'sharedContext'> & Partial<Pick<NativeHandle, 'command'> & Pick<NativeLoopHandle, 'toolDiscoveryState'>>;
  private readonly toolContextCache = new ToolContextCache();
  catalogReleaseCallback(): ReturnType<ToolContextCache['releaseCallback']> { return this.toolContextCache.releaseCallback(); }
  closeCatalogViews(): void { this.toolContextCache.closeCatalogs(); }
  private loop?: { config: QueryConfig; options: QueryLoopOptions };
  private directContext?: ToolContext;
  private directReadState?: { path: string; value: unknown };
  private readonly contextReadStates = new Map<string, { path: string; value: unknown }>();
  private readonly backgroundEntries = new Map<string, BackgroundTask>();
  private readonly backgroundEntryIds = new WeakMap<BackgroundTask, string>();
  bindDirectContext(context: ToolContext): void { this.directContext = context; }
  captureDirectReadState(path: string): void {
    this.directReadState = { path, value: this.directContext?.readFileState?.get(path) };
  }
  bindLoop(config: QueryConfig, options: QueryLoopOptions): void {
    this.loop = { config, options };
    this.toolContextCache.setUsageObserver(options.onUsage);
  }

  attach(handle: Pick<NativeHandle, 'contextCall' | 'contextAsync' | 'contextEmit' | 'sharedContext'> & Partial<Pick<NativeHandle, 'command'> & Pick<NativeLoopHandle, 'toolDiscoveryState'>>): void { this.handle = handle; }
  private nextId = 0;
  registerCallback(callback: Callback): string { const id = String(++this.nextId); this.callbacks.set(id, callback); return id; }
  private ownership?: NonNullable<ReturnType<typeof getSessionOwnershipCoordinator>>;
  private readonly leases = new Map<string, () => void>();
  setOwnershipCoordinator(coordinator: NonNullable<ReturnType<typeof getSessionOwnershipCoordinator>>): void { this.ownership = coordinator; }
  private closed = false;
  private readonly hookChains = new Map<string, HookChain>();
  private readonly hookOutputs = new Map<string, unknown>();
  private readonly hookReferences = new Map<string, object>();
  private captureHooks = false;
  private hookInput?: Record<string, unknown>;
  private toolInput?: Record<string, unknown>;
  private hookFields?: Record<string, unknown>;
  bindHookInput(input: Record<string, unknown>): void { this.hookInput = input; this.captureHooks = true; }
  bindToolInput(input: Record<string, unknown>): void { this.toolInput = input; this.captureHooks = true; }
  bindHookFields(fields: Record<string, unknown>): void { this.hookFields = fields; this.captureHooks = true; }
  capturedHookOutput(invocationId: string): unknown { return this.hookOutputs.get(invocationId); }
  capturedHookReference(reference: string): object | undefined { return this.hookReferences.get(reference); }

  encode(options: Options, controls: { providerCapabilities?: boolean; builtinProvider?: NativeProviderDescriptor } = {}): Record<string, unknown> {
    const { abortController: _abort, provider, customTools, mcpServers, env, ...plain } = options;
    this.provider = provider;
    this.codeSearch = includesCodeSearch(options) ? codeSearchBridge(options) : undefined;
    const encoded = this.encodeValue(plain) as Record<string, unknown>;
    encoded.nativeProcessEnv = { ...process.env };
    const inheritedReadDeny = readDenyFloor(options);
    if (inheritedReadDeny.length) encoded.nativeReadDenyRoots = inheritedReadDeny;
    if (this.codeSearch) encoded.nativeCodeSearchBridge = true;
    encoded.nativeHomeDirectory = homedir(); encoded.nativeTempDirectory = tmpdir(); encoded.nativeProcessCwd = process.cwd();
    this.ownership = getSessionOwnershipCoordinator() ?? this.ownership;
    if (this.ownership) encoded.nativeOwnershipBridge = true;
    if (env !== undefined) encoded.env = env === null ? null : Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value === undefined ? { [UNDEFINED]: true } : this.encodeValue(value)]));
    if (options.promptProfile && typeof options.promptProfile === 'object' && options.promptProfile.models) {
      const profile = encoded.promptProfile as Record<string, unknown>;
      profile.models = Object.fromEntries(Object.entries(options.promptProfile.models).map(([key, value]) => [key, value === undefined ? { [UNDEFINED]: true } : value]));
    }
    const builtin = controls.builtinProvider ?? (provider ? nativeProviderDescriptor(provider) : undefined);
    if (builtin) encoded.provider = { __haloSdkNativeBuiltinProvider: this.encodeValue(builtin) };
    else if (provider) encoded.provider = {
      id: controls.providerCapabilities === false ? 'custom' : provider.id, name: controls.providerCapabilities === false ? 'Custom' : provider.name, capabilities: controls.providerCapabilities === false ? {} : provider.capabilities(), __haloSdkNativeProvider: true,
    };
    if (customTools) encoded.customTools = this.encodeTools(customTools);
    if (mcpServers) encoded.mcpServers = Object.fromEntries(Object.entries(mcpServers).map(([name, config]) => {
      if (config.type !== 'sdk') return [name, this.encodeValue(config)];
      const server = (config as unknown as { instance: Server }).instance;
      if (server) {
        this.servers.set(name, server);
        if (server._registeredTools) this.registeredTools.set(name, new Map(Object.entries(server._registeredTools)));
      }
      const metadata = config as unknown as Record<string, unknown>;
      return [name, this.encodeValue({ type: 'sdk', name: config.name,
        description: metadata.description ?? server?.description,
        instructions: metadata.instructions ?? server?.instructions,
        tools: server ? this.listTools(name) : [],
      })];
    }));
    return encoded;
  }

  encodeTools(tools: Tool[], exact = false): unknown[] {
    if (exact) this.tools.clear();
    const names = new Set<string>();
    return tools.map(tool => {
      if (!names.has(tool.name)) { this.tools.set(tool.name, tool); names.add(tool.name); }
      const implementation = nativeToolImplementation(tool);
      const descriptor = this.encodeValue({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
        permissionLevel: tool.permissionLevel, requiresUserInteraction: tool.requiresUserInteraction, mcpSource: tool.mcpSource }) as Record<string, unknown>;
      const definition = nativeToolDefinition(tool, descriptor);
      if (definition) descriptor.__haloSdkNativeToolDefinition = definition;
      if (implementation) descriptor.__haloSdkNativeTool = { name: implementation.name, concurrencySafe: implementation.concurrencySafe };
      const mcp = mcpToolRegistration(tool);
      if (mcp) {
        let registrationId = this.mcpRegistrationIds.get(mcp);
        if (!registrationId) { registrationId = randomUUID(); this.mcpRegistrationIds.set(mcp, registrationId); this.mcpRegistrations.set(registrationId, new WeakRef(mcp)); this.mcpFinalizer.register(mcp, registrationId); }
        descriptor.__haloSdkNativeMcp = { ...mcp.descriptor.nativeMcp, registrationId };
      }
      if (tool.isConcurrencySafe && !implementation?.nativeConcurrency) descriptor.isConcurrencySafe = { [CALLBACK]: 'tool-classification' };
      return descriptor;
    });
  }

  private encodeValue(value: unknown, owner?: object): unknown {
    if (typeof value === 'function') {
      const id = String(++this.nextId);
      this.callbacks.set(id, value.bind(owner));
      return { [CALLBACK]: id };
    }
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return { __haloSdkNativeNumber: Object.is(value, -0) ? '-0' : String(value) };
    if (value === undefined || value === null || typeof value !== 'object') return value;
    if (value instanceof AbortSignal) return { [SIGNAL]: true };
    if (Array.isArray(value)) return value.map(item => this.encodeValue(item));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Native SDK options must be plain data outside provider, customTools and MCP server instances');
    }
    if (CALLBACK in value || SIGNAL in value || UNDEFINED in value) throw new TypeError('Reserved native option key');
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, this.encodeValue(child, value)]));
  }

  private restore(value: unknown, signal: AbortSignal): any {
    if (Array.isArray(value)) return value.map(item => this.restore(item, signal));
    if (!value || typeof value !== 'object') return value;
    if (SIGNAL in value) return signal;
    if (UNDEFINED in value) return undefined;
    if ('__haloSdkNativeNumber' in value && Object.keys(value).length === 1) {
      const number = (value as { __haloSdkNativeNumber: string }).__haloSdkNativeNumber;
      if (['NaN', 'Infinity', '-Infinity', '-0'].includes(number)) return Number(number);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, this.restore(child, signal)]));
  }

  private listTools(name: string): unknown[] {
    const server = this.servers.get(name);
    if (!server) throw new Error('Unknown host MCP server');
    if (typeof server.listTools === 'function') return server.listTools();
    if (server._registeredTools) return Object.entries(server._registeredTools)
      .filter(([, tool]) => tool.enabled !== false)
      .map(([name, tool]) => ({ name, description: tool.description ?? '',
        inputSchema: zodToJsonSchema(tool.inputSchema), annotations: tool.annotations }));
    return [];
  }

  async call(id: string, method: string, params: any): Promise<unknown> {
    if (this.closed) throw new Error('Session callback is no longer available');
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      return await this.context.runInAsyncScope(() => this.invoke(method, params, controller));
    } finally { this.active.delete(id); }
  }

  private async invoke(method: string, params: any, controller: AbortController): Promise<unknown> {
    if (method === 'http.prepare') { prepareHttpAttempt(); return null; }
    const signal = controller.signal;
    if (method === 'mcp.public.call') {
      const registration = this.mcpRegistrations.get(params.registrationId)?.deref();
      if (!registration) throw new Error('MCP tool registration is no longer available');
      return registration.invoke(this.restore(params.input, signal), signal);
    }
    if (method === 'loop.call') {
      if (!this.loop) throw new Error('Public loop callback owner is no longer available');
      const options = this.loop.options;
      const callback = options[params.name as keyof QueryLoopOptions];
      if (typeof callback !== 'function') return undefined;
      const args = this.restore(params.args ?? [], signal);
      if (params.name === 'onToolContextChange') {
        const handle = this.handle?.toolDiscoveryState?.();
        if (!handle) throw new Error('Native tool discovery state handle is not available');
        args[0] = wrapToolDiscoveryState(handle, [...this.tools.values()]);
      }
      const returned = (callback as Callback).apply(options, args);
      if (voidLoopCallbacks.has(params.name)) return undefined;
      const result = asyncLoopCallbacks.has(params.name) ? await returned : returned;
      return params.name === 'getToolState' && result !== undefined ? this.encodeTools(result as Tool[], true) : result;
    }
    if (method === 'loop.overrides') {
      const overrides = this.loop?.options.configOverrides;
      if (!overrides) return {};
      const model = overrides.model;
      const result = { ...overrides };
      if (model !== undefined && overrides.model === model) delete overrides.model;
      return result;
    }
    if (method === 'loop.configApplied') {
      if (!this.loop) throw new Error('Public loop callback owner is no longer available');
      const values = this.restore(params, signal);
      Object.assign(this.loop.config, { permissionMode: values.permissionMode, thinking: values.thinking, thinkingExplicit: values.thinkingExplicit });
      return undefined;
    }
    if (method === 'loop.contextState') {
      const state = this.loop?.options.contextState;
      if (state) {
        const values = this.restore(params, signal); state.model = values.model;
        for (const key of ['compactedHistoryTokens', 'deferredCompactionTokens'] as const) {
          if (values[key] === undefined) delete state[key]; else state[key] = values[key];
        }
      }
      return undefined;
    }
    if (method.startsWith('file.readState.')) {
      const state = this.directContext?.readFileState ?? this.loop?.options.readFileState;
      if (!state) throw new Error('External file read state is no longer available');
      if (method === 'file.readState.get') {
        const captured = typeof params.receipt === 'string' ? this.contextReadStates.get(params.receipt) : this.directReadState;
        if (typeof params.receipt === 'string' || this.directContext) {
          if (!captured || captured.path !== params.path) throw new Error('External file read state is no longer available');
          return captured.value;
        }
        return state.get(params.path);
      }
      if (method === 'file.readState.delete') return state.delete(params.path);
      if (method === 'file.readState.set') {
        if (!Number.isSafeInteger(params.maxEntries) || params.maxEntries < 1) throw new Error('Invalid native file read state capacity');
        state.delete(params.path);
        while (state.size >= params.maxEntries) state.delete(state.keys().next().value!);
        state.set(params.path, this.restore(params.value, signal)); return undefined;
      }
    }
    if (method === 'direct.emit') return this.directContext?.onToolMessage?.(this.restore(params.event, signal));
    if (method === 'direct.background') {
      const registry = this.directContext?.services?.backgroundTasks ?? this.loop?.options.toolServices?.backgroundTasks;
      if (!registry) throw new Error('Background task services are no longer available');
      const snapshot = (task: BackgroundTask | undefined): unknown => {
        if (!task) return undefined;
        let nativeEntryId = this.backgroundEntryIds.get(task);
        if (!nativeEntryId) { nativeEntryId = randomUUID(); this.backgroundEntryIds.set(task, nativeEntryId); this.backgroundEntries.set(nativeEntryId, task); }
        const { done: _done, ...data } = task; return { ...data, nativeEntryId };
      };
      const args = this.restore(params.args ?? [], signal);
      if (params.method === 'activeCount') return registry.activeCount;
      if (params.method === 'get') return snapshot(registry.get(args[0]));
      if (params.method === 'getAll') return registry.getAll().map(snapshot);
      if (params.method === 'start') return snapshot(await registry.start({ ...args[0], state: { ...args[0].state, envVars: new Map(args[0].state.envVars) },
        abortSignal: this.directContext?.abortSignal ?? this.loop?.config.abortSignal ?? signal }));
      if (params.method === 'wait' || params.method === 'readOutput') {
        const task = this.backgroundEntries.get(args[0]?.entryId);
        if (!task) throw new Error('Background task entry is no longer available');
        if (params.method === 'wait') { await task.done; return snapshot(task); }
        const preview = await registry.readOutput(task); return { entry: snapshot(task), preview };
      }
      if (params.method === 'stop') return registry.stop(args[0]);
      if (params.method === 'stopAll') { registry.stopAll(); return undefined; }
      if (params.method === 'dispose') { registry.dispose(); return undefined; }
      if (params.method === 'flush') { await registry.flush(); return undefined; }
      throw new Error(`Unknown background task operation: ${String(params.method)}`);
    }
    if (method === 'ownership.acquire') {
      if (!this.ownership) throw new Error('No transcript ownership coordinator is registered');
      const release = await this.ownership({ path: params.path, sessionId: params.sessionId }, signal);
      if (this.closed || signal.aborted) { release(); throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' }); }
      const lease = randomUUID(); this.leases.set(lease, release); return lease;
    }
    if (method === 'ownership.release') {
      const release = this.leases.get(params.leaseId);
      this.leases.delete(params.leaseId); release?.(); return null;
    }
    if (method === 'hooks.release') {
      const chainId = String(params.chainId);
      if (this.captureHooks) for (const [id, value] of this.hookChains.get(chainId)?.references ?? []) this.hookReferences.set(`${chainId}:${id}`, value);
      this.hookChains.delete(chainId); return null;
    }
    if (method === 'hooks.call') {
      let chain = this.hookChains.get(String(params.chainId));
      if (!chain) {
        const input = this.hookInput ?? this.restore(params.input, signal);
        if (this.toolInput !== undefined) input.tool_input = this.toolInput;
        else if (this.hookInput === undefined && Object.hasOwn(params.input, 'tool_input')) input.tool_input = params.input.tool_input;
        if (this.hookFields) Object.assign(input, this.hookFields);
        chain = { input, originalToolInput: input.tool_input, lastNative: params.input,
          references: new Map(), identities: new WeakMap(), nextReference: 0 };
        this.hookChains.set(String(params.chainId), chain);
      } else {
        for (const key of new Set([...Object.keys(chain.lastNative), ...Object.keys(params.input)])) {
          if (JSON.stringify(chain.lastNative[key]) !== JSON.stringify(params.input[key]) && JSON.stringify(chain.input[key]) !== JSON.stringify(params.input[key])) {
            if (Object.hasOwn(params.input, key)) chain.input[key] = key === 'tool_input' ? params.input[key] : this.restore(params.input[key], signal);
            else delete chain.input[key];
          }
        }
        chain.lastNative = params.input;
      }
      const threaded = typeof params.toolInputReference === 'string' ? chain.references.get(params.toolInputReference) : undefined;
      if (threaded !== undefined) chain.input.tool_input = threaded;
      const callback = this.callbacks.get(String(params.callbackId));
      if (!callback) throw new Error('Session callback is no longer available');
      let result: any;
      let error: unknown;
      try { result = await callback(chain.input, this.restore(params.toolUseId, signal), { signal }); }
      catch (failure) { error = JSON.parse(callbackError(failure)); }
      if (this.captureHooks && result && typeof result === 'object') this.hookOutputs.set(String(params.invocationId), result);
      chain.lastNative = JSON.parse(JSON.stringify(chain.input));
      const reference = (value: unknown): string | undefined => {
        if (!value || typeof value !== 'object') return undefined;
        let id = chain!.identities.get(value);
        if (!id) { id = String(++chain!.nextReference); chain!.identities.set(value, id); chain!.references.set(id, value); }
        return id;
      };
      return { result, input: chain.input, originalToolInput: chain.originalToolInput,
        ...(threaded !== undefined ? { threadedToolInput: threaded } : {}),
        inputReferences: { flatUpdatedInput: reference(result?.updatedInput), envelopeUpdatedInput: reference(result?.hookSpecificOutput?.updatedInput) },
        ...(error ? { error } : {}),
      };
    }
    if (method === 'callback') {
      const callback = this.callbacks.get(String(params.callbackId));
      if (!callback) throw new Error('Session callback is no longer available');
      return callback(...this.restore(params.args ?? [], signal));
    }
    if (method === 'permissions.call') {
      const callback = this.callbacks.get(String(params.callbackId));
      if (!callback) throw new Error('Session callback is no longer available');
      const input = params.input;
      try {
        const result = await callback(params.name, input, { signal, toolUseID: params.toolUseId });
        return { result, input };
      } catch (error) { return { input, error: JSON.parse(callbackError(error)) }; }
    }
    if (method === 'commands.execute') {
      const callback = this.callbacks.get(String(params.command?.[params.method]?.[CALLBACK]));
      if (!callback) throw new Error('Session callback is no longer available');
      const command = async (name: string, args: unknown[]) => {
        if (!this.handle?.command) throw new Error('Native tool context transport is not attached');
        try { await this.handle.command('commandContext', JSON.stringify([params.context.sessionId, name, args])); }
        catch (error) { throw nativeError(error); }
      };
      const restoreCommand = (value: any): any => {
        if (Array.isArray(value)) return value.map(restoreCommand);
        if (!value || typeof value !== 'object') return value;
        if (CALLBACK in value) return this.callbacks.get(String(value[CALLBACK]));
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, restoreCommand(child)]));
      };
      const pending: Promise<void>[] = [];
      let controlError: unknown;
      const supplied = params.context;
      const context = {
        sessionId: supplied.sessionId, cwd: supplied.cwd, model: supplied.model,
        mcpServerStatuses: supplied.mcpServerStatuses,
        messages: Object.freeze([...supplied.messages]), commands: restoreCommand(supplied.commands),
        clearMessages: async () => { if (!supplied.nativeQuery) await command('clearMessages', []); },
        setModel: (model: string) => {
          if (!supplied.nativeQuery && model && typeof model === 'string') pending.push(command('setModel', [model]).catch(error => { controlError = error; }));
        },
        compactSession: async (instructions?: string) => { await command('compactSession', [instructions]); },
        getCostSnapshot: () => Object.freeze({ ...supplied.cost, tokens: Object.freeze({ ...supplied.cost.tokens }) }),
      };
      try { return await callback(params.args, context); }
      finally { await Promise.all(pending); if (controlError) throw controlError; }
    }
    if (method === 'file.recordChange') {
      const callback = this.callbacks.get(String(params.callbackId));
      if (!callback) throw new Error('Session callback is no longer available');
      callback(params.path, Buffer.from(params.before, 'base64'), Buffer.from(params.after, 'base64'));
      return null;
    }
    if (method === 'codeSearch.search') {
      if (!this.codeSearch) throw new Error('Code search callback owner is no longer available');
      return this.codeSearch.search({ ...this.restore(params, signal), signal });
    }
    if (method === 'tools.concurrencySafe') return this.tools.get(params.name)?.isConcurrencySafe?.(this.restore(params.input, signal)) === true;
    if (method === 'tools.execute') {
      const tool = this.tools.get(params.name);
      if (!tool) throw new Error(`Unknown custom tool: ${params.name}`);
      if (!this.handle) throw new Error('Native tool context transport is not attached');
      const reads = this.loop?.options.readFileState;
      const context = createToolContext(this.handle, this.restore(params.context, signal), signal, this.toolContextCache, reads ? {
        capture: (id, path) => { this.contextReadStates.set(id, { path, value: reads.get(path) }); },
        release: id => { this.contextReadStates.delete(id); },
      } : undefined);
      if (this.loop) {
        if (this.loop.options.readFileState) context.readFileState = this.loop.options.readFileState;
        context.services = this.loop.options.toolServices;
        context.env = this.loop.config.env;
        context.conventions = this.loop.config.conventions;
        context.additionalDirectories = this.loop.config.additionalDirectories;
        context.readDenyRoots = this.loop.config.readDenyRoots;
      }
      const recorder = params.context?.recordFileChange?.[CALLBACK];
      if (recorder !== undefined) {
        const callback = this.callbacks.get(String(recorder));
        if (!callback) throw new Error('Session callback is no longer available');
        context.recordFileChange = (path, before, after) => { callback(path, before, after); };
      }
      // Typed wire preserves business data that resembles the legacy control markers.
      const input = params.inputWire === undefined ? this.restore(params.input, signal) : decodeWire(params.inputWire);
      return tool.execute(input, context);
    }
    if (method === 'mcp.list') return this.listTools(params.server);
    if (method === 'mcp.call') {
      const server = this.servers.get(params.server);
      if (!server) throw new Error('Unknown host MCP server');
      if (typeof server.callTool === 'function') return server.callTool(params.name, params.input, { signal });
      const tool = this.registeredTools.get(params.server)?.get(params.name) ?? server._registeredTools?.[params.name];
      if (!tool || tool.enabled === false) throw new Error('Unknown host MCP tool');
      return tool.handler(params.input, { signal });
    }
    if (method === 'provider.start') {
      if (!this.provider) throw new Error('No custom provider is registered');
      const request = this.request(params, signal);
      const streamId = randomUUID();
      this.streams.set(streamId, { iterator: this.provider.createMessageStream(request), controller });
      return streamId;
    }
    if (method === 'provider.next') {
      const stream = this.streams.get(params.streamId);
      if (!stream) throw new Error('Provider stream is no longer available');
      const abort = () => stream.controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await stream.iterator.next();
        if (result.done) this.streams.delete(params.streamId);
        return result;
      } finally { signal.removeEventListener('abort', abort); }
    }
    if (method === 'provider.return') {
      const stream = this.streams.get(params.streamId);
      this.streams.delete(params.streamId);
      if (stream) {
        stream.controller.abort();
        const closing = stream.iterator.return();
        if (params.cancelled) void closing.catch(error => {
          if (!isAbortError(error)) getLogger('Native').warn('Provider stream cleanup failed after cancellation', { error: String(error) });
        });
        else await closing;
      }
      return null;
    }
    if (method === 'provider.complete') {
      if (!this.provider) throw new Error('No custom provider is registered');
      return this.provider.createMessage(this.request(params, signal));
    }
    if (method === 'provider.models') return this.provider?.listModels?.() ?? [];
    if (method === 'provider.health') return this.provider?.healthCheck?.() ?? { status: 'healthy' };
    throw new Error(`Unknown native callback method: ${method}`);
  }

  private request(params: ProviderRequest, signal: AbortSignal): ProviderRequest {
    const request = this.restore(params, signal) as ProviderRequest;
    return { ...request, providerOptions: { ...request.providerOptions, signal } };
  }

  cancel(id: string): void { this.active.get(id)?.abort(); }

  abort(): void {
    for (const controller of this.active.values()) controller.abort();
    for (const stream of this.streams.values()) stream.controller.abort();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort();
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const stream of streams) {
      try {
        void stream.iterator.return().catch(error => {
          if (!isAbortError(error)) getLogger('Native').warn('Provider stream cleanup failed after cancellation', { error: String(error) });
        });
      } catch (error) {
        if (!isAbortError(error)) getLogger('Native').warn('Provider stream cleanup failed after cancellation', { error: String(error) });
      }
    }
    for (const release of this.leases.values()) {
      try { release(); } catch (error) { getLogger('Native').warn('Transcript lease release failed', { error: String(error) }); }
    }
    this.leases.clear();
    this.callbacks.clear(); this.tools.clear(); this.servers.clear(); this.registeredTools.clear();
    this.mcpRegistrations.clear();
    this.toolContextCache.clear();
    this.loop = undefined;
    this.directContext = undefined; this.directReadState = undefined; this.contextReadStates.clear(); this.backgroundEntries.clear();
    this.hookChains.clear(); this.hookOutputs.clear(); this.hookReferences.clear(); this.hookInput = undefined; this.toolInput = undefined; this.hookFields = undefined; this.provider = undefined;
    this.codeSearch = undefined;
    this.context.emitDestroy();
  }
}
