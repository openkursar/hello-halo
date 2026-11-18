/**
 * Unit tests for model-quirks.ts
 *
 * Covers:
 * - Public model detection (isQuirkyModel)
 * - applyModelQuirks: <think> tag extraction, DeepSeek argument repair,
 *   missing tool IDs, empty content injection, stopReason fix
 * - applyStreamQuirks: passthrough contract
 */

import { describe, it, expect } from 'vitest';
import {
  isQuirkyModel,
  applyModelQuirks,
  applyStreamQuirks,
} from '../../index.js';
import type { ProviderResponse, ContentBlock, TextBlock, ThinkingBlock, ToolUseBlock } from '../../types/provider.js';

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
