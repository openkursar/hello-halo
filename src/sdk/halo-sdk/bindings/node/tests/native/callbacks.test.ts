import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { NativeCallbacks } from '../../native/callbacks.js';
import type { LlmProvider, ProviderRequest } from '../../types/provider.js';

const capabilities = { streaming: true, toolCalling: true, thinking: false, imageInput: false,
  pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' as const };
const request: ProviderRequest = { model: 'fixture', messages: [], maxTokens: 10, stream: true };

describe('native extension bridge', () => {
  it('isolates prepared sibling providers and rejects late preparation after cancellation', async () => {
    const bridge = new NativeCallbacks();
    const seen: string[] = [];
    const provider = (id: string): LlmProvider => ({ id, name: id, capabilities: () => capabilities,
      async createMessage() { seen.push(id); return { content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' } as any; },
      async *createMessageStream() { seen.push(id); },
    });
    bridge.encode({ provider: provider('parent') });
    const metadata = { bindingId: 'binding', restoreRef: 'restore', model: 'fixture', targetKind: 'single' as const,
      contextWindow: 32000, maxOutputTokens: 1000, modalities: ['text'], reasoning: { default: { version: 1 as const, mode: 'provider-default' as const } } };
    let complete!: (value: any) => void;
    bridge.bindModelSelection({ policy: 'inherit', policyRevision: 'one', parentBinding: { bindingId: 'parent', restoreRef: 'parent' },
      getCatalog() { throw new Error('Unexpected catalog'); },
      async prepare(input) {
        if (input.kind === 'restore') return new Promise(resolve => { complete = resolve; });
        return { ...metadata, provider: provider(input.plan.parent.bindingId) };
      },
    });
    const prepare = (id: string) => bridge.call(id, 'modelSelection.prepare', { request: { kind: 'new', plan: { parent: { bindingId: id } } } }) as Promise<any>;
    const [first, second] = await Promise.all([prepare('first'), prepare('second')]);
    const invoke = (lease: any, method: string, params: unknown) => bridge.call(Math.random().toString(), 'modelSelection.provider', { nativeModelBindingId: lease.nativeModelBindingId, method, params });
    await Promise.all([invoke(first, 'provider.complete', request), invoke(second, 'provider.complete', request), bridge.call('parent', 'provider.complete', request)]);
    expect(seen).toEqual(['first', 'second', 'parent']);
    const streamId = await invoke(first, 'provider.start', request);
    await expect(invoke(second, 'provider.next', { streamId })).rejects.toThrow('no longer available');
    await bridge.call('release', 'modelSelection.release', first);
    await expect(invoke(first, 'provider.complete', request)).rejects.toThrow('lease');
    await invoke(second, 'provider.complete', request);
    const pending = bridge.call('pending', 'modelSelection.prepare', { request: { kind: 'restore', snapshot: {} } });
    bridge.cancel('pending');
    complete({ ...metadata, provider: provider('late') });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await bridge.close();
  });
  it('retains permission input mutations when the callback throws', async () => {
    const bridge = new NativeCallbacks();
    const encoded = bridge.encode({ canUseTool: async (_name, input, options) => {
      expect(options.toolUseID).toBe('call');
      input.path = 'mutated'; throw new Error('permission fixture');
    } });
    const response = await bridge.call('permission', 'permissions.call', { callbackId: (encoded.canUseTool as any).__haloSdkNativeCallback,
      name: 'Read', input: { path: 'original' }, toolUseId: 'call' }) as any;
    expect(response.input).toEqual({ path: 'mutated' });
    expect(response.error.message).toBe('permission fixture');
    expect(response.error.stringValue).toBe('Error: permission fixture');
    await bridge.close();
  });

  it('does not await an uncooperative provider iterator after cancellation', async () => {
    let release!: () => void;
    let cleaned = false;
    const bridge = new NativeCallbacks();
    bridge.encode({ provider: { id: 'fixture', name: 'Fixture', capabilities: () => capabilities,
      async createMessage() { throw new Error('Unexpected complete'); },
      async *createMessageStream() { try { await new Promise<void>(resolve => { release = resolve; }); } finally { cleaned = true; } },
    } });
    const streamId = await bridge.call('start', 'provider.start', request);
    const next = bridge.call('next', 'provider.next', { streamId });
    await bridge.call('return', 'provider.return', { streamId, cancelled: true });
    await bridge.close();
    expect(cleaned).toBe(false);
    release(); await next;
    expect(cleaned).toBe(true);
  });
  it('preserves callback context, omitted arguments and cancellation without sharing sessions', async () => {
    const storage = new AsyncLocalStorage<string>();
    const first = storage.run('first-session', () => new NativeCallbacks());
    const second = storage.run('second-session', () => new NativeCallbacks());
    const seen: unknown[] = [];
    const callback = async (...args: unknown[]) => { seen.push(storage.getStore(), ...args); return { behavior: 'allow' }; };
    const encoded = first.encode({ model: 'fixture', canUseTool: callback });
    const other = second.encode({ model: 'fixture', canUseTool: callback });
    const ref = encoded.canUseTool as { __haloSdkNativeCallback: string };
    await first.call('a', 'callback', { callbackId: ref.__haloSdkNativeCallback,
      args: ['Read', { path: 'fixture' }, { __haloSdkNativeUndefined: true }] });
    await second.call('b', 'callback', { callbackId: (other.canUseTool as typeof ref).__haloSdkNativeCallback, args: [] });
    expect(seen).toEqual(['first-session', 'Read', { path: 'fixture' }, undefined, 'second-session']);
    let signal: AbortSignal | undefined;
    const pending = first.encode({ model: 'fixture', canUseTool: async (_name, _input, options) => {
      signal = options.signal;
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { behavior: 'deny', message: 'Cancelled' };
    } });
    const result = first.call('c', 'callback', { callbackId: (pending.canUseTool as typeof ref).__haloSdkNativeCallback,
      args: ['Read', {}, { signal: { __haloSdkNativeSignal: true } }] });
    first.cancel('c');
    expect(signal?.aborted).toBe(true);
    expect(await result).toEqual({ behavior: 'deny', message: 'Cancelled' });
    await first.close(); await second.close();
  });

  it('pulls a custom provider one event at a time and returns its iterator on cancellation', async () => {
    let yielded = 0;
    let cleaned = false;
    let signal: AbortSignal | undefined;
    const provider: LlmProvider = {
      id: 'fixture', name: 'Fixture', capabilities: () => capabilities,
      async createMessage() { throw new Error('Unexpected nonstreaming request'); },
      async *createMessageStream(input) {
        signal = input.providerOptions?.signal as AbortSignal;
        try {
          yielded++;
          yield { type: 'text_delta', index: 0, text: 'one' };
          yielded++;
          yield { type: 'text_delta', index: 0, text: 'two' };
        } finally { cleaned = true; }
      },
    };
    const bridge = new NativeCallbacks();
    expect(bridge.encode({ model: 'fixture', provider }).provider).toEqual({
      id: 'fixture', name: 'Fixture', capabilities, __haloSdkNativeProvider: true,
    });
    const streamId = await bridge.call('start', 'provider.start', request);
    expect(yielded).toBe(0);
    expect(await bridge.call('next', 'provider.next', { streamId })).toEqual({ done: false,
      value: { type: 'text_delta', index: 0, text: 'one' } });
    expect(yielded).toBe(1);
    await bridge.call('return', 'provider.return', { streamId });
    expect(signal?.aborted).toBe(true);
    expect(cleaned).toBe(true);
    await bridge.close();
  });

  it('keeps original MCP server and tool identities and executes the registered handler', async () => {
    const calls: unknown[] = [];
    const bridge = new NativeCallbacks();
    const options = bridge.encode({ model: 'fixture', mcpServers: {
      'server key': { type: 'sdk', name: 'display', instance: {
        name: 'display', version: '1', tools: [], description: 'A service', instructions: 'Use exactly.\n',
        listTools: () => [{ name: 'a/b', description: 'Literal tool.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
        async callTool(name, input, extra) {
          calls.push(name, input, extra?.signal instanceof AbortSignal);
          return { content: [{ type: 'text', text: 'executed' }] };
        },
      } },
    } });
    expect((options.mcpServers as any)['server key'].tools[0].name).toBe('a/b');
    expect((options.mcpServers as any)['server key'].instructions).toBe('Use exactly.\n');
    expect(await bridge.call('tool', 'mcp.call', { server: 'server key', name: 'a/b', input: { value: 7 } }))
      .toEqual({ content: [{ type: 'text', text: 'executed' }] });
    expect(calls).toEqual(['a/b', { value: 7 }, true]);
    await bridge.close();
  });
});
