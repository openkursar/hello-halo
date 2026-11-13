import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { McpConnectionManager, connectExternalMcpServers } = await import(pathToFileURL(join(compiled, 'native/mcp-manager.js')).href);
const { McpToolIdentityError } = await import(pathToFileURL(join(compiled, 'native/mcp-errors.js')).href);
const { StdioTransport } = await import(pathToFileURL(join(compiled, 'native/mcp-transports.js')).href);
const context = signal => ({ abortSignal: signal ?? new AbortController().signal });

async function endpoint(root, label, names = ['write/value']) {
  const file = join(root, `${label}.json`), effects = [];
  let deletions = 0;
  const server = createServer((request, response) => {
    if (request.method === 'DELETE') { deletions++; response.writeHead(204); response.end(); return; }
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      void (async () => {
        const message = JSON.parse(raw);
        if (!Object.hasOwn(message, 'id')) { response.writeHead(204); response.end(); return; }
        let result;
        if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1', description: 'Fixture records' }, instructions: 'Use a fixture value.' };
        else if (message.method === 'tools/list') result = { tools: names.map(name => ({ name, description: 'Record a fixture value.',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, annotations: { readOnlyHint: true } })) };
        else { effects.push(message.params); await writeFile(file, JSON.stringify(effects)); result = { content: [{ type: 'text', text: 'recorded' }] }; }
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `session-${label}` });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      })().catch(error => { response.writeHead(500); response.end(String(error)); });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { file, effects, deletions: () => deletions, config: { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp` },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('native public manager keeps issued tool ownership across equal-schema replacements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-mcp-manager-'));
  const first = await endpoint(root, 'first'), second = await endpoint(root, 'second');
  const manager = new McpConnectionManager();
  try {
    manager.addServer('configured/key', first.config);
    const connecting = manager.connect('configured/key');
    assert.equal(manager.getStatus('configured/key').state, 'connecting');
    await connecting;
    const previous = manager.getBridgedTools()[0];
    assert.equal(previous.name, 'mcp__configured_key__write_value');
    assert.equal(previous.isConcurrencySafe, undefined);
    assert.equal(manager.ownsTool(previous), true); assert.equal(manager.ownsTool({ ...previous }), false);
    assert.deepEqual(await previous.execute({ value: 'first' }, context()), { content: 'recorded', isError: false });
    assert.deepEqual(JSON.parse(await readFile(first.file, 'utf8')), [{ name: 'write/value', arguments: { value: 'first' } }]);
    assert.deepEqual(await manager.setServers({ 'configured/key': second.config }), { added: [], removed: [], errors: {} });
    const current = manager.getBridgedTools()[0];
    assert.deepEqual(current.inputSchema, previous.inputSchema); assert.equal(current.description, previous.description);
    const stale = await previous.execute({ value: 'stale' }, context());
    assert.equal(stale.isError, true); assert.match(stale.content, /The stale call was not executed/);
    await assert.rejects(access(second.file));
    assert.equal((await current.execute({ value: 'second' }, context())).isError, false);
    await manager.setServers({}); await manager.setServers({ 'configured/key': second.config });
    assert.equal((await current.execute({ value: 'removed' }, context())).isError, true);
    const cancelled = new AbortController(); cancelled.abort(new Error('caller stopped'));
    const stopped = await manager.getBridgedTools()[0].execute({ value: 'cancelled' }, context(cancelled.signal));
    assert.equal(stopped.isError, true); assert.match(stopped.content, /caller stopped/);
    assert.equal(second.effects.length, 1);
    manager.disconnectAll(); assert.equal(manager.getStatus('configured/key').state, 'disconnected');
    await manager.whenSettled(); assert.equal(manager.getBridgedTools().length, 0);
    await assert.rejects(manager.connect('configured/key'), /disposed/);
  } finally { manager.disconnectAll(); await manager.whenSettled(); await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); }
});

test('native external MCP rejects identity collisions and retains its distinct execution contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-external-mcp-'));
  const duplicate = await endpoint(root, 'duplicate', ['write/value', 'write_value']);
  const valid = await endpoint(root, 'valid');
  let connected;
  try {
    await assert.rejects(connectExternalMcpServers({ duplicate: duplicate.config }), error => error instanceof McpToolIdentityError && error.name === 'Error');
    assert.equal(duplicate.deletions(), 1);
    connected = await connectExternalMcpServers({ valid: valid.config });
    assert.deepEqual(connected.serverStatuses, [{ name: 'valid', status: 'connected' }]);
    const tool = connected.tools[0]; assert.equal(tool.isConcurrencySafe({}), true);
    const aborted = new AbortController(); aborted.abort();
    assert.equal((await tool.execute({ value: 'explicit external call' }, context(aborted.signal))).isError, false);
    assert.equal(valid.effects.length, 1);
    connected.disconnect();
    const stopped = await tool.execute({ value: 'after close' }, context());
    assert.equal(stopped.isError, true); assert.match(stopped.content, /not initialized/);
    assert.equal(valid.effects.length, 1);
  } finally { connected?.disconnect(); await duplicate.close(); await valid.close(); await rm(root, { recursive: true, force: true }); }
});

test('native stdio connection cancellation wins over a same-stack spawn error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-mcp-cancel-'));
  try {
    const transport = new StdioTransport({ command: join(root, 'missing') });
    const opening = transport.connect(); const rejected = assert.rejects(opening, /closed/i);
    transport.close(); await rejected; assert.equal(transport.connected, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
