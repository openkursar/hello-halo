import type { LlmProvider, ProviderCapabilities, ProviderModelInfo, ProviderRequest, ProviderResponse, ProviderStatus, StreamEvent } from '../types/provider.js';
import type { AnthropicProviderConfig } from '../llm/anthropic.js';
import type { OpenAiCompatProviderConfig } from '../llm/openai-compat.js';
import { getLogger } from '../utils/logger.js';
import { loadBinding, nativeError, callbackError, routeNativeLog, type NativeProviderRequestHandle, type NativeProviderTransportHandle } from './binding.js';
import { NativeCallbacks } from './callbacks.js';
import type { Options } from '../types/config.js';
import { nativeProviderDescriptor, registerNativeProvider, type NativeProviderDescriptor } from './provider-identities.js';

export abstract class NativeProvider implements LlmProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  private transport?: NativeProviderTransportHandle;
  abstract capabilities(): ProviderCapabilities;
  protected nativeOptions(): Options { return { provider: this }; }

  private async *execute(request: ProviderRequest | Record<string, never>, mode: string): AsyncGenerator<StreamEvent, unknown, undefined> {
    const signal = (request as ProviderRequest).providerOptions?.signal as AbortSignal | undefined;
    signal?.throwIfAborted();
    const callbacks = new NativeCallbacks();
    let handle: NativeProviderRequestHandle | undefined;
    const abort = () => { callbacks.abort(); handle?.close(); };
    const respond = async (id: string, method: string, params: unknown) => {
      try {
        const value = await callbacks.call(id, method, params);
        handle!.callbackResponse(id, JSON.stringify(value === undefined ? { __haloSdkNativeUndefined: true } : value));
      } catch (error) {
        try { handle!.callbackResponse(id, 'null', callbackError(error)); }
        catch (failure) { if (!signal?.aborted) getLogger('Native').warn('Provider callback response could not be delivered', { method, error: String(failure) }); }
      }
    };
    try {
      this.transport ??= new (loadBinding().NativeProviderTransport)();
      const underlying = nativeProviderDescriptor(this, true) ?? (this as unknown as { __haloSdkNativeBuiltinProvider?: NativeProviderDescriptor }).__haloSdkNativeBuiltinProvider;
      const encoded = callbacks.encode(this.nativeOptions(), { builtinProvider: mode === 'completeStream' ? undefined : underlying, providerCapabilities: mode !== 'completeStream' });
      if (mode === 'completeStream') encoded.nativeCollectorDefaultModel = (underlying?.config as { defaultModel?: string } | undefined)?.defaultModel;
      handle = new (loadBinding().NativeProviderRequest)(JSON.stringify(encoded), JSON.stringify(request, (key, value) => key === 'signal' && value instanceof AbortSignal ? undefined : value), mode, this.transport);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      while (true) {
        signal?.throwIfAborted();
        const raw = await handle.next();
        if (raw === null) return;
        const envelope = JSON.parse(raw);
        if (envelope.kind === 'log') routeNativeLog(envelope.record);
        else if (envelope.kind === 'callback') { void respond(envelope.id, envelope.method, envelope.params); }
        else if (envelope.kind === 'callbackCancelled') callbacks.cancel(envelope.id);
        else if (envelope.kind === 'event') yield envelope.event as StreamEvent;
        else if (envelope.kind === 'result') return envelope.result;
        else if (envelope.kind === 'closed') return;
        else if (envelope.kind === 'error') throw nativeError(new Error(raw));
        else throw new Error(`Unknown provider envelope kind: ${String(envelope.kind)}`);
      }
    } catch (error) {
      signal?.throwIfAborted();
      throw nativeError(error);
    } finally {
      signal?.removeEventListener('abort', abort);
      callbacks.abort();
      handle?.close();
      await handle?.waitClosed();
      await callbacks.close();
    }
  }

  async createMessage(request: ProviderRequest): Promise<ProviderResponse> {
    return await this.collect(request, 'complete') as ProviderResponse;
  }
  createMessageStream(request: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
    return this.execute(request, 'stream') as AsyncGenerator<StreamEvent, void, undefined>;
  }
  async listModels(): Promise<ProviderModelInfo[]> { return await this.collect({}, 'models') as ProviderModelInfo[]; }
  async healthCheck(): Promise<ProviderStatus> { return await this.collect({}, 'health') as ProviderStatus; }
  protected async collect(request: ProviderRequest | Record<string, never>, mode: string): Promise<unknown> {
    const execution = this.execute(request, mode);
    let step = await execution.next();
    while (!step.done) step = await execution.next();
    return step.value;
  }
}

export class AnthropicProvider extends NativeProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';
  readonly __haloSdkNativeBuiltinProvider: { kind: 'anthropic'; config: AnthropicProviderConfig };
  constructor(config: AnthropicProviderConfig) {
    super();
    this.__haloSdkNativeBuiltinProvider = { kind: 'anthropic', config: { ...config, baseUrl: (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, ''), apiVersion: config.apiVersion ?? '2023-06-01' } };
    registerNativeProvider(this, this.__haloSdkNativeBuiltinProvider, anthropicMethods);
  }
  async createMessage(request: ProviderRequest): Promise<ProviderResponse> {
    return this.createMessageStream === nativeMethods.createMessageStream ? super.createMessage(request) : this.collect(request, 'completeStream') as Promise<ProviderResponse>;
  }
  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: true, thinking: true, imageInput: true,
      pdfInput: true, audioInput: false, videoInput: false, caching: true, systemPromptStyle: 'top_level' };
  }
}

export class OpenAiCompatProvider extends NativeProvider {
  readonly id: string;
  readonly name: string;
  readonly __haloSdkNativeBuiltinProvider: { kind: 'openai-compat'; config: OpenAiCompatProviderConfig };
  constructor(config: OpenAiCompatProviderConfig) {
    super();
    this.id = config.id;
    this.name = config.name;
    this.__haloSdkNativeBuiltinProvider = { kind: 'openai-compat', config: { ...config, baseUrl: config.baseUrl.replace(/\/+$/, '') } };
    registerNativeProvider(this, this.__haloSdkNativeBuiltinProvider, openAiMethods);
  }
  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: true, thinking: !!this.__haloSdkNativeBuiltinProvider.config.quirks?.reasoningField,
      imageInput: true, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'system_message' };
  }
}

const nativeMethods = { createMessage: NativeProvider.prototype.createMessage, createMessageStream: NativeProvider.prototype.createMessageStream,
  listModels: NativeProvider.prototype.listModels, healthCheck: NativeProvider.prototype.healthCheck };
const anthropicMethods = { ...nativeMethods, createMessage: AnthropicProvider.prototype.createMessage, capabilities: AnthropicProvider.prototype.capabilities };
const openAiMethods = { ...nativeMethods, capabilities: OpenAiCompatProvider.prototype.capabilities };
