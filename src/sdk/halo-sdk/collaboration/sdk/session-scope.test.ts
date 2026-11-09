import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSdkCollaboration, type SdkCollaborationBinding } from './index.js';
import { setup } from '../../worker/fixtures/setup.mjs';
import { shellStateManager } from '../../tools/bash/shell-state.js';
import type { Options } from '../../types/config.js';
import type { Tool } from '../../types/tool.js';

let directory: string;
const bindings: SdkCollaborationBinding[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sdk-collaboration-scope-')); });
afterEach(async () => {
  await Promise.all(bindings.splice(0).map(binding => binding.close()));
  await rm(directory, { recursive: true, force: true });
});

async function fixture(label: string, extra: Partial<Options> = {}, data = {}) {
  const base = await setup({ model: label, cwd: directory, persistSession: false, settingSources: [],
    env: { HOME: directory, CLAUDE_CONFIG_DIR: directory }, permissionMode: 'bypassPermissions',
    turnEndChecks: { openWork: false, completion: false }, ...extra }, data);
  const notices: string[] = [];
  const binding = createSdkCollaboration({ sessionId: randomUUID(), getOptions: () => base,
    settings: { maxIdleSessions: 0 }, deliverToSource: async envelope => { notices.push(envelope.body); return 'buffered'; } });
  bindings.push(binding);
  return { binding, notices };
}

async function settled(binding: SdkCollaborationBinding): Promise<void> {
  while (binding.activeCount) await binding.waitForChange(binding.revision);
}

describe('collaboration owner isolation', () => {
  it('keeps same-named collaborators, model configuration and reports in their originating scopes', async () => {
    const a = await fixture('first-model');
    const b = await fixture('second-model');
    await Promise.all([
      a.binding.server.instance.callTool('spawn_agent', { name: 'worker', prompt: 'FIRST_PRIVATE_ASSIGNMENT' }),
      b.binding.server.instance.callTool('spawn_agent', { name: 'worker', prompt: 'SECOND_PRIVATE_ASSIGNMENT' }),
    ]);
    await Promise.all([settled(a.binding), settled(b.binding)]);
    expect(a.notices.join('\n')).toContain('first-model');
    expect(a.notices.join('\n')).toContain('FIRST_PRIVATE_ASSIGNMENT');
    expect(a.notices.join('\n')).not.toContain('SECOND_PRIVATE_ASSIGNMENT');
    expect(b.notices.join('\n')).toContain('second-model');
    expect(b.notices.join('\n')).not.toContain('FIRST_PRIVATE_ASSIGNMENT');
    expect((await a.binding.server.instance.callTool('team_read_member', { member: 'worker' }))!.content[0].text).not.toContain('SECOND_PRIVATE_ASSIGNMENT');
    await a.binding.close();
    expect((await b.binding.server.instance.callTool('spawn_agent', { prompt: 'Continue in the surviving scope.' }))?.isError).not.toBe(true);
    await settled(b.binding);
    expect(b.binding.retainedCount).toBe(2);
  });

  it('cannot read, message or stop a collaborator from another scope by its identifier', async () => {
    const a = await fixture('first', {}, { collaboratorTools: [{ name: 'mcp__halo-team__team_post_finding', input: { content: 'FIRST_SHARED_EVIDENCE' } }] });
    const b = await fixture('second');
    await a.binding.server.instance.callTool('spawn_agent', { prompt: 'Publish the evidence.' });
    await settled(a.binding);
    const board = JSON.parse((await a.binding.server.instance.callTool('team_read_board', {}))!.content[0].text);
    const member = board.findings[0].authorAppId;
    for (const [name, input] of [
      ['team_read_member', { member }],
      ['team_send', { to: member, message: 'Must not arrive.' }],
      ['team_stop', { to: member }],
    ] as const) expect((await b.binding.server.instance.callTool(name, input))?.isError).toBe(true);
    expect(JSON.stringify(await b.binding.server.instance.callTool('team_read_board', {}))).not.toContain('FIRST_SHARED_EVIDENCE');
    expect(a.binding.activeCount).toBe(0);
  });

  it('inherits host hooks and reclaims each collaborator shell state at retirement', async () => {
    const baseline = shellStateManager.size;
    const contexts = new Set<string>();
    const execute = vi.fn(async (_input, context) => {
      const state = shellStateManager.get(context.sessionId, context.cwd);
      expect(state.envVars.has('OTHER_MEMBER')).toBe(false);
      state.envVars.set('OTHER_MEMBER', context.sessionId);
      contexts.add(context.sessionId);
      return { content: 'done' };
    });
    const hook = vi.fn(async () => ({}));
    const probe: Tool = { name: 'Probe', description: 'Check session ownership.', inputSchema: { type: 'object' }, permissionLevel: 'none', execute };
    const { binding } = await fixture('fixture', { customTools: [probe],
      hooks: { PreToolUse: [{ matcher: 'Probe', hooks: [hook] }] } }, { collaboratorTools: [{ name: 'Probe', input: {} }] });
    for (let index = 0; index < 4; index++) {
      const next = await fixture(`fixture-${index}`, { customTools: [probe], hooks: { PreToolUse: [{ matcher: 'Probe', hooks: [hook] }] } },
        { collaboratorTools: [{ name: 'Probe', input: {} }] });
      await next.binding.server.instance.callTool('spawn_agent', { prompt: 'Check isolation.' });
      await settled(next.binding);
      expect(shellStateManager.size).toBe(baseline);
    }
    await binding.server.instance.callTool('spawn_agent', { prompt: 'Check the original scope.' });
    await settled(binding);
    expect(contexts.size).toBe(5);
    expect(execute).toHaveBeenCalledTimes(5);
    expect(hook).toHaveBeenCalledTimes(5);
    await Promise.all(bindings.map(host => host.close()));
    expect(shellStateManager.size).toBe(baseline);
  });
});
