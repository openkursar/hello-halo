import { describe, expect, it, vi } from 'vitest';
import type { Message, ContentBlock } from '../types/provider.js';
import type { SDKAssistantMessage } from './query-types.js';
import { AssistantHistoryRecorder } from './assistant-history.js';

function frame(uuid: string, content: ContentBlock[]): SDKAssistantMessage {
  return { type: 'assistant', uuid, session_id: 'session', parent_tool_use_id: null,
    message: { id: 'reused-provider-id', type: 'message', role: 'assistant', model: 'test',
      content, stop_reason: null, stop_sequence: null } };
}

const first: ContentBlock = { type: 'tool_use', id: 'one', name: 'Read', input: { file_path: '/a' } };
const second: ContentBlock = { type: 'tool_use', id: 'two', name: 'Read', input: { file_path: '/b' } };

describe('AssistantHistoryRecorder', () => {
  it('retains one assistant message and writes each completed block exactly once', async () => {
    const retained: Message[] = [];
    const persist = vi.fn(async () => {});
    const finalize = vi.fn(async () => {});
    const recorder = new AssistantHistoryRecorder(persist, message => { retained.push(message); }, finalize);
    await recorder.recordBlock(frame('block-one', [first]), 'response');
    await recorder.recordBlock(frame('block-two', [second]), 'response');
    expect(retained).toEqual([{ role: 'assistant', content: [first, second] }]);
    await recorder.recordMessage(frame('response', [first, second]));
    expect(persist).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(frame('response', [first, second]), 'response');
    expect(persist.mock.calls[0]).toEqual([frame('block-one', [first]), 'response']);
    expect(retained).toHaveLength(1);
  });

  it('separates interrupted and subsequent responses even when provider IDs repeat', async () => {
    const retained: Message[] = [];
    const recorder = new AssistantHistoryRecorder(async () => {}, message => { retained.push(message); });
    await recorder.recordBlock(frame('first-block', [first]), 'first-response');
    await recorder.recordBlock(frame('second-block', [second]), 'second-response');
    await recorder.recordMessage(frame('second-response', [second]));
    expect(retained).toEqual([{ role: 'assistant', content: [first] }, { role: 'assistant', content: [second] }]);
  });

  it('waits for persistence and exposes a failed checkpoint to the caller', async () => {
    const retained: Message[] = [];
    const persist = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const recorder = new AssistantHistoryRecorder(persist, message => { retained.push(message); });
    await expect(recorder.recordBlock(frame('failed', [first]), 'response')).rejects.toThrow('disk full');
    expect(retained).toEqual([]);
    await recorder.recordBlock(frame('saved', [second]), 'response');
    expect(retained).toEqual([{ role: 'assistant', content: [second] }]);
  });

  it('writes a text-only full response using the existing final-message path', async () => {
    const retained: Message[] = [];
    const persist = vi.fn(async () => {});
    const recorder = new AssistantHistoryRecorder(persist, message => { retained.push(message); });
    const message = frame('response', [{ type: 'text', text: 'done' }]);
    await recorder.recordMessage(message);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(message);
    expect(retained).toEqual([{ role: 'assistant', content: message.message.content }]);
  });
});

describe('assistant tool-context metadata bounds', () => {
  it('refuses an overflowing grouped record before appending the new block and preserves prior state', async () => {
    const { TOOL_CONTEXT_LIMITS } = await import('./tool-context/index.js');
    const retained: Message[] = [];
    const persist = vi.fn(async () => {});
    const recorder = new AssistantHistoryRecorder(persist, message => retained.push(message));
    const largeFrame = (id: string): SDKAssistantMessage => {
      const input = { data: 'x'.repeat(TOOL_CONTEXT_LIMITS.stateBytes) };
      const message = frame(id, [{ type: 'tool_use', id, name: 'mcp__fixture__write', input }]);
      message.message.toolContext = { version: 1, calls: [{ id, definitionVersion: 'fixture-version',
        input: { tool: 'mcp__fixture__write', arguments: JSON.stringify(input) } }] };
      return message;
    };
    const first = largeFrame('one');
    const second = largeFrame('two');
    for (const message of [first, second]) {
      expect(Buffer.byteLength(JSON.stringify(message.message.toolContext), 'utf8')).toBeLessThan(TOOL_CONTEXT_LIMITS.stateBytes * 2);
    }
    await recorder.recordBlock(first, 'response');
    await expect(recorder.recordBlock(second, 'response')).rejects.toThrow('tool context exceeds');
    expect(persist).toHaveBeenCalledOnce();
    expect(retained).toHaveLength(1);
    expect(retained[0].toolContext?.calls?.map(call => call.id)).toEqual(['one']);
    await recorder.recordBlock(frame('text', [{ type: 'text', text: 'Retained after refusal.' }]), 'response');
    expect(persist).toHaveBeenCalledTimes(2);
    expect(retained[0].toolContext?.calls?.map(call => call.id)).toEqual(['one']);
  });

  it('rejects an oversized complete response before recording it', async () => {
    const { TOOL_CONTEXT_LIMITS } = await import('./tool-context/index.js');
    const persist = vi.fn(async () => {});
    const recorder = new AssistantHistoryRecorder(persist);
    const input = { data: 'x'.repeat(TOOL_CONTEXT_LIMITS.stateBytes * 2) };
    const complete = frame('response', [{ type: 'tool_use', id: 'large', name: 'mcp__fixture__write', input }]);
    complete.message.toolContext = { version: 1, calls: [{ id: 'large', definitionVersion: 'fixture-version',
      input: { tool: 'mcp__fixture__write', arguments: JSON.stringify(input) } }] };
    await expect(recorder.recordMessage(complete)).rejects.toThrow('tool context exceeds');
    expect(persist).not.toHaveBeenCalled();
  });

  it('counts only the incoming metadata while blocks accumulate', async () => {
    let reads = 0;
    const first = frame('one', [{ type: 'tool_use', id: 'one', name: 'mcp__fixture__write', input: {} }]);
    first.message.toolContext = { version: 1, calls: [{ id: 'one', definitionVersion: 'fixture-version',
      input: { tool: 'mcp__fixture__write', get arguments() { reads++; return '{}'; } } }] };
    const recorder = new AssistantHistoryRecorder(async () => {});
    await recorder.recordBlock(first, 'response');
    expect(reads).toBe(1);
    const next = frame('two', [{ type: 'tool_use', id: 'two', name: 'Read', input: {} }]);
    next.message.toolContext = { version: 1, directCalls: [{ id: 'two', name: 'Read' }] };
    await recorder.recordBlock(next, 'response');
    expect(reads).toBe(1);
  });
});
