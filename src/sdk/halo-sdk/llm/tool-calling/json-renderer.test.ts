/**
 * Tests for llm/tool-calling/json-renderer.ts
 * @license MIT
 */

import { describe, it, expect } from 'vitest';
import { renderJsonToolsBlock } from './json-renderer.js';
import type { ToolDefinition } from '../../types/provider.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const bashTool: ToolDefinition = {
  name: 'Bash',
  description: 'Execute a shell command.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run' },
      timeout: { type: 'number', description: 'Timeout in ms', default: 30000 },
      run_in_background: { type: 'boolean', description: 'Run in background' },
    },
    required: ['command'],
  },
};

const readTool: ToolDefinition = {
  name: 'Read',
  description: 'Read a file.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to file' },
      limit: { type: 'number', description: 'Max lines to read' },
    },
    required: ['file_path'],
  },
};

const noParamsTool: ToolDefinition = {
  name: 'ListTodos',
  description: 'List all open todos.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

const enumTool: ToolDefinition = {
  name: 'AskUserQuestion',
  description: 'Ask the user a question.',
  input_schema: {
    type: 'object',
    properties: {
      output_mode: {
        type: 'string',
        description: 'Output mode',
        enum: ['content', 'files_with_matches', 'count'],
        default: 'files_with_matches',
      },
    },
    required: [],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderJsonToolsBlock', () => {
  it('returns empty string for empty tools array', () => {
    expect(renderJsonToolsBlock([])).toBe('');
  });

  it('includes tool name in header', () => {
    const result = renderJsonToolsBlock([bashTool]);
    expect(result).toContain('## Bash');
  });

  it('includes tool description', () => {
    const result = renderJsonToolsBlock([bashTool]);
    expect(result).toContain('Description: Execute a shell command.');
  });

  it('includes required parameters with (required) label', () => {
    const result = renderJsonToolsBlock([bashTool]);
    expect(result).toContain('- command: (required)');
  });

  it('includes optional parameters with (optional) label', () => {
    const result = renderJsonToolsBlock([bashTool]);
    expect(result).toContain('- timeout: (optional)');
    expect(result).toContain('- run_in_background: (optional)');
  });

  it('includes JSON usage with tool name', () => {
    const result = renderJsonToolsBlock([bashTool]);
    expect(result).toContain('"name": "Bash"');
  });

  it('renders JSON usage with proper type placeholders', () => {
    const result = renderJsonToolsBlock([bashTool]);
    // command → string, timeout → number
    expect(result).toContain('"command": "value"');
  });

  it('lists optional params in usage as a note line', () => {
    const result = renderJsonToolsBlock([bashTool]);
    expect(result).toContain('(Optional parameters:');
    expect(result).toContain('timeout');
    expect(result).toContain('run_in_background');
    expect(result).toContain('omit unless needed');
  });

  it('renders enum constraints in parameter list', () => {
    const result = renderJsonToolsBlock([enumTool]);
    expect(result).toContain('Allowed values:');
    expect(result).toContain('"content"');
    expect(result).toContain('"files_with_matches"');
    expect(result).toContain('"count"');
  });

  it('renders default values in parameter list', () => {
    const result = renderJsonToolsBlock([bashTool]);
    expect(result).toContain('Default: 30000');
  });

  it('renders "Parameters: none" for tools with no parameters', () => {
    const result = renderJsonToolsBlock([noParamsTool]);
    expect(result).toContain('Parameters: none');
  });

  it('renders multiple tools separated by ---', () => {
    const result = renderJsonToolsBlock([bashTool, readTool]);
    expect(result).toContain('## Bash');
    expect(result).toContain('## Read');
    expect(result).toContain('---');
  });

  it('includes JSON format preamble', () => {
    const result = renderJsonToolsBlock([bashTool]);
    expect(result).toContain('json code block');
    expect(result).toContain('```json');
    expect(result).toContain('[{"name": "tool_name"');
  });

  it('includes rules section with key constraints', () => {
    const result = renderJsonToolsBlock([bashTool]);
    expect(result).toContain('Include ONLY required parameters');
    expect(result).toContain('Boolean parameters');
    expect(result).toContain('Do NOT write anything after');
  });

  it('includes CORRECT example', () => {
    const result = renderJsonToolsBlock([bashTool]);
    expect(result).toContain('Example of a CORRECT tool call');
    expect(result).toContain('{"name": "Bash", "params": {"command": "ls"}}');
  });

  it('includes INCORRECT example showing mistakes', () => {
    const result = renderJsonToolsBlock([bashTool]);
    expect(result).toContain('INCORRECT');
    expect(result).toContain('"description": "list"');
    expect(result).toContain('nothing after the closing');
  });

  it('renders nested/complex tool correctly', () => {
    const result = renderJsonToolsBlock([readTool]);
    expect(result).toContain('## Read');
    expect(result).toContain('"name": "Read"');
    expect(result).toContain('"file_path": "value"');
  });

  it('does not end with trailing --- separator', () => {
    const result = renderJsonToolsBlock([bashTool]);
    expect(result.trimEnd()).not.toMatch(/---\s*$/);
  });
});
