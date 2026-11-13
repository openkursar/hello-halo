import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { McpClient, HttpTransport, McpConnectionManager, connectExternalMcpServers } = await import(pathToFileURL(join(compiled, 'index.js')).href);
const literal = { __haloSdkNativeUndefined: true };
const numberLiteral = { __haloSdkNativeNumber: 'NaN' };

function transport(respond) {
  const handlers = new Map();
  return {
    connected: true, handlers, connect: async () => {}, notify: async () => {}, close() {},
    setRequestHandler(method, handler) { handlers.set(method, handler); },
    async send(request) { return { jsonrpc: '2.0', id: request.id, ...await respond(request) }; },
  };
}

test('MCP client preserves custom transport values and tool catalog references', async () => {
  const tools = [{ name: 'echo', description: 'Echo fixture', inputSchema: { type: 'object', properties: { literal } } }];
  const input = { literal, numberLiteral, absent: undefined };
  const output = { content: [{ type: 'text', text: 'done' }], literal, numberLiteral, absent: undefined };
  let selected = output;
  let failure;
  const channel = transport(request => {
    if (request.method === 'initialize') return { result: { capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } };
    if (request.method === 'tools/list') return { result: { tools } };
    assert.equal(request.params.arguments, input);
    return failure ? { error: failure } : { result: selected };
  });
  const client = new McpClient(channel, 'fixture');
  try {
    await client.initialize();
    assert.equal(client.getTools(), tools);
    tools.push({ name: 'later', description: 'Later fixture', inputSchema: {} });
    assert.equal(client.getTools().at(-1), tools.at(-1));
    for (const value of [output, literal, numberLiteral, [literal, numberLiteral]]) {
      selected = value;
      assert.equal(await client.callTool('echo', input), value);
    }
    selected = null;
    assert.deepEqual(await client.callTool('echo', input), { content: [{ type: 'text', text: '' }], isError: false });
    failure = { code: -1, message: literal };
    const failed = await client.callTool('echo', input);
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /\[object Object\]/);
    failure = literal;
    assert.equal((await client.callTool('echo', input)).isError, true);
  } finally { client.close(); }
  assert.deepEqual(client.getTools(), []);
});

test('MCP elicitation retains caller objects and the client lifetime signal', async () => {
  const channel = transport(() => ({ result: { capabilities: {} } }));
  const input = { message: 'Fixture question', literal, numberLiteral, serverName: 'provided' };
  const output = { action: 'accept', content: { literal, numberLiteral } };
  let seenSignal;
  const client = new McpClient(channel, 'configured', async (request, { signal }) => {
    assert.equal(request.literal, literal);
    assert.equal(request.numberLiteral, numberLiteral);
    assert.equal(request.serverName, 'provided');
    seenSignal = signal;
    return output;
  });
  try {
    await client.initialize();
    assert.equal(await channel.handlers.get('elicitation/create')(input), output);
    assert.equal(seenSignal.aborted, false);
  } finally { client.close(); }
  assert.equal(seenSignal.aborted, true);
});

test('MCP custom transport keeps opaque arguments, results, and schemas in their original owner', async () => {
  const input = { count: 1n, callback() {} }; input.self = input;
  const schema = { value: input }; schema.self = schema;
  const tools = [{ name: 'opaque', inputSchema: schema }];
  const output = { content: [], input }; output.self = output;
  const channel = transport(request => {
    if (request.method === 'initialize') return { result: { capabilities: { tools: {} } } };
    if (request.method === 'tools/list') return { result: { tools } };
    assert.equal(request.params.arguments, input);
    assert.equal(request.params.arguments.callback, input.callback);
    return { result: output };
  });
  const client = new McpClient(channel, 'opaque');
  try {
    await client.initialize();
    assert.equal(client.getTools(), tools);
    assert.equal(client.getTools()[0].inputSchema, schema);
    assert.equal(await client.callTool('opaque', input), output);
  } finally { client.close(); }
});

