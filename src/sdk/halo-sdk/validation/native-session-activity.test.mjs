import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const entry = pathToFileURL(join(compiled, process.env.SDK_SESSION_ENTRY ?? 'native/session.js')).href;

test('multiple live text updates keep their separation in the next OpenAI request', { timeout: 15_000 }, async () => {
  const { createSession, OpenAiCompatProvider } = await import(pathToFileURL(join(compiled, 'index.js')).href);
  const root = await mkdtemp(join(tmpdir(), 'halo-live-input-wire-'));
  const requests = [], accepted = [];
  let session, pendingAfterAdmission;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (requests.length === 1) {
      accepted.push(session.sendIntoLiveTurn('first update'));
      accepted.push(session.sendIntoLiveTurn('second update'));
      pendingAfterAdmission = session.hasPendingInput();
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { id: `reply-${requests.length}`, model: 'fixture', choices: [{ delta: { content: requests.length === 1 ? 'First answer.' : 'Updated answer.' } }] },
      { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const provider = new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    session = await createSession({ model: 'fixture', provider, cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
      tools: [], skillCatalog: [], settingSources: [], collaboration: false, persistSession: false,
      systemPrompt: 'Fixture.', thinking: { type: 'disabled' }, turnEndChecks: { completion: false, openWork: false } });
    await session.send('start');
    const events = [];
    for await (const event of session.stream()) events.push(event);
    assert.deepEqual(accepted, [true, true]);
    assert.equal(pendingAfterAdmission, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].messages.at(-1).content, 'first update\n\nsecond update');
    const results = events.filter(event => event.type === 'result');
    assert.equal(results.length, 1);
    assert.equal(results[0].subtype, 'success');
    assert.equal(session.hasPendingInput(), false);
    assert.equal(events.at(-1).state, 'idle');
  } finally {
    await session?.[Symbol.asyncDispose]();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ['idle', 'active']) {
  test(`ordinary ${mode} session completes its accepted work and exits without explicit disposal`, { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), `halo-session-${mode}-`));
    const source = `
      import assert from 'node:assert/strict';
      import {writeFile} from 'node:fs/promises';
      import {join} from 'node:path';
      const {createSession}=await import(${JSON.stringify(entry)});
      const root=${JSON.stringify(root)};
      const mode=${JSON.stringify(mode)};
      let requests=0;
      const provider={id:'activity-fixture',name:'Activity fixture',
        capabilities:()=>({streaming:true,toolCalling:false,thinking:false,imageInput:false,pdfInput:false,audioInput:false,videoInput:false,caching:false,systemPromptStyle:'top_level'}),
        async createMessage(){throw new Error('Unexpected completion request');},
        async *createMessageStream(request){
          requests++;
          await writeFile(join(root,'provider.txt'),'provider called');
          yield {type:'message_start',id:'activity',model:request.model,usage:{input_tokens:1,output_tokens:0}};
          yield {type:'content_block_start',index:0,content_block:{type:'text',text:''}};
          yield {type:'text_delta',index:0,text:'Activity completed.'};
          yield {type:'content_block_stop',index:0};
          yield {type:'message_delta',stopReason:'end_turn',usage:{output_tokens:1}};
          yield {type:'message_stop'};
        }
      };
      const session=await createSession({model:'fixture',provider,cwd:root,env:{HOME:root},persistSession:false,
        tools:[],collaboration:false,systemPrompt:'Ordinary activity fixture.',thinking:{type:'disabled'}});
      await writeFile(join(root,'ready.txt'),'ready');
      if(mode==='active'){
        await session.send('Complete the local task.');
        let result;
        for await(const event of session.stream())if(event.type==='result')result=event;
        assert.equal(result?.subtype,'success');
        assert.equal(result.result,'Activity completed.');
        assert.equal(requests,1);
        await writeFile(join(root,'result.txt'),result.result);
      }else assert.equal(requests,0);
      await writeFile(join(root,'done.txt'),mode);
      process.stdout.write('activity-settled:'+mode);
    `;
    const env = { HOME: root, USERPROFILE: root, TMPDIR: root, TEMP: root, TMP: root };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env, timeout: 10_000 });
      assert.match(stdout, new RegExp(`activity-settled:${mode}$`));
      assert.equal(await readFile(join(root, 'ready.txt'), 'utf8'), 'ready');
      assert.equal(await readFile(join(root, 'done.txt'), 'utf8'), mode);
      if (mode === 'active') {
        assert.equal(await readFile(join(root, 'provider.txt'), 'utf8'), 'provider called');
        assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'Activity completed.');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('live input remains withdrawable while the consumer handles a tool result', { timeout: 10_000 }, async () => {
  const { createSession } = await import(entry);
  const root = await mkdtemp(join(tmpdir(), 'halo-live-withdraw-'));
  const requests = [], receipts = [], frames = [];
  const provider = {
    id: 'fixture', name: 'Fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async *createMessageStream(request) {
      requests.push(structuredClone(request));
      const block = requests.length === 1 ? { type: 'tool_use', id: 'probe', name: 'Probe', input: {} } : { type: 'text', text: 'Finished.' };
      yield { type: 'message_start', id: `reply-${requests.length}`, model: request.model, usage: { input_tokens: 1, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: block };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', usage: { output_tokens: 1 } };
      yield { type: 'message_stop' };
    },
  };
  const session = await createSession({ model: 'fixture', provider, cwd: root, env: { HOME: root }, settingSources: [], tools: [],
    persistSession: false, collaboration: false, systemPrompt: 'Fixture', permissionMode: 'bypassPermissions',
    turnEndChecks: { openWork: false, completion: false }, customTools: [{ name: 'Probe', description: 'Probe', inputSchema: { type: 'object' },
      permissionLevel: 'readonly', async execute() { return { content: 'Completed.' }; } }] });
  try {
    await session.send('Start.');
    for await (const frame of session.stream()) {
      frames.push(frame);
      if (frame.type === 'user' && !frame.isReplay) {
        assert.equal(session.sendIntoLiveTurn('withdraw-this', { onConsumed: () => receipts.push('consumed'), onWithdrawn: () => receipts.push('withdrawn') }), true);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(requests.length, 1, 'The next model step must await consumer advancement.');
        assert.equal(await session.withdrawUnreadInput(), 1);
        assert.equal(session.sendIntoLiveTurn('keep-this', { onConsumed: () => receipts.push('kept') }), true);
      }
    }
    assert.equal(requests.length, 2);
    assert.equal(JSON.stringify(requests[1].messages).includes('withdraw-this'), false);
    assert.equal(JSON.stringify(requests[1].messages).includes('keep-this'), true);
    assert.deepEqual(receipts, ['withdrawn', 'kept']);
    assert.equal(frames.filter(frame => frame.type === 'user' && frame.isReplay).length, 0);
    assert.equal(frames.filter(frame => frame.type === 'result').length, 1);
    assert.equal(frames.at(-1)?.state, 'idle');
  } finally { await session[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); }
});
