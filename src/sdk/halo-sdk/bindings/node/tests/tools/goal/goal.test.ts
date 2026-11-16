import { describe, it, expect } from 'vitest';
import { getAllTools } from '../../../native/tools.js';

const goal = getAllTools().find(tool => tool.name === 'Goal')!;

describe('Goal metadata', () => {
  it('is named Goal and needs no permission', () => {
    expect(goal.name).toBe('Goal');
    expect(goal.permissionLevel).toBe('none');
  });
  it('describes when to use it with examples', () => {
    expect(goal.description).toContain('When to use it');
    expect(goal.description).toContain('<example>');
  });
});
