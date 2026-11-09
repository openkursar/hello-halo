/**
 * Unit tests for model-quirks.ts
 *
 * Covers:
 * - Model detection helpers (isQuirkyModel, isXmlThinkModel, isOSeriesModel)
 * - applyModelQuirks: <think> tag extraction, DeepSeek argument repair,
 *   missing tool IDs, empty content injection, stopReason fix
 * - ThinkTagParser: streaming <think> tags across chunk boundaries
 * - applyStreamQuirks: passthrough contract
 */

import { describe, it, expect } from 'vitest';
import {
  isQuirkyModel,
  isXmlThinkModel,
  isOSeriesModel,
  applyModelQuirks,
  applyStreamQuirks,
  ThinkTagParser,
} from './model-quirks.js';
import type { ProviderResponse, ContentBlock, TextBlock, ThinkingBlock, ToolUseBlock } from '../types/provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextBlock(text: string): TextBlock {
  return { type: 'text', text };
}

function makeToolUseBlock(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

function makeThinkingBlock(thinking: string): ThinkingBlock {
  return { type: 'thinking', thinking };
}

function makeResponse(
  content: ContentBlock[],
  stopReason: string = 'end_turn',
): ProviderResponse {
  return {
    content,
    stopReason: stopReason as ProviderResponse['stopReason'],
    usage: { input_tokens: 10, output_tokens: 5 },
    id: 'test-id',
    model: 'test-model',
  };
}

// ---------------------------------------------------------------------------
// Model detection
// ---------------------------------------------------------------------------

describe('isQuirkyModel', () => {
  it('returns true for qwen prefix (any case)', () => {
    expect(isQuirkyModel('qwen-7b')).toBe(true);
    expect(isQuirkyModel('Qwen2-72B')).toBe(true);
    expect(isQuirkyModel('QWEN-MAX')).toBe(true);
  });

  it('returns true for deepseek prefix', () => {
    expect(isQuirkyModel('deepseek-v3')).toBe(true);
    expect(isQuirkyModel('DeepSeek-R1')).toBe(true);
  });

  it('returns true for glm prefix', () => {
    expect(isQuirkyModel('glm-4')).toBe(true);
    expect(isQuirkyModel('GLM-4-Think')).toBe(true);
    expect(isQuirkyModel('glm-z1')).toBe(true);
  });

  it('returns true for kimi / moonshot prefix', () => {
    expect(isQuirkyModel('kimi-latest')).toBe(true);
    expect(isQuirkyModel('moonshot-v1-128k')).toBe(true);
    expect(isQuirkyModel('Moonshot-V1-8K')).toBe(true);
  });

  it('returns true for minimax / abab prefix', () => {
    expect(isQuirkyModel('minimax-text-01')).toBe(true);
    expect(isQuirkyModel('MiniMax-01')).toBe(true);
    expect(isQuirkyModel('abab6.5s-chat')).toBe(true);
  });

  it('returns false for other models', () => {
    expect(isQuirkyModel('gpt-4o')).toBe(false);
    expect(isQuirkyModel('claude-opus-4')).toBe(false);
    expect(isQuirkyModel('llama-3.1-70b')).toBe(false);
    expect(isQuirkyModel('gemini-pro')).toBe(false);
  });
});

describe('isXmlThinkModel', () => {
  it('returns true for qwen models', () => {
    expect(isXmlThinkModel('qwen-qwq-32b')).toBe(true);
    expect(isXmlThinkModel('Qwen3-235B')).toBe(true);
  });

  it('returns true for glm think models', () => {
    expect(isXmlThinkModel('glm-4-think')).toBe(true);
    expect(isXmlThinkModel('GLM-Z1-32B')).toBe(true);
    expect(isXmlThinkModel('glm-z1-flash')).toBe(true);
  });

  it('returns false for deepseek (uses reasoning_content field, not <think> tags)', () => {
    expect(isXmlThinkModel('deepseek-r1')).toBe(false);
  });

  it('returns false for non-think models', () => {
    expect(isXmlThinkModel('gpt-4o')).toBe(false);
    expect(isXmlThinkModel('claude-sonnet')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyModelQuirks — <think> tag extraction
// ---------------------------------------------------------------------------

describe('applyModelQuirks — <think> tag extraction (Qwen/GLM)', () => {
  const MODELS = ['qwen-7b', 'qwen2-72b-instruct', 'glm-4-think', 'glm-z1-32b'];

  for (const model of MODELS) {
    describe(`model=${model}`, () => {
      it('extracts single <think> block from text', () => {
        const content: ContentBlock[] = [
          makeTextBlock('<think>chain of thought</think>The answer is 42.'),
        ];
        const result = applyModelQuirks(model, makeResponse(content));
        expect(result.content).toHaveLength(2);
        expect(result.content[0]).toMatchObject({ type: 'thinking', thinking: 'chain of thought' });
        expect(result.content[1]).toMatchObject({ type: 'text', text: 'The answer is 42.' });
      });

      it('handles text with no <think> tags unchanged', () => {
        const content: ContentBlock[] = [makeTextBlock('Just a plain response.')];
        const result = applyModelQuirks(model, makeResponse(content));
        expect(result.content).toHaveLength(1);
        expect(result.content[0]).toMatchObject({ type: 'text', text: 'Just a plain response.' });
      });

      it('handles multiple <think> blocks in one TextBlock', () => {
        const content: ContentBlock[] = [
          makeTextBlock('<think>first thought</think>text<think>second thought</think>more'),
        ];
        const result = applyModelQuirks(model, makeResponse(content));
        // Should have 2 ThinkingBlocks + 1 TextBlock
        const thinking = result.content.filter((b) => b.type === 'thinking');
        const text = result.content.filter((b) => b.type === 'text');
        expect(thinking).toHaveLength(2);
        expect(text).toHaveLength(1);
      });

      it('does not duplicate tool_use blocks', () => {
        const content: ContentBlock[] = [
          makeTextBlock('<think>thinking</think>'),
          makeToolUseBlock('toolu_1', 'bash', { command: 'ls' }),
        ];
        const result = applyModelQuirks(model, makeResponse(content, 'tool_use'));
        const toolUse = result.content.filter((b) => b.type === 'tool_use');
        expect(toolUse).toHaveLength(1);
      });

      it('strips <think>-only text block entirely (no empty text emitted)', () => {
        const content: ContentBlock[] = [
          makeTextBlock('<think>chain of thought</think>'),
        ];
        const result = applyModelQuirks(model, makeResponse(content));
        const textBlocks = result.content.filter((b) => b.type === 'text');
        // Empty text block should be omitted
        expect(textBlocks).toHaveLength(0);
      });
    });
  }

  it('does NOT apply <think> extraction to deepseek', () => {
    const content: ContentBlock[] = [
      makeTextBlock('<think>This should stay as text for deepseek</think>answer'),
    ];
    const result = applyModelQuirks('deepseek-r1', makeResponse(content));
    // DeepSeek uses reasoning_content field in stream, not <think> tags in response
    const textBlocks = result.content.filter((b) => b.type === 'text');
    expect(textBlocks.some((b) => (b as TextBlock).text.includes('<think>'))).toBe(true);
  });

  it('does NOT apply <think> extraction to unknown models', () => {
    const content: ContentBlock[] = [makeTextBlock('<think>should stay</think>answer')];
    const result = applyModelQuirks('gpt-4o', makeResponse(content));
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as TextBlock).text).toContain('<think>');
  });
});

// ---------------------------------------------------------------------------
// applyModelQuirks — generic fixes
// ---------------------------------------------------------------------------

describe('applyModelQuirks — missing tool IDs', () => {
  it('generates toolu_ IDs for tool_use blocks with empty id', () => {
    const content: ContentBlock[] = [
      makeToolUseBlock('', 'read', { path: '/etc/hosts' }),
    ];
    const result = applyModelQuirks('gpt-4o', makeResponse(content, 'tool_use'));
    const toolBlock = result.content.find((b) => b.type === 'tool_use') as ToolUseBlock;
    expect(toolBlock.id).toMatch(/^toolu_/);
    expect(toolBlock.id.length).toBeGreaterThan(6);
  });

  it('preserves existing valid tool IDs', () => {
    const content: ContentBlock[] = [
      makeToolUseBlock('toolu_abc123', 'bash', { command: 'pwd' }),
    ];
    const result = applyModelQuirks('gpt-4o', makeResponse(content, 'tool_use'));
    const toolBlock = result.content.find((b) => b.type === 'tool_use') as ToolUseBlock;
    expect(toolBlock.id).toBe('toolu_abc123');
  });
});

describe('applyModelQuirks — empty content injection', () => {
  it('injects empty TextBlock when tool_use is present but no text', () => {
    const content: ContentBlock[] = [
      makeToolUseBlock('toolu_1', 'bash', { command: 'ls' }),
    ];
    const result = applyModelQuirks('gpt-4o', makeResponse(content, 'tool_use'));
    const firstBlock = result.content[0];
    expect(firstBlock.type).toBe('text');
    expect((firstBlock as TextBlock).text).toBe('');
  });

  it('does not inject empty TextBlock when text already exists', () => {
    const content: ContentBlock[] = [
      makeTextBlock('Let me check'),
      makeToolUseBlock('toolu_1', 'bash', { command: 'ls' }),
    ];
    const result = applyModelQuirks('gpt-4o', makeResponse(content, 'tool_use'));
    const textBlocks = result.content.filter((b) => b.type === 'text');
    expect(textBlocks).toHaveLength(1);
    expect((textBlocks[0] as TextBlock).text).toBe('Let me check');
  });
});

describe('applyModelQuirks — stopReason correction', () => {
  it('changes end_turn to tool_use when tool_use blocks are present', () => {
    const content: ContentBlock[] = [
      makeTextBlock('Let me use a tool.'),
      makeToolUseBlock('toolu_1', 'bash', { command: 'ls' }),
    ];
    const result = applyModelQuirks('gpt-4o', makeResponse(content, 'end_turn'));
    expect(result.stopReason).toBe('tool_use');
  });

  it('keeps end_turn when no tool_use blocks', () => {
    const content: ContentBlock[] = [makeTextBlock('Done.')];
    const result = applyModelQuirks('gpt-4o', makeResponse(content, 'end_turn'));
    expect(result.stopReason).toBe('end_turn');
  });

  it('keeps existing tool_use stopReason unchanged', () => {
    const content: ContentBlock[] = [
      makeToolUseBlock('toolu_1', 'bash', { command: 'ls' }),
    ];
    const result = applyModelQuirks('gpt-4o', makeResponse(content, 'tool_use'));
    expect(result.stopReason).toBe('tool_use');
  });
});

describe('applyModelQuirks — DeepSeek argument repair', () => {
  it('parses stringified JSON input when present', () => {
    const brokenTool: ToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'bash',
      input: JSON.parse('{}') as Record<string, unknown>, // empty from malformed parse
    };
    // Simulate the string form that DeepSeek sometimes emits
    (brokenTool as unknown as Record<string, unknown>).input = '{"command": "ls"}';
    const content: ContentBlock[] = [brokenTool];
    const result = applyModelQuirks('deepseek-v3', makeResponse(content, 'tool_use'));
    const toolBlock = result.content.find((b) => b.type === 'tool_use') as ToolUseBlock;
    expect(toolBlock.input).toMatchObject({ command: 'ls' });
  });

  it('does not modify already-valid object inputs', () => {
    const content: ContentBlock[] = [
      makeToolUseBlock('toolu_1', 'bash', { command: 'ls', cwd: '/tmp' }),
    ];
    const result = applyModelQuirks('deepseek-chat', makeResponse(content, 'tool_use'));
    const toolBlock = result.content.find((b) => b.type === 'tool_use') as ToolUseBlock;
    expect(toolBlock.input).toMatchObject({ command: 'ls', cwd: '/tmp' });
  });
});

// ---------------------------------------------------------------------------
// ThinkTagParser — streaming
// ---------------------------------------------------------------------------

describe('ThinkTagParser', () => {
  it.each([
    ['前文<think>想一想</think>\r\n正文<think>再想</think>结尾', '前文正文结尾', '想一想再想'],
    ['<think></think>正文', '正文', ''],
    ['<think>未闭合</thi', '', '未闭合</thi'],
    ['正文<thi', '正文<thi', ''],
    ['<THINK>literal</THINK>', '<THINK>literal</THINK>', ''],
    ['<thinX>literal<think>reason</thinx>still</think>answer', '<thinX>literalanswer', 'reason</thinx>still'],
    ['', '', ''],
  ])('routes every chunk boundary consistently for %s', (input, text, reasoning) => {
    const parse = (chunks: string[]) => {
      const parser = new ThinkTagParser();
      const events = chunks.flatMap((chunk) => parser.process(chunk, 0));
      events.push(...parser.flush(0));
      expect(parser.flush(0)).toEqual([]);
      return {
        text: events.flatMap((event) => event.type === 'text_delta' ? [event.text] : []).join(''),
        reasoning: events.flatMap((event) => event.type === 'reasoning_delta' ? [event.reasoning] : []).join(''),
      };
    };
    expect(parse([input])).toEqual({ text, reasoning });
    expect(parse([...input])).toEqual({ text, reasoning });
    for (let boundary = 0; boundary <= input.length; boundary++) {
      expect(parse([input.slice(0, boundary), input.slice(boundary)])).toEqual({ text, reasoning });
    }
  });

  it('emits text_delta for plain text (no think tags)', () => {
    const parser = new ThinkTagParser();
    const events = parser.process('Hello world', 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'text_delta', text: 'Hello world', index: 0 });
  });

  it('emits reasoning_delta for content inside <think>', () => {
    const parser = new ThinkTagParser();
    const events = parser.process('<think>chain of thought</think>', 0);
    // Should produce reasoning_delta for the thinking content, no text_delta
    const reasoning = events.filter((e) => e.type === 'reasoning_delta');
    const text = events.filter((e) => e.type === 'text_delta');
    expect(reasoning.length).toBeGreaterThan(0);
    expect(text).toHaveLength(0);
  });

  it('splits text before and after <think> tag', () => {
    const parser = new ThinkTagParser();
    const events = parser.process('Prefix<think>thought</think>Suffix', 0);
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    const reasoningDeltas = events.filter((e) => e.type === 'reasoning_delta');
    expect(textDeltas.some((e) => e.type === 'text_delta' && (e as { text: string }).text.includes('Prefix'))).toBe(true);
    expect(reasoningDeltas.some((e) => e.type === 'reasoning_delta' && (e as { reasoning: string }).reasoning.includes('thought'))).toBe(true);
    expect(textDeltas.some((e) => e.type === 'text_delta' && (e as { text: string }).text.includes('Suffix'))).toBe(true);
  });

  it('correctly routes content when tags arrive in whole chunks', () => {
    const parser = new ThinkTagParser();

    // Opening tag arrives as a complete chunk
    const events1 = parser.process('<think>', 0);
    expect(parser.isInsideThinkTag).toBe(true);

    const events2 = parser.process('thinking content', 0);
    const events3 = parser.process('</think>answer', 0);

    const allEvents = [...events1, ...events2, ...events3];
    const reasoning = allEvents.filter((e) => e.type === 'reasoning_delta');
    const text = allEvents.filter((e) => e.type === 'text_delta');
    expect(reasoning.some((e) => (e as { reasoning: string }).reasoning.includes('thinking content'))).toBe(true);
    expect(text.some((e) => (e as { text: string }).text.includes('answer'))).toBe(true);
  });

  it('handles content before and after tags in same chunk', () => {
    const parser = new ThinkTagParser();

    // All in one chunk — most common case in practice
    const events = parser.process('<think>deep thought</think>clear answer', 0);

    const reasoning = events.filter((e) => e.type === 'reasoning_delta');
    const text = events.filter((e) => e.type === 'text_delta');
    expect(reasoning.some((e) => (e as { reasoning: string }).reasoning.includes('deep thought'))).toBe(true);
    expect(text.some((e) => (e as { text: string }).text.includes('clear answer'))).toBe(true);
    expect(parser.isInsideThinkTag).toBe(false);
  });

  it('tracks isInsideThinkTag state correctly', () => {
    const parser = new ThinkTagParser();
    expect(parser.isInsideThinkTag).toBe(false);

    parser.process('<think>', 0);
    expect(parser.isInsideThinkTag).toBe(true);

    parser.process('</think>', 0);
    expect(parser.isInsideThinkTag).toBe(false);
  });

  it('accumulates partial <think> tag text as text_delta until tag is complete', () => {
    const parser = new ThinkTagParser();
    // The '<' doesn't constitute a complete tag — it may be emitted as text or buffered
    // The key invariant: nothing inside <think>...</think> appears as text_delta
    parser.process('<think>reasoning</think>', 0);
    expect(parser.isInsideThinkTag).toBe(false);

    // Everything between the tags is reasoning, not text
    const events = parser.process('<think>only reasoning</think>', 0);
    const textWithThinkContent = events
      .filter((e) => e.type === 'text_delta')
      .some((e) => (e as { text: string }).text.includes('only reasoning'));
    expect(textWithThinkContent).toBe(false);
  });

  it('handles empty <think></think> blocks gracefully', () => {
    const parser = new ThinkTagParser();
    const events = parser.process('<think></think>response', 0);
    // Should not throw; should emit 'response' as text_delta
    const textEvents = events.filter((e) => e.type === 'text_delta');
    expect(textEvents.some((e) => (e as { text: string }).text.includes('response'))).toBe(true);
  });

  it('uses provided content-block index', () => {
    const parser = new ThinkTagParser();
    const events = parser.process('hello', 3);
    expect(events.every((e) => (e as { index: number }).index === 3)).toBe(true);
  });

  it('handles multiple consecutive chunks correctly', () => {
    const parser = new ThinkTagParser();
    const chunks = ['<think>', 'deep thinking ', 'here', '</think>', 'final answer'];
    const allEvents = chunks.flatMap((c) => parser.process(c, 0));

    const reasoning = allEvents
      .filter((e) => e.type === 'reasoning_delta')
      .map((e) => (e as { reasoning: string }).reasoning)
      .join('');
    const text = allEvents
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as { text: string }).text)
      .join('');

    expect(reasoning).toContain('deep thinking here');
    expect(text).toContain('final answer');
  });
});