test('MCP public metadata and error feedback retain UTF-16 code units', async () => {
  const configured = 'configured\ud800';
  const toolName = 'tool\udfff';
  const serverInfo = { name: 'remote\ud800', version: 'v\udfff', description: '\ud800\0\udfff' };
  const instructions = 'instructions\udfff';
  const remoteMessage = 'error\ud800\0\udfff';
  let throwOriginal = false;
  const original = Object.assign(new Error(remoteMessage), { code: 'fixture\ud800', marker: literal });
  const channel = transport(request => {
    if (request.method === 'initialize') return { result: { capabilities: {}, serverInfo, instructions } };
    assert.equal(request.params.name, toolName);
    if (throwOriginal) throw original;
    return { error: { message: remoteMessage } };
  });
  const client = new McpClient(channel, configured);
  try {
    const before = await client.callTool(toolName);
    assert.equal(before.content[0].text, `MCP server "${configured}" not initialized`);
    await client.initialize();
    assert.deepEqual(client.getServerInfo(), serverInfo);
    assert.equal(client.getInstructions(), instructions);
    assert.equal((await client.callTool(toolName)).content[0].text, `MCP tool error (${configured}/${toolName}): ${remoteMessage}`);
    throwOriginal = true;
    await assert.rejects(client.callTool(toolName), error => error === original);
  } finally { client.close(); }
});

test('MCP custom transport observes error and result properties only on their selected branches', async () => {
  const reads = [];
  let failed = true;
  const response = {
    get error() { reads.push('error'); return failed ? { get message() { reads.push('message'); return { toString() { reads.push('toString'); return 'remote'; } }; } } : undefined; },
    get result() { reads.push('result'); return { content: [] }; },
  };
  const channel = transport(() => ({ result: { capabilities: {} } }));
  const client = new McpClient(channel, 'fixture');
  try {
    await client.initialize();
    channel.send = async () => response;
    assert.equal((await client.callTool('echo')).isError, true);
    assert.deepEqual(reads, ['error', 'error', 'message', 'toString']);
    reads.length = 0; failed = false;
    assert.deepEqual(await client.callTool('echo'), { content: [] });
    assert.deepEqual(reads, ['error', 'result']);
  } finally { client.close(); }
});

test('MCP propagates transport rejections without inspecting the thrown value', async () => {
  const channel = transport(() => ({ result: { capabilities: {} } }));
  const reads = [];
  const original = Object.defineProperties({}, Object.fromEntries(['name', 'message', 'code', 'harness', 'toString'].map(name => [name, {
    get() { reads.push(name); throw new Error(`Unexpected ${name} inspection`); },
  }])));
  const client = new McpClient(channel, 'fixture');
  try {
    await client.initialize();
    channel.send = async () => { throw original; };
    let rejected = false;
    try { await client.callTool('echo'); }
    catch (error) { rejected = true; assert.equal(error, original); }
    assert.equal(rejected, true);
    assert.deepEqual(reads, []);
  } finally { client.close(); }
});

test('MCP initialization reads capabilities after notification and preserves metadata access order', async () => {
  for (const initiallySupported of [false, true]) {
    const reads = [];
    let supported = initiallySupported;
    let discoveries = 0;
    const capabilities = { get tools() { reads.push('capabilities.tools'); return supported ? {} : undefined; } };
    const metadata = Object.fromEntries(['name', 'version', 'description'].map(name => [name, `${name}-value`]));
    const info = Object.defineProperties({}, Object.fromEntries(Object.entries(metadata).map(([name, value]) => [name, {
      get() { reads.push(name); return value; },
    }])));
    const result = {
      get capabilities() { reads.push('result.capabilities'); return capabilities; },
      get serverInfo() { reads.push('result.serverInfo'); return info; },
      get instructions() { reads.push('instructions'); return 'instructions-value'; },
    };
    const channel = transport(() => ({}));
    channel.send = async request => {
      if (request.method === 'initialize') return {
        get error() { reads.push('response.error'); return undefined; },
        get result() { reads.push('response.result'); return result; },
      };
      assert.equal(request.method, 'tools/list'); discoveries++; return { result: { tools: [] } };
    };
    channel.notify = async () => { reads.push('notify'); supported = !initiallySupported; };
    const client = new McpClient(channel, 'fixture');
    try {
      await client.initialize();
      assert.equal(discoveries, initiallySupported ? 0 : 1);
      assert.deepEqual(client.getServerInfo(), metadata);
      assert.equal(client.getInstructions(), 'instructions-value');
      assert.deepEqual(reads, [
        'response.error', 'response.result', 'result.capabilities',
        'result.serverInfo', 'name', 'result.serverInfo', 'name',
        'result.serverInfo', 'version', 'result.serverInfo', 'version',
        'result.serverInfo', 'description', 'result.serverInfo', 'description',
        'instructions', 'instructions', 'notify', 'capabilities.tools',
      ]);
    } finally { client.close(); }
  }
});

