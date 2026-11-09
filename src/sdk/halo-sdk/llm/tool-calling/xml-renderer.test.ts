/**
 * Tests for llm/tool-calling/xml-renderer.ts
 * @license MIT
 */

import { describe, it, expect } from 'vitest';
import { renderToolsBlock } from './xml-renderer.js';
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

describe('renderToolsBlock', () => {
  it('returns empty string for empty tools array', () => {
    expect(renderToolsBlock([])).toBe('');
  });

  it('includes tool name in header', () => {
    const result = renderToolsBlock([bashTool]);
    expect(result).toContain('## Bash');
  });

  it('includes tool description', () => {
    const result = renderToolsBlock([bashTool]);
    expect(result).toContain('Description: Execute a shell command.');
  });

  it('includes required parameters with (required) label', () => {
    const result = renderToolsBlock([bashTool]);
    expect(result).toContain('- command: (required)');
  });

  it('includes optional parameters with (optional) label', () => {
    const result = renderToolsBlock([bashTool]);
    expect(result).toContain('- timeout: (optional)');
    expect(result).toContain('- run_in_background: (optional)');
  });

  it('includes usage XML block with tool name', () => {
    const result = renderToolsBlock([bashTool]);
    expect(result).toContain('<Bash>');
    expect(result).toContain('</Bash>');
  });

  it('renders required params as BFCL <param> tags in usage', () => {
    const result = renderToolsBlock([bashTool]);
    // Required param command should appear as BFCL-style <param> tag
    expect(result).toContain('<param name="command" type="string" required="true">');
  });

  it('lists optional params in usage as a note line', () => {
    const result = renderToolsBlock([bashTool]);
    expect(result).toContain('(Optional parameters:');
    expect(result).toContain('timeout');
    expect(result).toContain('run_in_background');
    expect(result).toContain('omit unless needed');
  });

  it('renders enum constraints in parameter list', () => {
    const result = renderToolsBlock([enumTool]);
    expect(result).toContain('Allowed values:');
    expect(result).toContain('"content"');
    expect(result).toContain('"files_with_matches"');
    expect(result).toContain('"count"');
  });

  it('renders default values in parameter list', () => {
    const result = renderToolsBlock([bashTool]);
    expect(result).toContain('Default: 30000');
  });

  it('renders "Parameters: none" for tools with no parameters', () => {
    const result = renderToolsBlock([noParamsTool]);
    expect(result).toContain('Parameters: none');
  });

  it('renders multiple tools separated by ---', () => {
    const result = renderToolsBlock([bashTool, readTool]);
    expect(result).toContain('## Bash');
    expect(result).toContain('## Read');
    expect(result).toContain('---');
  });

  it('includes preamble instructions', () => {
    const result = renderToolsBlock([bashTool]);
    expect(result).toContain('tools are available for carrying out this task');
    expect(result).toContain('Only call one tool at a time');
    expect(result).toContain('tool call MUST be the last content');
    // Nested XML rules
    expect(result).toContain('Include ONLY required parameters');
    expect(result).toContain('Do NOT append empty tags');
    // CORRECT/INCORRECT example
    expect(result).toContain('Example of a CORRECT tool call');
    expect(result).toContain('INCORRECT');
    expect(result).toContain('<param name="description" type="string">List files</param>');
  });

  it('renders nested/complex tool description correctly', () => {
    const result = renderToolsBlock([readTool]);
    expect(result).toContain('## Read');
    expect(result).toContain('<param name="file_path"');
    expect(result).toContain('</Read>');
  });

  it('does not end with trailing --- separator', () => {
    const result = renderToolsBlock([bashTool]);
    expect(result.trimEnd()).not.toMatch(/---\s*$/);
  });
});
