/**
 * Tests for llm/tool-calling/xml-parser.ts
 * @license MIT
 */

import { describe, it, expect } from 'vitest';
import { parseXmlToolCalls } from './xml-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'TodoWrite', 'Agent'];

// ---------------------------------------------------------------------------
// Basic parsing
// ---------------------------------------------------------------------------

describe('parseXmlToolCalls — basic', () => {
  it('returns empty toolCalls for plain text', () => {
    const result = parseXmlToolCalls('Just some text.', TOOLS);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.textContent).toBe('Just some text.');
  });

  it('returns empty toolCalls for empty string', () => {
    const result = parseXmlToolCalls('', TOOLS);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.textContent).toBe('');
  });

  it('returns empty toolCalls when knownToolNames is empty', () => {
    const result = parseXmlToolCalls('<Bash><command>ls</command></Bash>', []);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('parses a simple single-param tool call', () => {
    const text = '<Bash>\n<command>ls -la</command>\n</Bash>';
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('Bash');
    expect(result.toolCalls[0].parameters.command).toBe('ls -la');
  });

  it('parses tool name correctly', () => {
    const text = '<Read>\n<file_path>/tmp/foo.ts</file_path>\n</Read>';
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.toolCalls[0].name).toBe('Read');
  });

  it('returns textContent before the first tool call', () => {
    const text = 'I will read this file:\n\n<Read>\n<file_path>/tmp/foo.ts</file_path>\n</Read>';
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.textContent).toBe('I will read this file:');
    expect(result.toolCalls).toHaveLength(1);
  });

  it('returns empty textContent when tool call is first', () => {
    const text = '<Bash>\n<command>ls</command>\n</Bash>';
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.textContent).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Multi-param and types
// ---------------------------------------------------------------------------

describe('parseXmlToolCalls — parameter types', () => {
  it('parses multiple parameters', () => {
    const text = '<Read>\n<file_path>/tmp/foo.ts</file_path>\n<offset>100</offset>\n<limit>50</limit>\n</Read>';
    const result = parseXmlToolCalls(text, TOOLS);
    const params = result.toolCalls[0].parameters;
    expect(params.file_path).toBe('/tmp/foo.ts');
    expect(params.offset).toBe(100);
    expect(params.limit).toBe(50);
  });

  it('coerces boolean "true" / "false" strings', () => {
    const text = '<Bash>\n<command>npm test</command>\n<run_in_background>true</run_in_background>\n</Bash>';
    const result = parseXmlToolCalls(text, ['Bash']);
    expect(result.toolCalls[0].parameters.run_in_background).toBe(true);
  });

  it('coerces numeric string to number', () => {
    const text = '<Read>\n<file_path>/tmp/x</file_path>\n<limit>500</limit>\n</Read>';
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.toolCalls[0].parameters.limit).toBe(500);
  });

  it('parses JSON array parameter', () => {
    const text = '<TodoWrite>\n<todos>[{"content":"Fix","status":"in_progress","activeForm":"Fixing"}]</todos>\n</TodoWrite>';
    const result = parseXmlToolCalls(text, [...TOOLS, 'TodoWrite']);
    const todos = result.toolCalls[0].parameters.todos as unknown[];
    expect(Array.isArray(todos)).toBe(true);
    expect(todos).toHaveLength(1);
    expect((todos[0] as Record<string, unknown>).content).toBe('Fix');
  });

  it('parses JSON object parameter', () => {
    const text = '<Agent>\n<prompt>Explore codebase</prompt>\n</Agent>';
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.toolCalls[0].parameters.prompt).toBe('Explore codebase');
  });

  it('handles empty parameter tags', () => {
    const text = '<Bash>\n<command></command>\n</Bash>';
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.toolCalls[0].parameters.command).toBe('');
  });

  it('handles multi-line parameter content', () => {
    const content = 'line 1\nline 2\nline 3';
    const text = `<Write>\n<file_path>/tmp/x.ts</file_path>\n<content>${content}</content>\n</Write>`;
    const result = parseXmlToolCalls(text, TOOLS);
    const raw = result.toolCalls[0].parameters.content as string;
    expect(raw).toContain('line 1');
    expect(raw).toContain('line 2');
  });
});

// ---------------------------------------------------------------------------
// Multiple tool calls
// ---------------------------------------------------------------------------

describe('parseXmlToolCalls — multiple tool calls', () => {
  it('parses multiple consecutive tool calls', () => {
    const text = [
      '<Bash>\n<command>ls</command>\n</Bash>',
      '\n\n',
      '<Read>\n<file_path>/tmp/x</file_path>\n</Read>',
    ].join('');
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe('Bash');
    expect(result.toolCalls[1].name).toBe('Read');
  });

  it('returns tool calls in order of appearance', () => {
    const text = '<Read>\n<file_path>/a</file_path>\n</Read>\n<Bash>\n<command>ls</command>\n</Bash>';
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.toolCalls[0].name).toBe('Read');
    expect(result.toolCalls[1].name).toBe('Bash');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('parseXmlToolCalls — edge cases', () => {
  it('ignores unknown tool names', () => {
    const text = '<UnknownTool>\n<param>val</param>\n</UnknownTool>';
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.textContent).toContain('<UnknownTool>');
  });

  it('ignores unknown parameters (does not filter them)', () => {
    const text = '<Bash>\n<command>ls</command>\n<unknown_param>val</unknown_param>\n</Bash>';
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.toolCalls[0].parameters.unknown_param).toBe('val');
  });

  it('handles tool name case sensitivity — names are exact', () => {
    // Tool names are case-sensitive identifiers
    const result = parseXmlToolCalls('<bash>\n<command>ls</command>\n</bash>', ['Bash']);
    // 'bash' (lowercase) is not in TOOLS which has 'Bash'
    expect(result.toolCalls).toHaveLength(0);
  });

  it('includes rawXml in ParsedToolCall', () => {
    const text = '<Bash>\n<command>ls</command>\n</Bash>';
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.toolCalls[0].rawXml).toContain('<Bash>');
    expect(result.toolCalls[0].rawXml).toContain('</Bash>');
  });

  it('handles MCP tool names with __ (mcp__server__tool)', () => {
    const mcpTool = 'mcp__web-search__web_search';
    const text = `<${mcpTool}>\n<query>hello world</query>\n</${mcpTool}>`;
    const result = parseXmlToolCalls(text, [mcpTool]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe(mcpTool);
    expect(result.toolCalls[0].parameters.query).toBe('hello world');
  });

  it('handles floating point numbers', () => {
    const text = '<Bash>\n<command>x</command>\n<timeout>1.5</timeout>\n</Bash>';
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.toolCalls[0].parameters.timeout).toBe(1.5);
  });

  it('handles negative numbers', () => {
    const text = '<Read>\n<file_path>/x</file_path>\n<offset>-1</offset>\n</Read>';
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.toolCalls[0].parameters.offset).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Edit tool (multiline old_string / new_string)
// ---------------------------------------------------------------------------

describe('parseXmlToolCalls — Edit tool multiline strings', () => {
  it('parses old_string and new_string with code content', () => {
    const text = [
      '<Edit>',
      '<file_path>/src/foo.ts</file_path>',
      '<old_string>return foo() + 1;</old_string>',
      '<new_string>return foo() + 2;</new_string>',
      '</Edit>',
    ].join('\n');
    const result = parseXmlToolCalls(text, TOOLS);
    expect(result.toolCalls[0].name).toBe('Edit');
    expect(result.toolCalls[0].parameters.old_string).toBe('return foo() + 1;');
    expect(result.toolCalls[0].parameters.new_string).toBe('return foo() + 2;');
  });
});
