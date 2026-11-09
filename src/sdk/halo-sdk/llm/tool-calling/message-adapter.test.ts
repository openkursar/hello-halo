/**
 * Tests for llm/tool-calling/message-adapter.ts
 * @license MIT
 */

import { describe, it, expect } from 'vitest';
import { convertMessagesToText, injectToolsIntoSystemPrompt } from './message-adapter.js';
import type { Message, SystemPromptBlock } from '../../types/provider.js';

// ---------------------------------------------------------------------------
// injectToolsIntoSystemPrompt
// ---------------------------------------------------------------------------

describe('injectToolsIntoSystemPrompt', () => {
  const BLOCK = 'Here are the tools.';

  it('appends to a string system prompt', () => {
    const result = injectToolsIntoSystemPrompt('You are helpful.', BLOCK);
    expect(result).toBe('You are helpful.\n\nHere are the tools.');
  });

  it('handles empty string system prompt', () => {
    const result = injectToolsIntoSystemPrompt('', BLOCK);
    expect(result).toBe('Here are the tools.');
  });

  it('returns just the tools block when systemPrompt is undefined', () => {
    const result = injectToolsIntoSystemPrompt(undefined, BLOCK);
    expect(result).toBe('Here are the tools.');
  });

  it('pushes a new text block to SystemPromptBlock[]', () => {
    const blocks: SystemPromptBlock[] = [{ type: 'text', text: 'You are helpful.' }];
    const result = injectToolsIntoSystemPrompt(blocks, BLOCK) as SystemPromptBlock[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[1].type).toBe('text');
    expect(result[1].text).toBe('Here are the tools.');
  });

  it('does not mutate the original blocks array', () => {
    const blocks: SystemPromptBlock[] = [{ type: 'text', text: 'original' }];
    injectToolsIntoSystemPrompt(blocks, BLOCK);
    expect(blocks).toHaveLength(1);
  });

  it('returns systemPrompt unchanged when toolsBlock is empty', () => {
    const result = injectToolsIntoSystemPrompt('You are helpful.', '');
    expect(result).toBe('You are helpful.');
  });
});

// ---------------------------------------------------------------------------
// convertMessagesToText — assistant messages
// ---------------------------------------------------------------------------

describe('convertMessagesToText — assistant ToolUseBlock conversion', () => {
  it('converts ToolUseBlock to XML text', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_001', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    ];
    const result = convertMessagesToText(messages);
    const msg = result[0];
    expect(typeof msg.content).toBe('string');
    expect(msg.content as string).toContain('<Bash>');
    expect(msg.content as string).toContain('<param name="command"');
    expect(msg.content as string).toContain('ls');
    expect(msg.content as string).toContain('</Bash>');
  });

  it('preserves TextBlock text in assistant message', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will now run ls:' },
          { type: 'tool_use', id: 'toolu_001', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    ];
    const result = convertMessagesToText(messages);
    expect(result[0].content as string).toContain('I will now run ls:');
    expect(result[0].content as string).toContain('<Bash>');
  });

  it('serializes object param as JSON in XML', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_001',
            name: 'TodoWrite',
            input: { todos: [{ content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing' }] },
          },
        ],
      },
    ];
    const result = convertMessagesToText(messages);
    expect(result[0].content as string).toContain('<param name="todos"');
    expect(result[0].content as string).toContain('"Fix bug"');
  });

  it('passes through string-content assistant message unchanged', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'Just text' },
    ];
    const result = convertMessagesToText(messages);
    expect(result[0].content).toBe('Just text');
  });
});

// ---------------------------------------------------------------------------
// convertMessagesToText — user messages (ToolResultBlock)
// ---------------------------------------------------------------------------

describe('convertMessagesToText — user ToolResultBlock conversion', () => {
  it('converts ToolResultBlock to [Tool Result: name] format', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_001', name: 'Bash', input: { command: 'ls' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_001', content: 'file1.ts\nfile2.ts', is_error: false },
        ],
      },
    ];
    const result = convertMessagesToText(messages);
    const userMsg = result[1].content as string;
    expect(userMsg).toContain('[Tool Result: Bash]');
    expect(userMsg).toContain('file1.ts');
  });

  it('converts error ToolResultBlock to [Tool Error: name] format', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_001', name: 'Bash', input: { command: 'bad' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_001', content: 'command not found', is_error: true },
        ],
      },
    ];
    const result = convertMessagesToText(messages);
    const userMsg = result[1].content as string;
    expect(userMsg).toContain('[Tool Error: Bash]');
    expect(userMsg).toContain('command not found');
  });

  it('uses tool_use_id as fallback when name cannot be found', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'result', is_error: false },
        ],
      },
    ];
    const result = convertMessagesToText(messages);
    const userMsg = result[0].content as string;
    expect(userMsg).toContain('[Tool Result: toolu_orphan]');
  });

  it('preserves TextBlock in user message', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_001', name: 'Bash', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please continue.' },
          { type: 'tool_result', tool_use_id: 'toolu_001', content: 'ok', is_error: false },
        ],
      },
    ];
    const result = convertMessagesToText(messages);
    expect(result[1].content as string).toContain('Please continue.');
    expect(result[1].content as string).toContain('[Tool Result: Bash]');
  });

  it('handles tool_result with ContentBlock[] content', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/x' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_001',
            content: [{ type: 'text', text: 'file contents here' }],
            is_error: false,
          },
        ],
      },
    ];
    const result = convertMessagesToText(messages);
    expect(result[1].content as string).toContain('file contents here');
  });

  it('retains tool-result images next to their text in prompt tool-calling mode', () => {
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'aGk=' } };
    const result = convertMessagesToText([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shot', content: [{ type: 'text', text: 'screenshot' }, image] }] }]);
    expect(result[0].content).toEqual([
      { type: 'text', text: '[Tool Result: shot]\nscreenshot' },
      image,
    ]);
  });
});

// ---------------------------------------------------------------------------
// convertMessagesToText — mixed conversation
// ---------------------------------------------------------------------------

describe('convertMessagesToText — mixed conversation history', () => {
  it('converts a full multi-turn conversation correctly', () => {
    const messages: Message[] = [
      { role: 'user', content: 'List files please.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will list files.' },
          { type: 'tool_use', id: 'toolu_001', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_001', content: 'foo.ts', is_error: false },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Done!' }] },
    ];

    const result = convertMessagesToText(messages);

    expect(result[0].content).toBe('List files please.');
    expect(result[1].content as string).toContain('<Bash>');
    expect(result[2].content as string).toContain('[Tool Result: Bash]');
    expect(result[3].content as string).toContain('Done!');
  });

  it('preserves isMeta flag on converted messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'ctx', isMeta: true },
    ];
    const result = convertMessagesToText(messages);
    expect(result[0].isMeta).toBe(true);
  });
});
