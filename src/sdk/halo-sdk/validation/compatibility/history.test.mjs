import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../../dist', import.meta.url));
const reference = process.env.SDK_REFERENCE_TEST_ROOT;
assert.ok(reference, 'SDK_REFERENCE_TEST_ROOT must identify the previous TypeScript-based SDK dist directory');
const candidate = await import(pathToFileURL(join(compiled, 'index.js')).href);
const baseline = await import(pathToFileURL(join(reference, 'index.js')).href);
const phases = ['typescript-first', 'rust-continued', 'typescript-returned'];

function provider(script) {
  let requests = 0;
  return {
    id: 'history-compatibility', name: 'History compatibility fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary request'); },
    async *createMessageStream(request) {
      const block = await script(request, ++requests);
      yield { type: 'message_start', id: `response-${requests}`, model: request.model,
        usage: { input_tokens: 20, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: block };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: block.type === 'tool_use' ? 'tool_use' : 'end_turn',
        usage: { output_tokens: 4 } };
      yield { type: 'message_stop' };
    },
    requestCount: () => requests,
  };
}

for (const discovery of [false, true]) {
  test(`saved ${discovery ? 'discovery' : 'ordinary'} history continues across TypeScript and Rust${discovery ? ' and is explicitly refused by the old TypeScript SDK' : ' and rollback'} without replay`,
    { timeout: 30_000 }, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'halo-history-compatibility-')));
      const file = join(root, 'effects.txt');
      let session;
      let sessionId;
      const recorded = [];
      const server = {
        listTools: () => [{ name: 'record', description: 'Record a supplied value.',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }],
        async callTool(name, input) {
          assert.equal(name, 'record');
          await appendFile(file, `${input.value}\n`);
          return { content: [{ type: 'text', text: `Recorded ${input.value}` }] };
        },
      };
      const options = {
        model: 'fixture', cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
        tools: discovery ? [] : ['Bash'], collaboration: false, settingSources: [], maxTurns: 6,
        permissionMode: 'bypassPermissions', systemPrompt: 'Local history compatibility fixture.',
        thinking: { type: 'disabled' },
        ...(discovery ? {
          mcpServers: { records: { type: 'sdk', name: 'records', instance: server } },
          toolDiscovery: { services: { records: { identity: 'fixture:records', loading: 'deferred' } } },
        } : {}),
      };
      try {
        for (const [phaseIndex, phase] of phases.entries()) {
          const sdk = phaseIndex === 1 ? candidate : baseline;
          const needsSearch = discovery && phaseIndex === 0;
          const callStep = needsSearch ? 2 : 1;
          const model = provider(async (request, step) => {
            const blocks = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
            if (step === 1) {
              for (const earlier of recorded) {
                assert.ok(blocks.some(block => block.id === `call-${earlier}`));
                assert.ok(blocks.some(block => block.tool_use_id === `call-${earlier}`));
                assert.ok(blocks.some(block => block.type === 'text' && block.text === `Completed ${earlier}.`));
              }
              if (recorded.length) assert.equal(await readFile(file, 'utf8'), `${recorded.join('\n')}\n`);
            }
            if (needsSearch && step === 1) return { type: 'tool_use', id: 'discover-record', name: 'ToolSearch',
              input: { query: 'select:mcp__records__record' } };
            if (step === callStep) return discovery
              ? { type: 'tool_use', id: `call-${phase}`, name: 'CallTool',
                input: { tool: 'mcp__records__record', arguments: JSON.stringify({ value: phase }) } }
              : { type: 'tool_use', id: `call-${phase}`, name: 'Bash',
                input: { command: `printf '%s\\n' '${phase}' >> '${file}'` } };
            assert.equal(step, callStep + 1);
            assert.equal(await readFile(file, 'utf8'), `${[...recorded, phase].join('\n')}\n`);
            const result = blocks.find(block => block.tool_use_id === `call-${phase}`);
            assert.ok(result);
            assert.notEqual(result.is_error, true);
            return { type: 'text', text: `Completed ${phase}.` };
          });
          const open = () => sdk.createSession({ ...options, provider: model,
            ...(sessionId ? { resume: sessionId, strictResume: true } : {}) });
          if (discovery && phaseIndex === 2) {
            await assert.rejects(open, (error) =>
              error?.code === 'RESUME_HISTORY_UNAVAILABLE' || error?.name === 'ResumeHistoryError');
            assert.equal(await readFile(file, 'utf8'), `${recorded.join('\n')}\n`);
            continue;
          }
          session = await open();
          if (sessionId) assert.equal(session.sessionId, sessionId);
          sessionId = session.sessionId;
          await session.send(`Record ${phase} once.`);
          const events = [];
          for await (const event of session.stream()) events.push(event);
          assert.equal(events.filter(event => event.type === 'result').at(-1)?.subtype, 'success');
          assert.equal(model.requestCount(), callStep + 1);
          await session[Symbol.asyncDispose]();
          session = undefined;
          recorded.push(phase);
          assert.equal(await readFile(file, 'utf8'), `${recorded.join('\n')}\n`);
        }
      } finally {
        await session?.[Symbol.asyncDispose]();
        await rm(root, { recursive: true, force: true });
      }
    });
}
