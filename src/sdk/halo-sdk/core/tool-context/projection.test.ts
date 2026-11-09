import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/provider.js';
import { TokenBudget } from '../token-budget.js';
import { createToolContextProjector } from './history.js';

describe('model-history projection', () => {
  it('lets token budgeting reuse old discovery content when the next step only appends', () => {
    let reads = 0;
    const message: Message = { role: 'user', toolContext: { version: 1, discoveries: [] }, content: [{
      type: 'tool_result', tool_use_id: 'search', get content() { reads++; return 'definition '.repeat(2000); },
    }] };
    const project = createToolContextProjector();
    const budget = new TokenBudget(200000);
    const first = budget.estimateRequest({ messages: project([message]) });
    const initiallyRead = reads;
    expect(initiallyRead).toBeGreaterThan(0);
    const next = budget.estimateRequest({ messages: project([message, { role: 'user', content: 'Continue.' }]) });
    expect(next).toBeGreaterThan(first);
    expect(reads).toBe(initiallyRead);
  });

  it('reprojects changed content or origin metadata without retaining obsolete wrappers', () => {
    const message: Message = { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'actual', input: { value: 1 } }],
      toolContext: { version: 1, calls: [{ id: 'call', definitionVersion: 'version', input: { tool: 'actual', arguments: '{ "value": 1 }' } }] } };
    const project = createToolContextProjector();
    const original = project([message])[0];
    expect(original).not.toHaveProperty('toolContext');
    message.content = [{ type: 'text', text: 'Replaced history.' }];
    expect(project([message])[0]).not.toBe(original);
    expect(project([message])[0].content).toEqual(message.content);
    const withUndefined: Message = { role: 'user', content: 'Visible.', toolContext: undefined };
    expect(project([withUndefined])[0]).not.toHaveProperty('toolContext');
  });
});
