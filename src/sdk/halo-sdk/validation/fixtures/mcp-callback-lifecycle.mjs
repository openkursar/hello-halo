import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sdk = await import(pathToFileURL(join(process.env.SDK_BEHAVIOR_TEST_ROOT, 'index.js')).href);
const mode = process.argv[2];
const reads = [];
let original;
original = Object.defineProperties({}, Object.fromEntries(['name', 'message', 'code', 'toString'].map(name => [name, {
  get() { reads.push(name); throw mode === 'session-double' ? original : new Error('Synthetic rejection field read'); },
}])));

async function rejectsOriginal(promise, expected) {
  let rejected = false;
  try { await promise; }
  catch (error) { rejected = true; if (error !== expected) throw new Error('Original rejection identity changed'); }
  assert.equal(rejected, true);
}

if (mode === 'bridge') {
  const context = { abortSignal: new AbortController().signal };
  const instance = {
    listTools: () => [{ name: 'echo', description: 'Echo', inputSchema: {} }],
    callTool() { throw original; },
  };
  const [tool] = sdk.bridgeSdkMcpTools({ name: 'fixture', instance });
  await rejectsOriginal(tool.execute({}, context), original);
  instance.callTool = async function () { assert.equal(this, instance); throw original; };
  await rejectsOriginal(tool.execute({}, context), original);
  instance.callTool = async () => ({ content: [{ type: 'text', text: 'After rejection.' }] });
  assert.deepEqual(await tool.execute({}, context), { content: 'After rejection.', isError: false });

  const controller = new AbortController();
  let ready;
  const entered = new Promise(resolve => { ready = resolve; });
  instance.callTool = (_name, _input, { signal }) => new Promise((_resolve, reject) => {
    assert.equal(signal, controller.signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    ready();
  });
  const pending = tool.execute({}, { abortSignal: controller.signal });
  await entered;
  controller.abort(original);
  await rejectsOriginal(pending, original);
  assert.deepEqual(reads, []);
  process.stdout.write(JSON.stringify({ mode, settled: true, originalRejections: 3, reads, recovered: true }) + '\n');
} else if (mode === 'client-cancel') {
  let rejectLate, started, closed = 0, toolCalls = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const success = { content: [{ type: 'text', text: 'Fresh request.' }] };
  const transport = {
    connected: true,
    async connect() {},
    async send(request) {
      if (request.method === 'initialize') return { result: { capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } };
      if (request.method === 'tools/list') return { result: { tools: [] } };
      toolCalls++;
      if (toolCalls > 1) return { result: success };
      return new Promise((_resolve, reject) => { rejectLate = reject; started(); });
    },
    async notify() {},
    setRequestHandler() {},
    close() { closed++; },
    async whenClosed() {},
  };
  const client = new sdk.McpClient(transport, 'fixture');
  try {
    await client.initialize();
    const controller = new AbortController();
    const pending = client.callTool('wait', {}, controller.signal);
    await entered;
    controller.abort();
    await assert.rejects(pending);
    rejectLate(original);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, []);
    assert.equal(await client.callTool('fresh'), success);
  } finally { client.close(); await client.whenClosed(); }
  assert.equal(closed, 1);
  assert.equal(toolCalls, 2);
  process.stdout.write(JSON.stringify({ mode, settled: true, lateRejectionInspected: false, closed, toolCalls }) + '\n');
} else {
  assert.ok(['session', 'session-lone', 'session-double'].includes(mode));
  const root = await mkdtemp(join(tmpdir(), 'mcp-rejection-session-'));
  let session, calls = 0, observedFailure = false;
  const provider = {
    id: 'callback-fixture', name: 'Callback fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request) {
      calls++;
      if (calls > 1) observedFailure = request.messages.some(message => Array.isArray(message.content)
        && message.content.some(block => block.type === 'tool_result' && block.tool_use_id === 'failed-call' && block.is_error === true));
      const content_block = calls === 1
        ? { type: 'tool_use', id: 'failed-call', name: 'mcp__fixture__fail', input: {} }
        : { type: 'text', text: 'Failure handled.' };
      yield { type: 'message_start', id: `reply-${calls}`, model: request.model, usage: { input_tokens: 1, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: calls === 1 ? 'tool_use' : 'end_turn', usage: { output_tokens: 1 } };
      yield { type: 'message_stop' };
    },
  };
  try {
    session = await sdk.createSession({ model: 'fixture', provider, cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'config') },
      persistSession: false, tools: [], skillCatalog: [], settingSources: [], collaboration: false,
      systemPrompt: 'Synthetic callback fixture.', permissionMode: 'bypassPermissions', maxTurns: 3,
      turnEndChecks: { completion: false, openWork: false },
      mcpServers: { fixture: { type: 'sdk', name: 'fixture', instance: {
        listTools: () => [{ name: 'fail', description: 'Fail once.', inputSchema: { type: 'object' } }],
        async callTool() { throw mode === 'session-lone' ? new Error('Synthetic\ud800failure') : original; },
      } } },
    });
    await session.send('Handle a failing MCP callback.');
    const events = [];
    for await (const event of session.stream()) events.push(event);
    assert.equal(calls, 2);
    assert.equal(observedFailure, true);
    assert.equal(events.find(event => event.type === 'result')?.subtype, 'success');
    assert.equal(events.at(-1)?.state, 'idle');
  } finally { await session?.[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); }
  process.stdout.write(JSON.stringify({ mode, settled: true, calls, observedFailure, closed: true }) + '\n');
}
