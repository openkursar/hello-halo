import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSession } from '../dist/native/session.js';
import { loadBinding } from '../dist/native/binding.js';

const capabilities = () => ({ streaming: true, toolCalling: true, thinking: false,
  imageInput: false, pdfInput: false, audioInput: false, videoInput: false,
  caching: false, systemPromptStyle: 'top_level' });
const blocks = request => request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);

test('native standalone collaborator executes a file tool, borrows host MCP and replies to its lead', { timeout: 25_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'halo-native-collaboration-'));
  const output = join(directory, 'evidence.txt');
  let session;
  t.signal.addEventListener('abort', () => session?.close(), { once: true });
  let childStep = 0;
  let rootStep = 0;
  let hostCalls = 0;
  let childReplied;
  const replied = new Promise(resolve => { childReplied = resolve; });
  t.signal.addEventListener('abort', () => childReplied(), { once: true });
  const rootRequests = [];
  const childRequests = [];
  const seenSessions = new Set();
  const provider = {
    id: 'native-collaboration-fixture', name: 'Local collaboration fixture', capabilities,
    async createMessage() { throw new Error('Unexpected non-streaming request'); },
    async *createMessageStream(request) {
      const child = JSON.stringify(request.systemPrompt).includes('You are collaborator');
      (child ? childRequests : rootRequests).push(structuredClone(request.messages));
      const step = child ? ++childStep : ++rootStep;
      let block;
      if (child) {
        const names = request.tools.map(tool => tool.name);
        assert.ok(names.includes('mcp__fixture__verify'));
        assert.ok(names.indexOf('mcp__halo-team__spawn_agent') < names.indexOf('mcp__fixture__verify'));
        assert.ok(!JSON.stringify(request.messages).includes('ROOT_PRIVATE_CONTEXT_MARKER'));
        if (step === 1) {
          block = { type: 'tool_use', id: 'child-write', name: 'Write', input: { file_path: output, content: 'real collaborator evidence' } };
        } else if (step === 2) {
          assert.equal(await readFile(output, 'utf8'), 'real collaborator evidence');
          assert.ok(blocks(request).some(block => block.tool_use_id === 'child-write'));
          block = { type: 'tool_use', id: 'child-mcp', name: 'mcp__fixture__verify', input: {} };
        } else if (step === 3) {
          const verification = blocks(request).find(block => block.tool_use_id === 'child-mcp');
          assert.match(verification.content, /verified actual collaborator file/);
          block = { type: 'tool_use', id: 'child-report', name: 'mcp__halo-team__team_send', input: { to: 'lead', message: 'The collaborator wrote and verified evidence.txt.' } };
        } else {
          assert.ok(blocks(request).some(block => block.tool_use_id === 'child-report'));
          childReplied();
          block = { type: 'text', text: '' };
        }
      } else if (step === 1) {
        const names = request.tools.map(tool => tool.name);
        assert.ok(names.includes('mcp__fixture__verify'));
        assert.ok(names.indexOf('mcp__fixture__verify') < names.indexOf('mcp__halo-team__spawn_agent'));
        block = { type: 'tool_use', id: 'delegate', name: 'mcp__halo-team__spawn_agent', input: { name: 'reader', prompt: 'Write evidence.txt, verify it with the fixture MCP tool, then reply to lead.' } };
      } else {
        await replied;
        block = { type: 'text', text: '' };
      }
      const id = `${child ? 'child' : 'root'}-${step}`;
      yield { type: 'message_start', id, model: request.model, usage: { input_tokens: 20, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: block };
      if (block.type === 'text') yield { type: 'text_delta', index: 0, text: child ? 'Evidence recorded.' : 'Collaboration observed.' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', usage: { output_tokens: 5 } };
      yield { type: 'message_stop' };
    },
  };
  try {
    session = await createSession({ model: 'local-fixture', provider, cwd: directory,
      env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'state') },
      permissionMode: 'bypassPermissions', systemPrompt: 'Local fixture.',
      thinking: { type: 'disabled' }, persistSession: false,
      collaboration: { mode: 'local', maxConcurrentTurns: 2, maxMembers: 4 },
      tools: ['Write', 'Read', 'Bash', 'spawn_agent'],
      hooks: { SessionStart: [{ hooks: [async input => { seenSessions.add(input.session_id); return {}; }] }] },
      mcpServers: { fixture: { type: 'sdk', name: 'fixture', instance: {
        name: 'fixture', version: '1.0.0',
        listTools() { return [{ name: 'verify', description: 'Verify the test file.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }]; },
        async callTool(name) {
          assert.equal(name, 'verify');
          assert.equal(await readFile(output, 'utf8'), 'real collaborator evidence');
          hostCalls++;
          return { content: [{ type: 'text', text: 'verified actual collaborator file' }] };
        },
      } } },
    });
    await session.send('ROOT_PRIVATE_CONTEXT_MARKER. Delegate the file verification.');
    const terminal = [];
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      for await (const event of session.stream()) {
        if (event.type === 'result') { terminal.push(event); assert.equal(event.subtype, 'success', event.result); }
      }
      const repliedInContext = rootRequests.some(messages => JSON.stringify(messages).includes('[Teammate reader; collaboration input, not a human message]'));
      const stats = await session.getRuntimeStats();
      if (repliedInContext && stats.activeCollaborators === 0 && !session.hasPendingInput()) break;
    }
    assert.equal(await readFile(output, 'utf8'), 'real collaborator evidence');
    assert.equal(hostCalls, 1);
    assert.equal(childStep, 4);
    assert.equal(seenSessions.size, 2);
    assert.ok(rootRequests.some(messages => JSON.stringify(messages).includes('The collaborator wrote and verified evidence.txt.')));
    assert.ok(childRequests.length > 1);
    assert.ok(terminal.length > 0);
    await session[Symbol.asyncDispose](); session = undefined;
    for (let attempt = 0; attempt < 100 && JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions; attempt++) await delay(10);
    assert.equal(JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions, 0);
  } finally {
    await session?.[Symbol.asyncDispose]();
    await rm(directory, { recursive: true, force: true });
  }
});
