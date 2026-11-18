import { describe, it, expect } from 'vitest';
import { getAllTools } from '../../../native/tools.js';

const todo = getAllTools().find(tool => tool.name === 'TodoWrite')!;

describe('TodoWrite metadata', () => {
  it('has the correct name', () => {
    expect(todo.name).toBe('TodoWrite');
  });
  it('has permissionLevel none', () => {
    expect(todo.permissionLevel).toBe('none');
  });
  it('has an inputSchema with required todos property', () => {
    const schema = todo.inputSchema as Record<string, unknown>;
    expect((schema.properties as Record<string, unknown>).todos).toBeDefined();
    expect((schema.required as string[]).includes('todos')).toBe(true);
  });
});
