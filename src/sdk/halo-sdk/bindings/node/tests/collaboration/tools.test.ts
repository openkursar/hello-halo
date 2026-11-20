import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collaborationText,
  COLLABORATION_TOOL_NAMES,
  createCollaborationServer,
  describeCollaborationTool,
  parseCollaborationInput,
} from '../../native/collaboration.js';
import { CollaborationRefusal } from '../../collaboration/errors.js';
import { bridgeSdkMcpTools } from '../../native/mcp-bridge.js';
import type { McpSdkServerConfigWithInstance } from '../../tools/mcp/sdk-server.js';
import type { ToolContext } from '../../types/tool.js';

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

  it('delivers a message carrying an unknown label without changing its receipt', async () => {
    const send = vi.fn(async () => collaborationText('Message delivered.'));
    const server = createCollaborationServer({ team_send: send });
    const result = await server.instance.callTool('team_send', { to: 'reviewer', message: 'Report back.', summary: 'Ask for report' });
    expect(send).toHaveBeenCalledWith({ to: 'reviewer', message: 'Report back.' }, {});
    expect(result).toEqual(collaborationText('Message delivered.'));
    expect(parseCollaborationInput('team_send', { to: 'reviewer', message: 'Report back.', summary: 'x' })).toEqual({ to: 'reviewer', message: 'Report back.' });
  });

  it('reaches the model through the SDK MCP bridge as one result', async () => {
    const server = createCollaborationServer({ team_send: async () => collaborationText('Message delivered.') });
    const [tool] = bridgeSdkMcpTools(server as McpSdkServerConfigWithInstance);
    const result = await tool.execute({ to: 'reviewer', message: 'Report back.', summary: 'x' }, { abortSignal: new AbortController().signal } as ToolContext);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('Message delivered.');
  });

  it('keeps the original refusal and host result when discarding a label', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = createCollaborationServer({ team_send: async () => { throw new CollaborationRefusal('unknown_recipient', 'No such recipient.'); } });
    const result = await refused.instance.callTool('team_send', { to: 'nobody', message: 'Hi', summary: 'x' });
    expect(result).toEqual(collaborationText('No such recipient.', true));
    const odd = { content: 'plain' } as never;
    const unusual = createCollaborationServer({ team_send: async () => odd });
    expect(await unusual.instance.callTool('team_send', { to: 'reviewer', message: 'Hi', summary: 'x' })).toBe(odd);
  });

  it('tolerates labels when creating a collaborator but refuses anything that might shape it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const receipt = JSON.stringify({ handle: 'member-1', name: 'reviewer', status: 'accepted' });
    const spawn = vi.fn(async () => collaborationText(receipt));
    const server = createCollaborationServer({ spawn_agent: spawn });
    const labelled = await server.instance.callTool('spawn_agent', { prompt: 'Review.', description: 'Review', title: 'Review' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith({ prompt: 'Review.' }, {});
    expect(labelled).toEqual(collaborationText(receipt));
    const shaped = await server.instance.callTool('spawn_agent', { prompt: 'Review.', description: 'Review', subagent_type: 'explore' });
    expect(shaped?.isError).toBe(true);
    expect(shaped?.content).toEqual([{ type: 'text', text: 'No collaborator was created. Unsupported argument: subagent_type. Accepted arguments: prompt, name, cwd, isolation.' }]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses undeclared arguments on recording tools instead of recording without them', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const update = vi.fn(async () => collaborationText('Task updated.'));
    const server = createCollaborationServer({ team_update_task: update });
    const refused = await server.instance.callTool('team_update_task', { taskId: 't1', status: 'done', summary: 'Verified both runs.' });
    expect(refused).toEqual(collaborationText('Nothing was recorded. Unsupported argument: summary. Accepted arguments: taskId, status, resultRef, note.', true));
    expect(update).not.toHaveBeenCalled();
    const input = { taskId: 't1', status: 'done', note: 'Verified both runs.' };
    expect(await server.instance.callTool('team_update_task', input)).toEqual(collaborationText('Task updated.'));
    expect(update).toHaveBeenCalledWith(input, {});
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

  it('returns known model-selection refusals and logs no host error object', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new Error('Profile changed; query the model catalog again.'), {
      code: 'MODEL_SELECTION', privateDetail: 'synthetic-private-canary',
    });
    const server = createCollaborationServer({ spawn_agent: async () => { throw error; } });
    expect(await server.instance.callTool('spawn_agent', { prompt: 'work' })).toEqual(
      collaborationText(error.message, true),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[Collaboration] Model selection rejected: stage=operation tool=spawn_agent');
    expect(errorLog).not.toHaveBeenCalled();
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
