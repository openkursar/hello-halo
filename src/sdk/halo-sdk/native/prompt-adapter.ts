import type { PromptToolCallingAdapter as AdapterContract } from '../llm/tool-calling/prompt-adapter.js';
import type { ModelFamily, ParseResult, ToolCallingMode } from '../llm/tool-calling/types.js';
import type { LlmProvider, ProviderRequest, ProviderResponse, StreamEvent, ToolDefinition } from '../types/provider.js';
import type { Options } from '../types/config.js';
import { loadBinding, nativeError, parseNativeValue, stringifyNativeValue } from './binding.js';
import { NativeProvider } from './providers.js';
import { decodeWire } from './wire.js';

function value<T>(method: string, args: unknown[]): T {
  try { return parseNativeValue(loadBinding().nativeValue(method, stringifyNativeValue(args))) as T; }
  catch (error) { throw nativeError(error); }
}
export function detectModelFamily(model: string): ModelFamily { return value('toolCalling.family', [model]); }
export function resolveToolCallingMode(model: string, options?: { toolCallingMode?: ToolCallingMode }): ToolCallingMode { return value('toolCalling.mode', [model, options]); }
export function renderToolsBlock(tools: ToolDefinition[]): string { return value('toolCalling.render', [tools, 'xml']); }
interface XmlResult {
  textContent: string;
  toolCalls: Array<{
    name: string;
    rawXml: string;
    parameters: {
      ownEntries: Array<[string, unknown]>;
      prototype: { kind: 'default' } | { kind: 'null' } | { kind: 'data'; value: object };
    };
  }>;
}
export function parseXmlToolCalls(text: string, knownToolNames: string[]): ParseResult {
  try {
    const receipt = loadBinding().parseXmlText(text, knownToolNames);
    if (receipt.unchanged) return { textContent: text, toolCalls: [] };
    const result = decodeWire(JSON.parse(receipt.value!)) as XmlResult;
    return {
      textContent: result.textContent,
      toolCalls: result.toolCalls.map(call => {
        const prototype = call.parameters.prototype;
        const parameters = Object.create(prototype.kind === 'default' ? Object.prototype : prototype.kind === 'null' ? null : prototype.value);
        for (const [key, value] of call.parameters.ownEntries) {
          Object.defineProperty(parameters, key, { value, enumerable: true, writable: true, configurable: true });
        }
        return { name: call.name, parameters, rawXml: call.rawXml };
      }),
    };
  } catch (error) { throw nativeError(error); }
}

export type PromptToolCallingAdapter = AdapterContract;
export const PromptToolCallingAdapter = class extends NativeProvider {
  readonly id: string;
  readonly name: string;
  constructor(private readonly inner: LlmProvider, private readonly mode: ToolCallingMode) {
    super(); this.id = `${inner.id}:${mode}`; this.name = `${inner.name} (${mode})`;
    Object.assign(this, { listModels: inner.listModels?.bind(inner), healthCheck: inner.healthCheck?.bind(inner) });
  }
  capabilities() { return { ...this.inner.capabilities(), toolCalling: true }; }
  protected nativeOptions(): Options { return { provider: this.inner, toolCallingMode: this.mode, ...{ nativePromptAdapter: true } }; }
  async createMessage(request: ProviderRequest): Promise<ProviderResponse> {
    return request.tools?.length ? super.createMessage(request) : this.inner.createMessage(request);
  }
  async *createMessageStream(request: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
    if (request.tools?.length) yield* super.createMessageStream(request);
    else yield* this.inner.createMessageStream(request);
  }
} as unknown as typeof AdapterContract;
