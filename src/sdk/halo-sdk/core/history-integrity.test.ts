import { describe, expect, it, vi } from 'vitest';
import type { ContentBlock, Message, ToolResultBlock } from '../types/provider.js';
import { ensureToolResultPairing } from './messages.js';

const call = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'Read', input: { file_path: '/example' } });
const reply = (id: string): ToolResultBlock => ({ type: 'tool_result', tool_use_id: id, content: `result ${id}` });

function expectSendable(history: Message[]): void {
  const uniqueCalls = new Set<string>();
  history.forEach((message, index) => {
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (message.role === 'assistant') {
      const ids = blocks.flatMap((block) => block.type === 'tool_use' ? [block.id] : []);
      ids.forEach((id) => {
        expect(uniqueCalls.has(id)).toBe(false);
        uniqueCalls.add(id);
      });
      if (ids.length === 0) return;
      const next = history[index + 1];
      expect(next?.role).toBe('user');
      const outputs = Array.isArray(next.content) ? next.content : [];
      const paired = outputs.flatMap((block) => block.type === 'tool_result' ? [block.tool_use_id] : []);
      expect(paired.sort()).toEqual(ids.sort());
    } else {
      const previous = history[index - 1];
      const available = previous?.role === 'assistant' && Array.isArray(previous.content)
        ? previous.content.flatMap((block) => block.type === 'tool_use' ? [block.id] : []) : [];
      blocks.forEach((block) => {
        if (block.type === 'tool_result') expect(available).toContain(block.tool_use_id);
      });
    }
  });
}

describe('history integrity at the provider boundary', () => {
  it('rejects orphan outputs after an assistant with string content', () => {
    const history: Message[] = [
      { role: 'assistant', content: 'No command was run.' },
      { role: 'user', content: [reply('never-started'), { type: 'text', text: 'Continue investigating.' }] },
    ];
    const fixed = ensureToolResultPairing(history);
    expectSendable(fixed);
    expect(fixed[1].content).toEqual([{ type: 'text', text: 'Continue investigating.' }]);
  });

  it('keeps valid messages and multimodal output by reference', () => {
    const history: Message[] = [
      { role: 'assistant', content: [call('image')] },
      { role: 'user', content: [{ ...reply('image'), content: [
        { type: 'text', text: 'image attached' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      ] }] },
    ];
    const fixed = ensureToolResultPairing(history);
    expect(fixed[0]).toBe(history[0]);
    expect(fixed[1]).toBe(history[1]);
    expectSendable(fixed);
  });

  it('repairs mixed interrupted transcripts without mutation and is idempotent', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let seed = 0; seed < 64; seed++) {
        const history: Message[] = [
          { role: 'user', content: [reply('unrecorded'), { type: 'text', text: 'task' }] },
          { role: 'assistant', content: [call('one'), ...(seed & 1 ? [call('one')] : []), call('two')] },
          { role: 'user', content: [reply('one'), ...(seed & 2 ? [reply('two')] : []), ...(seed & 4 ? [reply('one')] : [])] },
          { role: 'assistant', content: [call('three'), ...(seed & 8 ? [call('one')] : [])] },
          ...(seed & 16 ? [{ role: 'user' as const, content: [reply('unknown')] }] : []),
          ...(seed & 32 ? [{ role: 'assistant' as const, content: 'Continue.' }] : []),
        ];
        const before = JSON.stringify(history);
        history.forEach((message) => {
          if (Array.isArray(message.content)) {
            message.content.forEach(Object.freeze);
            Object.freeze(message.content);
          }
          Object.freeze(message);
        });
        Object.freeze(history);
        const fixed = ensureToolResultPairing(history);
        expectSendable(fixed);
        expect(JSON.stringify(history)).toBe(before);
        expect(ensureToolResultPairing(fixed)).toEqual(fixed);
      }
    } finally {
      warning.mockRestore();
    }
  });
});
