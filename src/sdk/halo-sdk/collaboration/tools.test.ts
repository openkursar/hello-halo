import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collaborationText,
  COLLABORATION_TOOL_NAMES,
  createCollaborationServer,
  describeCollaborationTool,
  parseCollaborationInput,
} from './index.js';
import { bridgeSdkMcpTools } from '../tools/mcp/bridge.js';
import type { McpSdkServerConfigWithInstance } from '../tools/mcp/sdk-server.js';
import type { ToolContext } from '../types/tool.js';

afterEach(() => vi.restoreAllMocks());

describe('collaboration tool contract', () => {
  it('offers no organization, wait, completion or model-selection decision', () => {
    expect(COLLABORATION_TOOL_NAMES).toEqual([
      'spawn_agent', 'team_send', 'team_read_board', 'team_read_member',
      'team_post_finding', 'team_read_artifact', 'team_post_task', 'team_update_task', 'team_stop',
    ]);
    const schema = describeCollaborationTool('spawn_agent').inputSchema;
    expect(schema.required).toEqual(['prompt']);
    expect(Object.keys(schema.properties as object)).toEqual(['prompt', 'name', 'cwd', 'isolation']);
  });

  it('registers only granted operations and does not discover or create a scope while listing', async () => {
    const read = vi.fn(async () => collaborationText('board'));
    const server = createCollaborationServer({ team_read_board: read });
    expect(server.instance.listTools().map(tool => tool.name)).toEqual(['team_read_board']);
    expect(read).not.toHaveBeenCalled();
    expect(await server.instance.callTool('spawn_agent', { prompt: 'work' })).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects caller-selected authority, scope and model before invoking the host', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawn = vi.fn(async () => collaborationText('member'));
    const server = createCollaborationServer({ spawn_agent: spawn });
    for (const field of ['team_id', 'new_team', 'goal', 'model', 'caller', 'permissions']) {
      const result = await server.instance.callTool('spawn_agent', { prompt: 'work', [field]: 'override' });
      expect(result?.isError).toBe(true);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('requires a real assignment without forcing labels or a role form', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawn = vi.fn(async () => collaborationText('member'));
    const server = createCollaborationServer({ spawn_agent: spawn });
    for (const prompt of [undefined, null, 1, '', '   ']) {
      expect((await server.instance.callTool('spawn_agent', { prompt }))?.isError).toBe(true);
    }
    expect(spawn).not.toHaveBeenCalled();
    const prompt = 'Inspect the module.\nReturn evidence; do not edit.';
    expect(await server.instance.callTool('spawn_agent', { prompt })).toEqual(collaborationText('member'));
    expect(spawn).toHaveBeenCalledWith({ prompt }, {});
  });

  it('does not mutate or silently discard meaningful arguments', () => {
    const input = Object.freeze({ to: 'researcher', message: '  preserve these details\n' });
    const parsed = parseCollaborationInput('team_send', input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(() => parseCollaborationInput('team_read_member', { member: 'reader', before: 0 })).toThrow('before');
    expect(() => parseCollaborationInput('team_read_member', { member: 'reader', before: 1.5 })).toThrow('before');
    expect(() => parseCollaborationInput('team_update_task', { taskId: 'task', status: 'finished' })).toThrow('status');
  });

  it('preserves optional workspace isolation while refusing contradictory placement', () => {
    expect(parseCollaborationInput('spawn_agent', { prompt: 'work', isolation: 'worktree' })).toEqual({ prompt: 'work', isolation: 'worktree' });
    expect(() => parseCollaborationInput('spawn_agent', { prompt: 'work', cwd: '/project', isolation: 'worktree' })).toThrow('cannot be combined');
  });

  it('requires actual shared content and distinguishes publication from messaging', () => {
    expect(() => parseCollaborationInput('team_post_finding', {})).toThrow('content or ref');
    expect(parseCollaborationInput('team_post_finding', { ref: 'report.md' })).toEqual({ ref: 'report.md' });
    expect(describeCollaborationTool('team_post_finding').description).toContain('does not notify');
    expect(describeCollaborationTool('team_post_task').description).toContain('does not notify');
  });

  it('does not execute a cancelled call and forwards a live cancellation signal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    const send = vi.fn(async () => collaborationText('accepted'));
    const server = createCollaborationServer({ team_send: send });
    await server.instance.callTool('team_send', { to: 'member', message: 'work' }, { signal: controller.signal });
    expect(send).toHaveBeenCalledWith({ to: 'member', message: 'work' }, { signal: controller.signal });
    controller.abort();
    expect((await server.instance.callTool('team_send', { to: 'member', message: 'too late' }, { signal: controller.signal }))?.isError).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not promise rollback or replay after an uncertain host failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = createCollaborationServer({ spawn_agent: async () => { throw new Error('private host detail'); } });
    const result = await server.instance.callTool('spawn_agent', { prompt: 'work' });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('may already have occurred');
    expect(result?.content[0].text).not.toContain('private host detail');
  });

  it('uses the existing SDK MCP bridge without a second tool implementation', async () => {
    const calls: string[] = [];
    const server = createCollaborationServer({ team_send: async input => { calls.push(input.message); return collaborationText('accepted'); } });
    const bridged = bridgeSdkMcpTools(server as McpSdkServerConfigWithInstance);
    expect(bridged.map(tool => tool.name)).toEqual(['mcp__halo-team__team_send']);
    expect(bridged[0].isConcurrencySafe?.()).toBe(false);
    const result = await bridged[0].execute({ to: 'member', message: 'investigate' }, {
      abortSignal: new AbortController().signal,
    } as ToolContext);
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual(['investigate']);
  });

  it('returns independent descriptors so consumers cannot rewrite subsequent schemas', () => {
    const server = createCollaborationServer({ team_read_board: async () => collaborationText('board') });
    const first = server.instance.listTools();
    first[0].inputSchema.additionalProperties = true;
    first[0].annotations.readOnlyHint = false;
    const next = server.instance.listTools();
    expect(next[0].inputSchema.additionalProperties).toBe(false);
    expect(next[0].annotations.readOnlyHint).toBe(true);
  });
});
