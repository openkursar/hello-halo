import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { queryLoop } from './query-loop.js';
import { resolveQueryConfig } from './context.js';
import { AssistantHistoryRecorder } from './assistant-history.js';
import { createSdkMcpServer, tool } from '../tools/mcp/sdk-server.js';
import { extractSdkMcpTools } from '../tools/mcp/bridge.js';
import { readToolContextSnapshot } from './tool-context/index.js';
import type { ContentBlock, Message, LlmProvider, StreamEvent } from '../types/provider.js';
import type { SDKAssistantMessage, SDKMessage } from './query-types.js';
import type { Tool } from '../types/tool.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const target = 'mcp__fixture__write';
function* call(index: number, id: string, name: string, input: Record<string, unknown>): Generator<StreamEvent> {
  yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } };
  yield { type: 'input_json_delta', index, partialJson: JSON.stringify(input) };
  yield { type: 'content_block_stop', index };
}

describe('partial tool-context checkpoint failure', () => {
  it.each(['wrapped', 'rejected-wrapper', 'eager'] as const)('retains only committed IDs when a later %s checkpoint fails', async failure => {
    const cwd = await mkdtemp(join(tmpdir(), 'partial-tool-context-')); directories.push(cwd);
    let finish!: () => void;
    const effectFinished = new Promise<void>(resolve => { finish = resolve; });
    const effect = vi.fn(async () => { finish(); return { content: [{ type: 'text' as const, text: 'Saved once.' }] }; });
    const eagerEffect = vi.fn(async () => ({ content: 'Must not run.', isError: false }));
    const tools: Tool[] = [...extractSdkMcpTools({ fixture: createSdkMcpServer({ name: 'fixture', tools: [
      tool('write', 'Write one fixture record.', { type: 'object' }, effect),
    ] }) }), { name: 'EagerOperation', description: 'An eager operation.', inputSchema: { type: 'object' },
      permissionLevel: 'none', execute: eagerEffect }];
    const ownerHistory: Message[] = [];
    const saved: SDKAssistantMessage[] = [];
    const recorder = new AssistantHistoryRecorder(async frame => {
      if (frame.message.content.some(block => block.type === 'tool_use' && block.id === 'uncommitted')) {
        throw new Error('Injected second checkpoint failure');
      }
      saved.push(structuredClone(frame));
    }, message => ownerHistory.push(message));
    let requestCount = 0;
    const provider: LlmProvider = {
      id: 'checkpoint-fixture', name: 'Checkpoint fixture',
      capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
        pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      createMessage: async () => { throw new Error('Unexpected summary'); },
      async *createMessageStream(request) {
        requestCount++;
        yield { type: 'message_start', id: `response-${requestCount}`, model: request.model, usage: { input_tokens: 0, output_tokens: 0 } };
        if (requestCount === 1) yield* call(0, 'discover', 'ToolSearch', { query: `select:${target}` });
        else {
          yield* call(0, 'committed', 'CallTool', { tool: target, arguments: '{}' });
          await effectFinished; await tick();
          yield* call(1, 'uncommitted', failure === 'eager' ? 'EagerOperation' : 'CallTool',
            failure === 'eager' ? {} : { tool: target, arguments: failure === 'wrapped' ? '{}' : '{' });
        }
        yield { type: 'message_delta', stopReason: 'tool_use' };
        yield { type: 'message_stop' };
      },
    };
    const config = resolveQueryConfig({ cwd, env: { HOME: cwd, USERPROFILE: cwd }, model: 'fixture', tools: [], settingSources: [],
      systemPrompt: 'Complete the fixture.', permissionMode: 'bypassPermissions', maxTurns: 3,
      turnEndChecks: { openWork: false, completion: false },
      toolDiscovery: { services: { fixture: { identity: 'installation', loading: 'deferred' } } },
    });
    const events: SDKMessage[] = [];
    for await (const event of queryLoop(config, provider, tools, 'Write once.', {
      onContextMessage: message => { ownerHistory.push(message); },
      onAssistantBlock: (message, responseUuid) => recorder.recordBlock(message, responseUuid),
      onAssistantMessage: message => recorder.recordMessage(message),
      onToolResultMessage: message => { ownerHistory.push(message.message); },
    })) events.push(event);
    expect(events.at(-1)).toMatchObject({ is_error: true });
    expect(requestCount).toBe(2);
    expect(effect).toHaveBeenCalledOnce();
    expect(eagerEffect).not.toHaveBeenCalled();
    expect(saved.flatMap(frame => frame.message.content).filter(block => block.type === 'tool_use').map(block => block.id))
      .toEqual(['discover', 'committed']);
    const retained = ownerHistory.find(message => message.role === 'assistant' && Array.isArray(message.content) &&
      message.content.some(block => block.type === 'tool_use' && block.id === 'committed'))!;
    expect((retained.content as ContentBlock[]).filter(block => block.type === 'tool_use').map(block => block.id)).toEqual(['committed']);
    expect(retained.toolContext?.calls?.map(call => call.id)).toEqual(['committed']);
    expect(retained.toolContext?.directCalls ?? []).toEqual([]);
    expect(retained.toolContext?.rejectedCalls ?? []).toEqual([]);
    expect(() => readToolContextSnapshot(ownerHistory)).not.toThrow();
    expect(readToolContextSnapshot(ownerHistory)?.definitions.map(item => item.definition.name)).toEqual([target]);
    expect(ownerHistory.flatMap(message => Array.isArray(message.content) ? message.content : []))
      .toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'committed', content: 'Saved once.' }));
  });
});