// ---------------------------------------------------------------------------
// applyStreamQuirks — passthrough contract
// ---------------------------------------------------------------------------

describe('applyStreamQuirks', () => {
  it('returns the event unchanged (passthrough)', () => {
    const event = { type: 'text_delta' as const, index: 0, text: 'hello' };
    const result = applyStreamQuirks('qwen-7b', event);
    expect(result).toBe(event); // same reference
  });

  it('works for any model without throwing', () => {
    const event = { type: 'message_stop' as const };
    expect(() => applyStreamQuirks('glm-4-think', event)).not.toThrow();
    expect(() => applyStreamQuirks('deepseek-r1', event)).not.toThrow();
    expect(() => applyStreamQuirks('gpt-4o', event)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isOSeriesModel — OpenAI reasoning model detection
// ---------------------------------------------------------------------------

describe('isOSeriesModel', () => {
  it('detects o1 family', () => {
    expect(isOSeriesModel('o1')).toBe(true);
    expect(isOSeriesModel('o1-mini')).toBe(true);
    expect(isOSeriesModel('o1-preview')).toBe(true);
  });

  it('detects o3 family', () => {
    expect(isOSeriesModel('o3')).toBe(true);
    expect(isOSeriesModel('o3-mini')).toBe(true);
  });

  it('detects o4 family', () => {
    expect(isOSeriesModel('o4-mini')).toBe(true);
    expect(isOSeriesModel('o4')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isOSeriesModel('O1')).toBe(true);
    expect(isOSeriesModel('O3-MINI')).toBe(true);
    expect(isOSeriesModel('O4-Mini')).toBe(true);
  });

  it('handles provider-prefixed names (e.g. openai/o3-mini)', () => {
    expect(isOSeriesModel('openai/o3-mini')).toBe(true);
    expect(isOSeriesModel('openai/o1')).toBe(true);
    expect(isOSeriesModel('openrouter/openai/o4-mini')).toBe(true);
  });

  it('rejects non-o-series models', () => {
    expect(isOSeriesModel('gpt-4o')).toBe(false);
    expect(isOSeriesModel('gpt-4o-mini')).toBe(false);
    expect(isOSeriesModel('claude-sonnet-4-6')).toBe(false);
    expect(isOSeriesModel('qwen-7b')).toBe(false);
    expect(isOSeriesModel('deepseek-r1')).toBe(false);
  });

  it('does not match models that merely contain "o1" mid-name', () => {
    // "tools" or "qwen-2.5-plus-o1" should not match o1
    expect(isOSeriesModel('qwen-2.5-plus-o1')).toBe(false);
  });
});
