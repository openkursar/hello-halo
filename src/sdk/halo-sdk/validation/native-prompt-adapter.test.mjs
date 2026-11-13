import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { PromptToolCallingAdapter, parseXmlToolCalls, renderToolsBlock, detectModelFamily } = await import(pathToFileURL(join(compiled, 'native/prompt-adapter.js')).href);
const { createSession } = await import(pathToFileURL(join(compiled, 'native/session.js')).href);
const { decodeWire } = await import(pathToFileURL(join(compiled, 'native/wire.js')).href);
const capabilities = () => ({ streaming: true, toolCalling: false, imageInput: true, thinking: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' });

test('native XML parsing preserves recorded values, UTF-16 names and parameter prototypes', async () => {
  const fixture = JSON.parse(await readFile(new URL('../native/crates/halo-core/src/llm/tool_calling/fixtures/xml-parameters.json', import.meta.url), 'utf8'));
  for (const entry of fixture.cases) {
    const [text, names] = decodeWire(entry.input);
    const result = parseXmlToolCalls(text, names);
    const actual = {
      textContent: result.textContent,
      toolCalls: result.toolCalls.map(call => {
        const prototype = Object.getPrototypeOf(call.parameters);
        for (const key of Object.keys(call.parameters)) {
          const descriptor = Object.getOwnPropertyDescriptor(call.parameters, key);
          assert.equal(descriptor.enumerable, true, entry.name);
          assert.equal(descriptor.configurable, true, entry.name);
          assert.equal(descriptor.writable, true, entry.name);
        }
        return {
          name: call.name, rawXml: call.rawXml,
          parameters: {
            ownEntries: Object.entries(call.parameters),
            prototype: prototype === Object.prototype ? { kind: 'default' }
              : prototype === null ? { kind: 'null' } : { kind: 'data', value: prototype },
          },
        };
      }),
    };
    assert.deepEqual(actual, decodeWire(entry.expected), entry.name);
  }
});

test('native XML admission preserves original values and avoids reading unused tool names', () => {
  for (const text of [undefined, null, false, 0, -0, NaN, 0n, '']) {
    const names = [];
    Object.defineProperty(names, 0, { get() { throw new Error('Unused name was read'); } });
    const result = parseXmlToolCalls(text, names);
    assert.equal(result.textContent, text);
    assert.deepEqual(result.toolCalls, []);
  }
  for (const text of [Symbol('input'), () => {}, 1n, Object.create(null), { __haloSdkNativeUndefined: true }]) {
    const result = parseXmlToolCalls(text, []);
    assert.equal(result.textContent, text);
    assert.deepEqual(result.toolCalls, []);
  }
});

async function* textEvents(request, text) {
  yield { type: 'message_start', id: 'fixture', model: request.model, usage: { input_tokens: 10, output_tokens: 0 } };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  yield { type: 'text_delta', index: 0, text };
  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'message_delta', stopReason: 'end_turn', usage: { output_tokens: 5 } };
  yield { type: 'message_stop' };
}

test('standalone native prompt adapter preserves pass-through identity and emits parsed tool calls', async () => {
  const requests = [];
  const response = { id: 'response', model: 'fixture', stopReason: 'end_turn', content: [{ type: 'text', text: 'Call it.\n<Bash><command>echo hello</command></Bash>' }] };
  const inner = { id: 'fixture', name: 'Fixture', capabilities, async createMessage(request) { requests.push(request); return response; },
    async *createMessageStream(request) { requests.push(request); yield* textEvents(request, response.content[0].text); } };
  const adapter = new PromptToolCallingAdapter(inner, 'native');
  const empty = { model: 'fixture', messages: [], maxTokens: 20, stream: false };
  assert.equal(await adapter.createMessage(empty), response); assert.equal(requests[0], empty);
  assert.equal(adapter.listModels, undefined); assert.equal(adapter.healthCheck, undefined);
  const tool = { name: 'Bash', description: 'Run.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } };
  const result = await adapter.createMessage({ ...empty, tools: [tool], systemPrompt: 'System' });
  assert.equal(requests[1].tools, undefined); assert.match(requests[1].systemPrompt, /XML-style tags/);
  assert.equal(result.stopReason, 'tool_use'); assert.equal(result.content.at(-1).name, 'Bash');
  assert.deepEqual(result.content.at(-1).input, { command: 'echo hello' });
  assert.match(result.content.at(-1).id, /^toolu_[0-9a-f]{24}$/);
  const streamed = [];
  for await (const event of adapter.createMessageStream({ ...empty, tools: [tool], stream: true })) streamed.push(event);
  assert.equal(streamed.at(-1).type, 'message_stop');
  assert.equal(streamed.at(-2).stopReason, 'tool_use');
  assert.ok(streamed.some(event => event.content_block?.type === 'tool_use' && event.content_block.input.command === 'echo hello'));
  assert.equal(detectModelFamily('Pro/zai-org/GLM-5'), 'glm');
  assert.match(renderToolsBlock([tool]), /## Bash/);
  assert.equal(parseXmlToolCalls('<Bash><command>test</command></Bash>', ['Bash']).toolCalls[0].parameters.command, 'test');
});

for (const mode of ['xml', 'json']) test(`native ${mode} session parses model text into a real file effect and applies model-specific text`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-prompt-'));
  let session;
  try {
    const path = join(root, 'effect.txt');
    const input = { file_path: path, content: `written by ${mode}` };
    const call = mode === 'xml' ? `<Write><param name="file_path">${path}</param><param name="content">${input.content}</param></Write>`
      : `\`\`\`json\n${JSON.stringify([{ name: 'Write', params: input }])}\n\`\`\``;
    const requests = [];
    const provider = { id: 'fixture', name: 'Fixture', capabilities,
      async createMessage() { throw new Error('Unexpected nonstreaming work'); },
      async *createMessageStream(request) {
        requests.push(request); assert.equal(request.tools, undefined);
        assert.match(typeof request.systemPrompt === 'string' ? request.systemPrompt : JSON.stringify(request.systemPrompt), /Fixture tool instructions/);
        if (requests.length === 1) yield* textEvents(request, call);
        else {
          assert.equal(await readFile(path, 'utf8'), input.content);
          assert.ok(request.messages.some(message => typeof message.content === 'string' && message.content.startsWith('RESULT Write:')));
          yield* textEvents(request, 'File written and checked.');
        }
      },
    };
    session = await createSession({ model: 'fixture', provider, toolCallingMode: mode, cwd: root, env: { HOME: root }, persistSession: false,
      collaboration: false, tools: ['Write'], permissionMode: 'bypassPermissions', systemPrompt: 'Local fixture', thinking: { type: 'disabled' },
      harnessText: { templates: { [`providers.${mode}.instructions`]: 'Fixture tool instructions\n' }, models: { fixture: { 'providers.history.tool_result': 'RESULT {name}: {content}' } } } });
    await session.send('Write the fixture file.'); const events = [];
    for await (const event of session.stream()) events.push(event);
    assert.equal(requests.length, 2); assert.equal(events.findLast(event => event.type === 'result').subtype, 'success');
    assert.equal(events.at(-1).state, 'idle'); assert.equal(await readFile(path, 'utf8'), input.content);
  } finally { await session?.[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); }
});
