/**
 * Unit tests for message construction and extraction utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  buildUserMessage,
  buildToolResultMessage,
  extractToolUseBlocks,
  messageTokenEstimate,
  messagesToTokenCount,
  ensureToolResultPairing,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  TOOL_USE_INTERRUPTED_PLACEHOLDER,
  ORPHAN_TOOL_RESULT_REMOVED_PLACEHOLDER,
  NO_USER_CONTENT_PLACEHOLDER,
} from './messages.js';
import type {
  Message,
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
} from '../types/provider.js';

// ---------------------------------------------------------------------------
// buildUserMessage
// ---------------------------------------------------------------------------

describe('buildUserMessage', () => {
  it('wraps string content in a user message', () => {
    const msg = buildUserMessage('Hello');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hello');
  });

  it('wraps content block array in a user message', () => {
    const blocks = [{ type: 'text' as const, text: 'hi' }];
    const msg = buildUserMessage(blocks);
    expect(msg.role).toBe('user');
    expect(msg.content).toBe(blocks);
  });
});

// ---------------------------------------------------------------------------
// buildToolResultMessage
// ---------------------------------------------------------------------------

describe('buildToolResultMessage', () => {
  it('builds a user message with tool_result blocks', () => {
    const msg = buildToolResultMessage([
      { toolUseId: 'tu1', content: 'result text', isError: false },
    ]);
    expect(msg.role).toBe('user');
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('tu1');
    expect(blocks[0].content).toBe('result text');
    expect(blocks[0].is_error).toBeUndefined(); // false → omitted
  });

  it('sets is_error to true for error results', () => {
    const msg = buildToolResultMessage([
      { toolUseId: 'tu2', content: 'error text', isError: true },
    ]);
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks[0].is_error).toBe(true);
  });

  it('builds multiple tool result blocks', () => {
    const msg = buildToolResultMessage([
      { toolUseId: 'tu1', content: 'r1', isError: false },
      { toolUseId: 'tu2', content: 'r2', isError: false },
    ]);
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].tool_use_id).toBe('tu1');
    expect(blocks[1].tool_use_id).toBe('tu2');
  });
});

// ---------------------------------------------------------------------------
// extractToolUseBlocks
// ---------------------------------------------------------------------------

describe('extractToolUseBlocks', () => {
  it('returns empty array for string content', () => {
    const msg: Message = { role: 'assistant', content: 'just text' };
    expect(extractToolUseBlocks(msg)).toEqual([]);
  });

  it('returns empty array when no tool_use blocks', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'response' }],
    };
    expect(extractToolUseBlocks(msg)).toEqual([]);
  });

  it('extracts tool_use blocks from mixed content', () => {
    const toolBlock: ToolUseBlock = {
      type: 'tool_use',
      id: 'tu1',
      name: 'Bash',
      input: { command: 'ls' },
    };
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will run a command' },
        toolBlock,
      ],
    };
    const result = extractToolUseBlocks(msg);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Bash');
    expect(result[0].id).toBe('tu1');
  });

  it('extracts multiple tool_use blocks', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu1', name: 'Read', input: {} } as ToolUseBlock,
        { type: 'tool_use', id: 'tu2', name: 'Write', input: {} } as ToolUseBlock,
      ],
    };
    expect(extractToolUseBlocks(msg)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// messageTokenEstimate / messagesToTokenCount
// ---------------------------------------------------------------------------

describe('messageTokenEstimate', () => {
  it('returns a positive number for a text message', () => {
    const msg: Message = { role: 'user', content: 'Hello world, this is a test.' };
    expect(messageTokenEstimate(msg)).toBeGreaterThan(0);
  });

  it('returns a positive number for a block array message', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'A longer response with more tokens here.' }],
    };
    expect(messageTokenEstimate(msg)).toBeGreaterThan(0);
  });

  it('longer messages have higher token estimates', () => {
    const short: Message = { role: 'user', content: 'Hi' };
    const long: Message = { role: 'user', content: 'A'.repeat(10_000) };
    expect(messageTokenEstimate(long)).toBeGreaterThan(messageTokenEstimate(short));
  });
});

describe('messagesToTokenCount', () => {
  it('returns 0 for empty array', () => {
    expect(messagesToTokenCount([])).toBe(0);
  });

  it('returns sum of all message estimates', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'World' },
    ];
    const sum = msgs.reduce((acc, m) => acc + messageTokenEstimate(m), 0);
    expect(messagesToTokenCount(msgs)).toBe(sum);
  });
});

// ---------------------------------------------------------------------------
// ensureToolResultPairing
// ---------------------------------------------------------------------------

function asst(content: ContentBlock[] | string): Message {
  return { role: 'assistant', content };
}
function usr(content: ContentBlock[] | string): Message {
  return { role: 'user', content };
}
function toolUse(id: string, name = 'X'): ToolUseBlock {
  return { type: 'tool_use', id, name, input: {} };
}
function toolRes(id: string, text = 'ok'): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: id, content: text };
}

describe('ensureToolResultPairing', () => {
  it('passes pure text conversation through unchanged', () => {
    const messages: Message[] = [
      usr('hi'),
      asst('hello'),
      usr('again'),
    ];
    const out = ensureToolResultPairing(messages);
    expect(out).toEqual(messages);
  });

  it('preserves a properly paired tool_use/tool_result turn', () => {
    const tu = toolUse('t1');
    const tr = toolRes('t1');
    const messages: Message[] = [
      usr('run X'),
      asst([{ type: 'text', text: 'sure' }, tu]),
      usr([tr]),
      asst('done'),
    ];
    const out = ensureToolResultPairing(messages);
    expect(out).toEqual(messages);
  });

  it('inserts a synthetic error tool_result for a tool_use missing its pair', () => {
    const tu = toolUse('orphan-1');
    const messages: Message[] = [
      usr('go'),
      asst([tu]),
    ];
    const out = ensureToolResultPairing(messages);
    expect(out).toHaveLength(3);
    const synth = out[2];
    expect(synth.role).toBe('user');
    expect(Array.isArray(synth.content)).toBe(true);
    const block = (synth.content as ContentBlock[])[0] as ToolResultBlock;
    expect(block.type).toBe('tool_result');
    expect(block.tool_use_id).toBe('orphan-1');
    expect(block.is_error).toBe(true);
    expect(block.content).toBe(SYNTHETIC_TOOL_RESULT_PLACEHOLDER);
    expect(synth.isMeta).toBe(true);
  });

  it('patches the next user message when one tool_use is missing its result', () => {
    const tu1 = toolUse('a');
    const tu2 = toolUse('b');
    const tr2 = toolRes('b');
    const messages: Message[] = [
      asst([tu1, tu2]),
      usr([tr2]),
    ];
    const out = ensureToolResultPairing(messages);
    expect(out).toHaveLength(2);
    const userBlocks = out[1].content as ContentBlock[];
    // Synthetic for 'a' should be prepended; original 'b' result preserved.
    expect((userBlocks[0] as ToolResultBlock).tool_use_id).toBe('a');
    expect((userBlocks[0] as ToolResultBlock).is_error).toBe(true);
    expect((userBlocks[1] as ToolResultBlock).tool_use_id).toBe('b');
  });

  it('strips orphan tool_results referencing a non-existent tool_use', () => {
    const orphanTr = toolRes('ghost');
    const messages: Message[] = [
      asst([{ type: 'text', text: 'hi' }]),
      usr([orphanTr, { type: 'text', text: 'still here' }]),
    ];
    const out = ensureToolResultPairing(messages);
    const userBlocks = out[1].content as ContentBlock[];
    expect(userBlocks).toHaveLength(1);
    expect(userBlocks[0].type).toBe('text');
  });

  it('replaces an empty user slot with a placeholder to preserve role alternation', () => {
    const messages: Message[] = [
      asst([{ type: 'text', text: 'no tools' }]),
      usr([toolRes('ghost')]), // entirely orphans
      asst('next'),
    ];
    const out = ensureToolResultPairing(messages);
    expect(out).toHaveLength(3);
    expect(out[1].role).toBe('user');
    expect(out[1].content).toBe(NO_USER_CONTENT_PLACEHOLDER);
    expect(out[1].isMeta).toBe(true);
  });

  it('strips leading user(tool_result-only) message and replaces with placeholder text at index 0', () => {
    const messages: Message[] = [
      usr([toolRes('lost')]),
      asst('continuing'),
    ];
    const out = ensureToolResultPairing(messages);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('user');
    const blocks = out[0].content as ContentBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect((blocks[0] as { type: 'text'; text: string }).text).toBe(
      ORPHAN_TOOL_RESULT_REMOVED_PLACEHOLDER,
    );
  });

  it('drops a non-leading user(tool_result-only) message that has no preceding assistant', () => {
    // Two consecutive user messages — second's tool_results are orphans
    // because the prior emitted message is also user.
    const messages: Message[] = [
      usr('plain'),
      usr([toolRes('lost')]),
      asst('next'),
    ];
    const out = ensureToolResultPairing(messages);
    // Second message dropped entirely; prior emitted is also user → ok.
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe('plain');
    expect(out[1].role).toBe('assistant');
  });

  it('dedupes a tool_use ID appearing in two separate assistant messages', () => {
    const messages: Message[] = [
      asst([toolUse('dup')]),
      usr([toolRes('dup')]),
      asst([toolUse('dup'), { type: 'text', text: 'tail' }]),
    ];
    const out = ensureToolResultPairing(messages);
    // First assistant kept as-is.
    expect((out[0].content as ContentBlock[]).filter(
      (b) => b.type === 'tool_use',
    )).toHaveLength(1);
    // Second assistant: dup tool_use stripped, only text remains.
    const second = out[2].content as ContentBlock[];
    expect(second.filter((b) => b.type === 'tool_use')).toHaveLength(0);
    expect(second.some((b) => b.type === 'text')).toBe(true);
  });

  it('dedupes duplicate tool_result blocks in the same user message', () => {
    const messages: Message[] = [
      asst([toolUse('a')]),
      usr([toolRes('a', '1'), toolRes('a', '2')]),
    ];
    const out = ensureToolResultPairing(messages);
    const userBlocks = out[1].content as ContentBlock[];
    const trs = userBlocks.filter(
      (b): b is ToolResultBlock => b.type === 'tool_result',
    );
    expect(trs).toHaveLength(1);
    expect(trs[0].tool_use_id).toBe('a');
  });

  it('inserts a placeholder when assistant content empties out', () => {
    // Both tool_uses are duplicates of an earlier message → both stripped,
    // leaving an empty content array.
    const messages: Message[] = [
      asst([toolUse('x'), toolUse('y')]),
      usr([toolRes('x'), toolRes('y')]),
      asst([toolUse('x'), toolUse('y')]), // dup-only assistant
    ];
    const out = ensureToolResultPairing(messages);
    const last = out[out.length - 1];
    expect(last.role).toBe('assistant');
    const blocks = last.content as ContentBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect((blocks[0] as { type: 'text'; text: string }).text).toBe(
      TOOL_USE_INTERRUPTED_PLACEHOLDER,
    );
  });

  it('does not mutate the input array', () => {
    const tu = toolUse('a');
    const messages: Message[] = [asst([tu])];
    const before = JSON.stringify(messages);
    ensureToolResultPairing(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
