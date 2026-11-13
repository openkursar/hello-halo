import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { createSession, createSdkMcpServer, query, tool } = await import(pathToFileURL(join(compiled, process.env.SDK_COLLABORATION_ENTRY ?? 'native/index.js')).href);

for (const mode of ['query', 'session']) {
  for (const [loading, changeDirectory] of [['deferred', false], ['eager', false], ['deferred', true]]) {
    test(`${mode} preserves ${loading} tools and ordered service context after collaboration${changeDirectory ? ' and a directory change' : ''}`, { timeout: 15_000 }, async context => {
      const cwd = await mkdtemp(join(tmpdir(), 'halo-continuation-context-'));
      const requests = [];
      const calls = [];
      const frames = [];
      const target = 'mcp__records__lookup';
      const prompt = 'Delegate a bounded task, then use the record tool.';
      const controller = new AbortController();
      const abort = () => controller.abort();
      context.signal.addEventListener('abort', abort, { once: true });
      let releaseChild;
      const childGate = new Promise(resolve => { releaseChild = resolve; });
      let sequence = 0;
      let parentStep = 0;
      let sourceStopped = 0;
      let control;
      let session;
      let server;
      const provider = {
        id: 'source-discovery', name: 'Scripted source discovery',
        capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
          pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
        async createMessage() { throw new Error('Unexpected summary in a bounded continuation'); },
        async *createMessageStream(request) {
          const child = JSON.stringify(request.systemPrompt).includes('You are collaborator');
          if (child) await childGate;
          else requests.push(structuredClone(request));
          let call;
          if (!child) {
            const step = parentStep++;
            if (step === 0) call = { name: 'mcp__halo-team__spawn_agent', input: { name: 'reader', prompt: 'Report completion.' } };
            else if (step === 1 && loading === 'deferred') {
              if (changeDirectory) await control.toggleMcpServer('archive', false);
              call = { name: 'ToolSearch', input: { query: `select:${target}` } };
            } else if (step === (loading === 'deferred' ? 3 : 2)) call = loading === 'deferred'
              ? { name: 'CallTool', input: { tool: target, arguments: '{"value":"continued"}' } }
              : { name: target, input: { value: 'continued' } };
          }
          const id = `continuation-${++sequence}`;
          yield { type: 'message_start', id, model: request.model, usage: { input_tokens: 10, output_tokens: 10 } };
          yield { type: 'content_block_start', index: 0, content_block: call
            ? { type: 'tool_use', id, name: call.name, input: call.input }
            : { type: 'text', text: child ? 'Child completed.' : 'Source completed.' } };
          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'message_delta', stopReason: call ? 'tool_use' : 'end_turn' };
          yield { type: 'message_stop' };
        },
      };
      const options = {
        cwd, env: { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'config') }, provider, model: 'fixture',
        tools: [], settingSources: [], persistSession: false, permissionMode: 'bypassPermissions', maxTurns: 12,
        abortController: controller, turnEndChecks: { completion: false, openWork: false },
        systemPrompt: 'You are the source assistant.', collaboration: { mode: 'local' },
        hooks: { Stop: [{ hooks: [async () => { sourceStopped++; releaseChild(); return {}; }] }] },
        mcpServers: { records: createSdkMcpServer({ name: 'records', instructions: 'Keep the record guide.', tools: [
          tool('lookup', 'Read the complete record.', { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
            async ({ value }) => { calls.push(value); return { content: [{ type: 'text', text: `Receipt ${value}` }] }; }),
        ] }) },
        toolDiscovery: { services: { records: { identity: 'records-installation', loading, summary: 'Read records.' } } },
      };
      try {
        if (changeDirectory) {
          server = createServer((request, response) => {
            let raw = '';
            request.on('data', chunk => { raw += chunk; });
            request.on('end', () => {
              const message = JSON.parse(raw);
              if (message.method === 'notifications/initialized') { response.writeHead(204); response.end(); return; }
              const result = message.method === 'initialize'
                ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'archive', version: '1' } }
                : { tools: [{ name: 'read', description: 'Read archived records.', inputSchema: { type: 'object', properties: {} } }] };
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
            });
          });
          await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
          options.mcpServers.archive = { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp` };
          options.toolDiscovery.services.archive = { identity: 'archive-installation', loading: 'deferred', summary: 'Read archives.' };
        }
        if (mode === 'session') {
          session = await createSession(options);
          await session.send(prompt);
          control = session.query;
          for await (const frame of session.stream()) frames.push(frame);
        } else {
          control = query({ prompt, options });
          for await (const frame of control) frames.push(frame);
        }
        assert.ok(sourceStopped > 0);
        assert.deepEqual(calls, ['continued']);
        const results = frames.filter(frame => frame.type === 'result');
        assert.equal(results.length, 1);
        assert.equal(results[0].subtype, 'success');
        assert.equal(results[0].num_turns, loading === 'deferred' ? 5 : 4);
        if (loading === 'deferred') {
          assert.ok(JSON.stringify(requests[3].messages).includes('Read the complete record.'));
          assert.ok(JSON.stringify(requests[3].messages).includes('Keep the record guide.'));
          assert.ok(JSON.stringify(requests[4].messages).includes('Receipt continued'));
          assert.ok(JSON.stringify(requests[4].messages).includes('CallTool'));
          for (const request of requests) assert.deepEqual(request.tools, requests[0].tools);
        } else {
          assert.deepEqual(requests[0].messages.filter(message => !message.isMeta), [{ role: 'user', content: prompt }]);
          assert.ok(requests[0].messages.every(message => message.content !== ''));
        }
        if (changeDirectory) {
          const changed = requests[3];
          assert.deepEqual(changed.messages.slice(0, requests[2].messages.length), requests[2].messages);
          const directories = changed.messages.filter(message => typeof message.content === 'string' && message.content.includes('Available services'));
          assert.equal(directories.length, 2);
          assert.ok(directories[0].content.includes('Read archives.'));
          assert.ok(!directories[1].content.includes('Read archives.'));
          assert.deepEqual(requests[4].messages.slice(0, changed.messages.length), changed.messages);
        } else if (loading === 'deferred') {
          assert.deepEqual(requests.map(request => JSON.stringify(request.messages).includes('Available services')), [true, true, true, true, true]);
          for (const request of requests) assert.deepEqual(request.messages.slice(0, requests[0].messages.length), requests[0].messages);
          assert.equal(requests[0].messages.at(-1).content, prompt);
        }
      } finally {
        releaseChild();
        context.signal.removeEventListener('abort', abort);
        if (session) { session.close(); await session.flush(); }
        else control?.close();
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
}