test('MCP HTTP transport keeps ordinary JSON objects on both sides of the wire', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const message = JSON.parse(raw); requests.push(message);
      if (message.method === 'notifications/initialized') { response.writeHead(204); response.end(); return; }
      const result = message.method === 'initialize' ? { capabilities: {} }
        : { content: [], literal, numberLiteral, echo: message.params.arguments };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const channel = new HttpTransport({ url: `http://127.0.0.1:${server.address().port}/mcp` });
  const client = new McpClient(channel, 'fixture');
  try {
    await channel.connect(); await client.initialize();
    const output = await client.callTool('echo', { literal, numberLiteral, absent: undefined });
    assert.deepEqual(output, { content: [], literal, numberLiteral, echo: { literal, numberLiteral } });
    await client.callTool('echo');
    assert.equal(Object.hasOwn(requests.at(-1).params, 'arguments'), false);
  } finally {
    client.close(); await client.whenClosed();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('MCP server requests preserve literal objects and distinguish absent parameters', { timeout: 10_000 }, async () => {
  const inputs = [literal, numberLiteral, undefined, { reject: true }];
  const seen = [], replies = [];
  let activeResponse;
  const sendRequest = index => activeResponse.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: `server-${index}`, method: 'fixture', params: inputs[index] })}\n\n`);
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'poll') {
        activeResponse = response;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        sendRequest(0);
      } else {
        replies.push(message.error ?? message.result);
        response.writeHead(204); response.end();
        if (replies.length < inputs.length) sendRequest(replies.length);
        else activeResponse.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { done: true } })}\n\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const channel = new HttpTransport({ url: `http://127.0.0.1:${server.address().port}/mcp` });
  channel.setRequestHandler('fixture', async params => {
    seen.push(params);
    if (params?.reject) throw { message: 'Plain rejection data' };
    return params;
  });
  try {
    await channel.connect();
    const result = await channel.send({ jsonrpc: '2.0', id: 1, method: 'poll' });
    assert.deepEqual(result.result, { done: true });
    assert.deepEqual(seen, inputs);
    assert.deepEqual(replies, [literal, numberLiteral, null, { code: -32000, message: '[object Object]' }]);
  } finally {
    channel.close(); await channel.whenClosed();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('managed and standalone external MCP preserve literal tool schema data', async () => {
  const schemas = [{ type: 'object', properties: { option: { default: literal, examples: [numberLiteral] } } }, literal];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'notifications/initialized') { response.writeHead(204); response.end(); return; }
      const result = message.method === 'initialize' ? { capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: schemas.map((inputSchema, index) => ({ name: `schema-${index}`, description: 'Schema fixture', inputSchema })) };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp` };
  const manager = new McpConnectionManager();
  let connection;
  try {
    manager.addServer('fixture', config); await manager.connect('fixture');
    connection = await connectExternalMcpServers({ fixture: config });
    for (const tools of [manager.getBridgedTools(), connection.tools]) {
      assert.deepEqual(tools.map(tool => tool.inputSchema), schemas);
      assert.equal(tools[0].mcpSource.description, undefined);
      assert.equal(tools[0].mcpSource.instructions, undefined);
    }
  } finally {
    manager.disconnectAll(); await manager.whenSettled(); connection?.disconnect();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
