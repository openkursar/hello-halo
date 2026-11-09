/**
 * Tests for llm/tool-calling/json-parser.ts
 * @license MIT
 */

import { describe, it, expect } from 'vitest';
import { parseJsonToolCalls } from './json-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'TodoWrite', 'Agent'];

// ---------------------------------------------------------------------------
// Basic parsing
// ---------------------------------------------------------------------------

describe('parseJsonToolCalls — basic', () => {
  it('returns empty toolCalls for plain text', () => {
    const result = parseJsonToolCalls('Just some text.', TOOLS);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.textContent).toBe('Just some text.');
  });

  it('returns empty toolCalls for empty string', () => {
    const result = parseJsonToolCalls('', TOOLS);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.textContent).toBe('');
  });

  it('returns empty toolCalls when knownToolNames is empty', () => {
    const text = '```json\n[{"name":"Bash","params":{"command":"ls"}}]\n```';
    const result = parseJsonToolCalls(text, []);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('parses a simple single-param tool call', () => {
    const text = '```json\n[{"name":"Bash","params":{"command":"ls -la"}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('Bash');
    expect(result.toolCalls[0].parameters.command).toBe('ls -la');
  });

  it('parses tool name correctly', () => {
    const text = '```json\n[{"name":"Read","params":{"file_path":"/tmp/foo.ts"}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls[0].name).toBe('Read');
  });

  it('returns textContent before the first code fence', () => {
    const text = 'I will read this file:\n\n```json\n[{"name":"Read","params":{"file_path":"/tmp/foo.ts"}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.textContent).toBe('I will read this file:');
    expect(result.toolCalls).toHaveLength(1);
  });

  it('returns empty textContent when code fence is first', () => {
    const text = '```json\n[{"name":"Bash","params":{"command":"ls"}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.textContent).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Parameter types
// ---------------------------------------------------------------------------

describe('parseJsonToolCalls — parameter types', () => {
  it('parses multiple parameters', () => {
    const text = '```json\n[{"name":"Read","params":{"file_path":"/tmp/foo.ts","offset":100,"limit":50}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    const params = result.toolCalls[0].parameters;
    expect(params.file_path).toBe('/tmp/foo.ts');
    expect(params.offset).toBe(100);
    expect(params.limit).toBe(50);
  });

  it('preserves boolean type', () => {
    const text = '```json\n[{"name":"Bash","params":{"command":"npm test","run_in_background":true}}]\n```';
    const result = parseJsonToolCalls(text, ['Bash']);
    expect(result.toolCalls[0].parameters.run_in_background).toBe(true);
  });

  it('preserves number type', () => {
    const text = '```json\n[{"name":"Read","params":{"file_path":"/tmp/x","limit":500}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls[0].parameters.limit).toBe(500);
  });

  it('parses JSON array parameter', () => {
    const text = '```json\n[{"name":"TodoWrite","params":{"todos":[{"content":"Fix","status":"in_progress","activeForm":"Fixing"}]}}]\n```';
    const result = parseJsonToolCalls(text, [...TOOLS, 'TodoWrite']);
    const todos = result.toolCalls[0].parameters.todos as unknown[];
    expect(Array.isArray(todos)).toBe(true);
    expect(todos).toHaveLength(1);
    expect((todos[0] as Record<string, unknown>).content).toBe('Fix');
  });

  it('handles empty string parameter', () => {
    const text = '```json\n[{"name":"Bash","params":{"command":""}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls[0].parameters.command).toBe('');
  });

  it('handles boolean false', () => {
    const text = '```json\n[{"name":"Bash","params":{"command":"ls","run_in_background":false}}]\n```';
    const result = parseJsonToolCalls(text, ['Bash']);
    expect(result.toolCalls[0].parameters.run_in_background).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multiple tool calls
// ---------------------------------------------------------------------------

describe('parseJsonToolCalls — multiple tool calls', () => {
  it('parses multiple tool calls in a single array', () => {
    const text = [
      '```json',
      '[',
      '  {"name":"Bash","params":{"command":"ls"}},',
      '  {"name":"Read","params":{"file_path":"/tmp/x"}}',
      ']',
      '```',
    ].join('\n');
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe('Bash');
    expect(result.toolCalls[1].name).toBe('Read');
  });

  it('returns tool calls in order of appearance in the array', () => {
    const text = '```json\n[{"name":"Read","params":{"file_path":"/a"}},{"name":"Bash","params":{"command":"ls"}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls[0].name).toBe('Read');
    expect(result.toolCalls[1].name).toBe('Bash');
  });

  it('uses the LAST code fence when multiple exist', () => {
    const text = [
      'Some reasoning...',
      '```json',
      '[{"name":"Bash","params":{"command":"wrong"}}]',
      '```',
      'Let me reconsider...',
      '```json',
      '[{"name":"Bash","params":{"command":"right"}}]',
      '```',
    ].join('\n');
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].parameters.command).toBe('right');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('parseJsonToolCalls — edge cases', () => {
  it('ignores unknown tool names', () => {
    const text = '```json\n[{"name":"UnknownTool","params":{"param":"val"}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('skips entries missing name field', () => {
    const text = '```json\n[{"params":{"command":"ls"}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('skips non-object array entries', () => {
    const text = '```json\n["string", 42, true, {"name":"Bash","params":{"command":"ls"}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('Bash');
  });

  it('treats non-array JSON as no tool calls', () => {
    const text = '```json\n{"name":"Bash","params":{"command":"ls"}}\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('handles invalid JSON gracefully', () => {
    const text = '```json\n[broken json content\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(0);
    // Parse failure returns full text as plain text response
    expect(result.textContent).toContain('[broken json content');
  });

  it('handles empty JSON array', () => {
    const text = '```json\n[]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('includes rawXml for debugging', () => {
    const text = '```json\n[{"name":"Bash","params":{"command":"ls"}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls[0].rawXml).toContain('"name"');
    expect(result.toolCalls[0].rawXml).toContain('"Bash"');
  });

  it('handles MCP tool names with __ (mcp__server__tool)', () => {
    const mcpTool = 'mcp__web-search__web_search';
    const text = '```json\n[{"name":"mcp__web-search__web_search","params":{"query":"hello world"}}]\n```';
    const result = parseJsonToolCalls(text, [mcpTool]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe(mcpTool);
    expect(result.toolCalls[0].parameters.query).toBe('hello world');
  });

  it('handles floating point numbers', () => {
    const text = '```json\n[{"name":"Bash","params":{"command":"x","timeout":1.5}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls[0].parameters.timeout).toBe(1.5);
  });

  it('handles negative numbers', () => {
    const text = '```json\n[{"name":"Read","params":{"file_path":"/x","offset":-1}}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls[0].parameters.offset).toBe(-1);
  });

  it('handles tool call with no params field', () => {
    const text = '```json\n[{"name":"Bash"}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('Bash');
    expect(result.toolCalls[0].parameters).toEqual({});
  });

  it('handles null params', () => {
    const text = '```json\n[{"name":"Bash","params":null}]\n```';
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].parameters).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Edit tool (multiline strings)
// ---------------------------------------------------------------------------

describe('parseJsonToolCalls — Edit tool multiline strings', () => {
  it('parses old_string and new_string with code content', () => {
    const text = [
      '```json',
      '[{',
      '  "name": "Edit",',
      '  "params": {',
      '    "file_path": "/src/foo.ts",',
      '    "old_string": "return foo() + 1;",',
      '    "new_string": "return foo() + 2;"',
      '  }',
      '}]',
      '```',
    ].join('\n');
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls[0].name).toBe('Edit');
    expect(result.toolCalls[0].parameters.old_string).toBe('return foo() + 1;');
    expect(result.toolCalls[0].parameters.new_string).toBe('return foo() + 2;');
  });

  it('handles multiline content with JSON-escaping', () => {
    const text = [
      '```json',
      '[{',
      '  "name": "Edit",',
      '  "params": {',
      '    "file_path": "/src/foo.ts",',
      '    "old_string": "line 1\\nline 2\\nline 3",',
      '    "new_string": "new content"',
      '  }',
      '}]',
      '```',
    ].join('\n');
    const result = parseJsonToolCalls(text, TOOLS);
    expect(result.toolCalls[0].parameters.old_string).toBe('line 1\nline 2\nline 3');
  });
});

// ---------------------------------------------------------------------------
// Unreadable blocks
// ---------------------------------------------------------------------------

describe('parseJsonToolCalls — reporting an unusable block', () => {
  it('reports a fence whose contents are not valid JSON', () => {
    const result = parseJsonToolCalls('```json\n[{"name": "Bash", "params": {\n```', ['Bash']);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.unreadable).toContain('not valid JSON');
  });

  it('reports a fence whose entries name no known tool', () => {
    const result = parseJsonToolCalls('```json\n[{"name": "Unknown", "params": {}}]\n```', ['Bash']);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.unreadable).toContain('no known tool');
  });

  it('keeps the original text so the model can see what it wrote', () => {
    const text = '```json\n[{"name": "Bash"\n```';
    expect(parseJsonToolCalls(text, ['Bash']).textContent).toBe(text);
  });

  it('says nothing when there was no attempt to call a tool', () => {
    expect(parseJsonToolCalls('just prose', ['Bash']).unreadable).toBeUndefined();
  });

  it('says nothing when the call parsed', () => {
    const result = parseJsonToolCalls('```json\n[{"name": "Bash", "params": {"command": "ls"}}]\n```', ['Bash']);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.unreadable).toBeUndefined();
  });
});
