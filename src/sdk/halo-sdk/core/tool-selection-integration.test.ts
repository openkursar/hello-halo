import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query, createSession, createSdkMcpServer, tool as mcpTool } from '../index.js';
import type { Options, LlmProvider, ProviderRequest, StreamEvent, Tool, SDKMessage } from '../index.js';
import { setup as fixtureSetup } from '../worker/fixtures/setup.mjs';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sdk-tool-selection-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function providerFor(calls: Array<{ name: string; input?: Record<string, unknown> }> = []) {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'fixture', name: 'Fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const pending = requests.length ? [] : calls;
      requests.push(request);
      const usage = { input_tokens: 10, output_tokens: 10 };
      yield { type: 'message_start', id: `message-${requests.length}`, model: request.model, usage };
      if (pending.length) {
        for (const [index, call] of pending.entries()) {
          yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${index}`, name: call.name, input: call.input ?? {} } };
          yield { type: 'content_block_stop', index };
        }
      } else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Done.' } };
        yield { type: 'content_block_stop', index: 0 };
      }
      yield { type: 'message_delta', stopReason: pending.length ? 'tool_use' : 'end_turn', usage };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests };
}

function options(extra: Partial<Options> = {}): Options {
  return { model: 'fixture', cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: directory },
    systemPrompt: 'Fixture.', persistSession: false, settingSources: [], tools: [],
    turnEndChecks: { openWork: false, completion: false }, ...extra };
}
function custom(name: string, execute = vi.fn(async () => ({ content: 'Executed.', isError: false }))): Tool {
  return { name, description: name, inputSchema: { type: 'object' }, permissionLevel: 'none', execute };
}
async function run(mode: 'query' | 'session', extra: Partial<Options>, calls: Array<{ name: string; input?: Record<string, unknown> }> = []) {
  const { provider, requests } = providerFor(calls);
  const messages: SDKMessage[] = [];
  if (mode === 'query') {
    for await (const message of query({ prompt: 'Do the work.', options: options({ ...extra, provider }) })) messages.push(message);
  } else {
    const session = await createSession(options({ ...extra, provider }));
    try {
      await session.send('Do the work.');
      for await (const message of session.stream()) messages.push(message);
    } finally { session.close(); await session.flush(); }
  }
  return { messages, requests };
}

for (const mode of ['query', 'session'] as const) describe(`${mode} tool composition`, () => {
  it('respects an empty built-in list and does not enable unconfigured CodeSearch', async () => {
    expect((await run(mode, {})).requests[0].tools).toEqual([]);
    expect((await run(mode, { tools: ['CodeSearch'] })).requests[0].tools).toEqual([]);
  });

  it('keeps custom overrides and applies the blacklist after custom and SDK MCP composition', async () => {
    const server = createSdkMcpServer({ name: 'fixture', version: '1', tools: [mcpTool('hidden', 'Hidden fixture', {}, async () => ({ content: [] }))] });
    const { requests } = await run(mode, { tools: ['Read', 'Grep'], customTools: [custom('Read'), custom('Blocked')],
      mcpServers: { fixture: server }, disallowedTools: ['Blocked', 'mcp__fixture__hidden'] });
    expect(requests[0].tools?.map(tool => tool.name)).toEqual(['Grep', 'Read']);
  });

  it('uses allowedTools only for approval and still checks other visible tools', async () => {
    const allowed = custom('Allowed');
    const guarded = custom('Guarded');
    const permission = vi.fn(async () => ({ behavior: 'deny' as const, message: 'Not approved.' }));
    const { requests } = await run(mode, { customTools: [allowed, guarded], allowedTools: ['Allowed'], canUseTool: permission },
      [{ name: 'Allowed' }, { name: 'Guarded' }]);
    expect(requests[0].tools?.map(tool => tool.name)).toEqual(['Allowed', 'Guarded']);
    expect(allowed.execute).toHaveBeenCalledOnce();
    expect(guarded.execute).not.toHaveBeenCalled();
    expect(permission).toHaveBeenCalledOnce();
    expect(permission.mock.calls[0][0]).toBe('Guarded');
  });

  it('does not treat a conditional Bash read approval as approval to write', async () => {
    const bash = custom('Bash');
    const permission = vi.fn(async () => ({ behavior: 'deny' as const, message: 'This write was not approved.' }));
    await run(mode, { customTools: [bash], allowedTools: ['Bash(git status:*)'], canUseTool: permission },
      [{ name: 'Bash', input: { command: 'printf changed > protected.txt' } }]);
    expect(permission).toHaveBeenCalledOnce();
    expect(bash.execute).not.toHaveBeenCalled();
  });

  it('requires a host checker for conditional rules unless explicit bypass or bare approval is present', async () => {
    const bash = custom('Bash');
    const call = [{ name: 'Bash', input: { command: 'printf changed > protected.txt' } }];
    await run(mode, { customTools: [bash], allowedTools: ['Bash(git status:*)'] }, call);
    expect(bash.execute).not.toHaveBeenCalled();
    await run(mode, { customTools: [bash], allowedTools: ['Bash'] }, call);
    expect(bash.execute).toHaveBeenCalledTimes(1);
    await run(mode, { customTools: [bash], allowedTools: ['Bash(git status:*)'], permissionMode: 'bypassPermissions' }, call);
    expect(bash.execute).toHaveBeenCalledTimes(2);
  });
});

describe('dynamic MCP blacklist', () => {
  it('does not reintroduce a denied tool after reconnecting a one-shot query server', async () => {
    const marker = join(directory, 'executed');
    const script = join(directory, 'mcp.cjs');
    await writeFile(script, `const {createInterface}=require('node:readline');
      createInterface({input:process.stdin}).on('line',line=>{
        const request=JSON.parse(line); if(request.id===undefined)return;
        let result={};
        if(request.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
        if(request.method==='tools/list')result={tools:[{name:'hidden',description:'Hidden',inputSchema:{type:'object',properties:{}}}]};
        if(request.method==='tools/call'){require('node:fs').writeFileSync(process.argv[2],'executed');result={content:[{type:'text',text:'Executed.'}]};}
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
      });`);
    const { provider } = providerFor([{ name: 'mcp__fixture__hidden' }]);
    const current = query({ prompt: 'Try the fixture.', options: options({ provider,
      mcpServers: { fixture: { type: 'stdio', command: process.execPath, args: [script, marker] } },
      disallowedTools: ['mcp__fixture__hidden'], permissionMode: 'bypassPermissions',
    }) });
    const messages: SDKMessage[] = [];
    try {
      for await (const message of current) {
        messages.push(message);
        if (message.type === 'system' && message.subtype === 'init') await current.reconnectMcpServer('fixture');
      }
    } finally { current.close(); await current.return(undefined); }
    expect(JSON.stringify(messages)).toContain('not found');
    await expect(access(marker)).rejects.toThrow();
  });
});

describe('collaborator tool and approval boundaries', () => {
  it('inherits the host checker without turning visibility or a conditional rule into approval', async () => {
    const bash = custom('Bash');
    const permission = vi.fn(async () => ({ behavior: 'deny' as const, message: 'Guest cannot write.' }));
    const configured = await fixtureSetup(options({
      tools: ['spawn_agent'], customTools: [bash], allowedTools: ['mcp__halo-team__spawn_agent', 'Bash(git status:*)'], canUseTool: permission,
    }), {
      tools: [{ name: 'mcp__halo-team__spawn_agent', input: { prompt: 'Inspect only.' } }],
      collaboratorTools: [{ name: 'Bash', input: { command: 'printf unsafe > protected.txt' } }],
    });
    const requests: ProviderRequest[] = [];
    const stream = configured.provider.createMessageStream.bind(configured.provider);
    configured.provider.createMessageStream = async function* (request: ProviderRequest) { requests.push(request); yield* stream(request); };
    for await (const message of query({ prompt: 'Delegate inspection.', options: configured })) void message;
    const collaborator = requests.find(request => JSON.stringify(request.systemPrompt).includes('You are collaborator'))!;
    expect(collaborator).toBeDefined();
    expect(collaborator.model).toBe('fixture');
    expect(collaborator.tools?.map(tool => tool.name)).toContain('Bash');
    expect(collaborator.tools?.map(tool => tool.name)).not.toContain('Goal');
    expect(permission).toHaveBeenCalledOnce();
    expect(permission.mock.calls[0][0]).toBe('Bash');
    expect(bash.execute).not.toHaveBeenCalled();
  });

  it('retains the host blacklist even when a collaborator requests a hidden write tool', async () => {
    const write = custom('Write');
    const configured = await fixtureSetup(options({ tools: ['spawn_agent'], customTools: [custom('Read'), write, custom('CodeSearch')],
      disallowedTools: ['Write', 'CodeSearch'], permissionMode: 'bypassPermissions' }), {
      tools: [{ name: 'mcp__halo-team__spawn_agent', input: { prompt: 'Inspect only.' } }],
      collaboratorTools: [{ name: 'Write', input: {} }],
    });
    const requests: ProviderRequest[] = [];
    const stream = configured.provider.createMessageStream.bind(configured.provider);
    configured.provider.createMessageStream = async function* (request: ProviderRequest) { requests.push(request); yield* stream(request); };
    for await (const _message of query({ prompt: 'Delegate exploration.', options: configured })) { /* consume */ }
    const collaborators = requests.filter(request => JSON.stringify(request.systemPrompt).includes('You are collaborator'));
    expect(collaborators.length).toBeGreaterThan(1);
    expect(collaborators[0].tools?.map(tool => tool.name)).toContain('Read');
    expect(collaborators[0].tools?.map(tool => tool.name)).not.toContain('Write');
    expect(collaborators[0].tools?.map(tool => tool.name)).not.toContain('CodeSearch');
    expect(write.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(collaborators.at(-1)?.messages)).toContain('not found');
  });
});
