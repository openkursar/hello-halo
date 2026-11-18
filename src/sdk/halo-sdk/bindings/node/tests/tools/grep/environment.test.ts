import { afterEach, describe, expect, it } from 'vitest';
import { getAllTools, releaseNativeToolOwner } from '../../../native/tools.js';
import type { ToolContext } from '../../../types/tool.js';

afterEach(async () => { await releaseNativeToolOwner('grep-environment-test'); });
describe('Grep environment boundary', () => {
  it('does not mutate caller environment objects when overrides remove inherited variables', async () => {
    const env = Object.freeze({ AGENT_RIPGREP_PATH: undefined, PATH: '' });
    const before = process.env.PATH;
    const ctx: ToolContext = { cwd: process.cwd(), env, sessionId: 'grep-environment-test', currentTurn: 0,
      abortSignal: new AbortController().signal, costTracker: {} as ToolContext['costTracker'] };
    const result = await getAllTools().find(tool => tool.name === 'Grep')!.execute({ pattern: 'needle' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('session PATH');
    expect(result.content).toContain('ripgrep');
    expect(result.content).toContain('Glob');
    expect(result.content).not.toContain('brew install');
    expect(env).toEqual({ AGENT_RIPGREP_PATH: undefined, PATH: '' });
    expect(process.env.PATH).toBe(before);
  });
});
