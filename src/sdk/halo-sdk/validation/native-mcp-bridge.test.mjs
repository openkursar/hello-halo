import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { bridgeSdkMcpTools } = await import(pathToFileURL(join(compiled, 'index.js')).href);
const context = { abortSignal: new AbortController().signal };

for (const mode of ['bridge', 'session', 'session-lone', 'session-double', 'client-cancel']) {
  test(`MCP callback failures settle and the ${mode} process exits`, { timeout: 10_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-callback-exit-'));
    const env = { HOME: root, USERPROFILE: root, TMPDIR: root, TEMP: root, TMP: root, SDK_BEHAVIOR_TEST_ROOT: compiled };
    for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name];
    try {
      const { stdout } = await promisify(execFile)(process.execPath,
        [fileURLToPath(new URL('./fixtures/mcp-callback-lifecycle.mjs', import.meta.url)), mode], { env, timeout: 5000 });
      const observed = JSON.parse(stdout.trim().split('\n').at(-1));
      assert.equal(observed.mode, mode);
      assert.equal(observed.settled, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('public MCP bridge retains opaque schemas and arguments without observing their properties', async () => {
  const reads = [];
  const input = { count: 1n, callback() {} }; input.self = input;
  const schema = { type: 'object', input }; schema.self = schema;
  Object.defineProperty(schema, 'poison', { enumerable: true, get() { reads.push('schema'); throw new Error('Schema must remain opaque'); } });
  Object.defineProperty(input, 'poison', { enumerable: true, get() { reads.push('input'); throw new Error('Input must remain opaque'); } });
  const definition = { name: 'echo', description: 'Echo', inputSchema: schema };
  const instance = {
    listTools() { return [definition]; },
    async callTool(name, actual, { signal }) {
      assert.equal(this, instance);
      assert.equal(name, 'echo');
      assert.equal(actual, input);
      assert.equal(signal, context.abortSignal);
      return { content: [{ type: 'text', text: 'unchanged' }] };
    },
  };
  const [tool] = bridgeSdkMcpTools({ name: 'fixture', instance });
  assert.equal(tool.inputSchema, schema);
  assert.deepEqual(await tool.execute(input, context), { content: 'unchanged', isError: false });
  assert.deepEqual(reads, []);
});

test('public MCP bridge preserves UTF-16 descriptions, metadata, feedback and description cut positions', async () => {
  const original = `prefix\ud800\0\udfff${'x'.repeat(2040)}🙂tail`;
  const name = 'tool\ud800';
  const server = 'server\udfff';
  const definition = { name, description: original, inputSchema: {} };
  const instance = {
    description: 'description\udfff', instructions: 'instructions\ud800',
    listTools() { return [definition]; },
    async callTool(actual) {
      assert.equal(actual, name);
      return { content: [{ type: 'text', text: '\ud800\0\udfff' }, { type: 'fixture', value: { __haloSdkNativeUndefined: true } }] };
    },
  };
  const [tool] = bridgeSdkMcpTools({ name: server, instance }, 'source\ud800');
  assert.equal(tool.name, 'mcp__server___tool_');
  assert.equal(tool.description, original.slice(0, 2048) + '... [truncated]');
  assert.deepEqual(tool.mcpSource, { server: 'source\ud800', description: instance.description, instructions: instance.instructions, name, toolDescription: original });
  assert.deepEqual(await tool.execute({}, context), { content: '\ud800\0\udfff\n{"type":"fixture","value":{"__haloSdkNativeUndefined":true}}', isError: false });
  instance.callTool = async () => undefined;
  assert.deepEqual(await tool.execute({}, context), { content: `MCP tool "${name}" not found on server "${server}".`, isError: true });
});

test('public MCP bridge formats original content with JavaScript JSON and property access semantics', async () => {
  const reads = [];
  const originalError = { __haloSdkNativeUndefined: true };
  const text = {
    get type() { reads.push('text.type'); return 'text'; },
    get text() { reads.push('text.text'); return 'text\ud800'; },
    get unused() { throw new Error('Unobserved field'); },
  };
  const other = {
    get type() { reads.push('other.type'); return 'resource'; },
    toJSON(key) { reads.push(`toJSON:${key}`); return { literal: { __haloSdkNativeNumber: 'NaN' }, text: '\udfff' }; },
  };
  const instance = {
    listTools: () => [{ name: 'echo', description: 'Echo', inputSchema: {} }],
    callTool: async () => ({ get content() { reads.push('content'); return [text, other]; }, get isError() { reads.push('isError'); return originalError; } }),
  };
  const [tool] = bridgeSdkMcpTools({ name: 'fixture', instance });
  const result = await tool.execute({}, context);
  assert.equal(result.content, 'text\ud800\n{"literal":{"__haloSdkNativeNumber":"NaN"},"text":"\\udfff"}');
  assert.equal(result.isError, originalError);
  assert.deepEqual(reads, ['content', 'isError', 'text.type', 'text.text', 'text.text', 'other.type', 'other.type', 'toJSON:']);
});

test('public MCP bridge preserves raw SDK rejections and registered handler error coercion', async () => {
  const reads = [];
  const original = Object.defineProperties({}, Object.fromEntries(['name', 'message', 'code', 'toString'].map(name => [name, { get() { reads.push(name); throw new Error('Do not inspect original rejection'); } }])));
  const instance = { listTools: () => [{ name: 'echo', description: 'Echo', inputSchema: {} }], callTool: async () => { throw original; } };
  const [tool] = bridgeSdkMcpTools({ name: 'fixture', instance });
  let rejected = false;
  try { await tool.execute({}, context); } catch (error) { rejected = true; assert.equal(error, original); }
  assert.equal(rejected, true);
  assert.deepEqual(reads, []);

  const message = 'failure\ud800\0\udfff';
  for (const rejection of [new Error(message), { toString: () => message }]) {
    const [registered] = bridgeSdkMcpTools({ name: 'registered', instance: { _registeredTools: { echo: { description: 'Echo', handler: async () => { throw rejection; } } } } });
    assert.deepEqual(await registered.execute({}, context), { content: `MCP tool "echo" failed: ${message}`, isError: true });
  }
});
