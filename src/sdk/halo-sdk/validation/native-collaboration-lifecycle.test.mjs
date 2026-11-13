import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist/', import.meta.url));
const nativeModule = name => pathToFileURL(join(compiled, 'native', name)).href;
const { createTurnGate } = await import(nativeModule('turn-gate.js'));
const { createSession } = await import(nativeModule('session.js'));
const { loadBinding } = await import(nativeModule('binding.js'));

function ready(worker) {
  return new Promise((resolve, reject) => {
    worker.once('message', message => message?.error ? reject(new Error(message.error)) : resolve(message));
    worker.once('error', reject);
    worker.once('exit', code => reject(new Error(`Worker exited before setup: ${code}`)));
  });
}
const workerSource = body => `const {parentPort,workerData}=require('node:worker_threads'); (async()=>{${body}})().catch(error=>parentPort.postMessage({error:error.stack??String(error)}));`;
const capabilities = () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' });
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test('terminating one Node environment cancels an unresolved native gate callback without stopping another environment', { timeout: 10_000 }, async () => {
  const worker = new Worker(workerSource(`
    const {createTurnGate}=await import(workerData.module);
    const gate=createTurnGate({isBusy:()=>false,dispatch:()=>new Promise(()=>{})});
    void gate.deliver('blocked',{content:'owned callback'}).catch(()=>{});
    parentPort.postMessage({ready:true});
    parentPort.on('message',()=>{});
  `), { eval: true, workerData: { module: nativeModule('turn-gate.js') } });
  const seen = [];
  const gate = createTurnGate({ isBusy: () => false, async dispatch(_key, job) { seen.push(job); } });
  try {
    await ready(worker);
    await worker.terminate();
    assert.equal(await gate.deliver('survivor', { content: 'still available' }), 'dispatched');
    gate.release('survivor');
    assert.deepEqual(seen, [{ content: 'still available' }]);
  } finally { await worker.terminate(); }
});

test('standalone collaboration environment teardown kills only its owned child process and leaves another session usable', { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'halo-native-collaboration-teardown-'));
  const marker = join(directory, 'child.pid');
  const evidence = join(directory, 'survivor.txt');
  let worker;
  let main;
  let pid;
  let requests = 0;
  const provider = { id: 'surviving-fixture', name: 'Surviving fixture', capabilities,
    async createMessage() { throw new Error('Unexpected completion request'); },
    async *createMessageStream(request) {
      const step = ++requests;
      const block = step === 1 ? { type: 'tool_use', id: 'write', name: 'Write', input: { file_path: evidence, content: 'another environment survived' } } : { type: 'text', text: '' };
      yield { type: 'message_start', id: `survivor-${step}`, model: request.model, usage: { input_tokens: 1, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: block };
      if (block.type === 'text') yield { type: 'text_delta', index: 0, text: 'Verified.' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', usage: { output_tokens: 1 } };
      yield { type: 'message_stop' };
    },
  };
  try {
    main = await createSession({ model: 'fixture', provider, cwd: directory, persistSession: false, collaboration: false, permissionMode: 'bypassPermissions', tools: ['Write'], thinking: { type: 'disabled' }, systemPrompt: 'Surviving environment fixture.' });
    const command = `${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`)}`;
    worker = new Worker(workerSource(`
      const fs=require('node:fs/promises');
      const {createSdkCollaboration}=await import(workerData.module);
      const caps=${capabilities.toString()};
      const provider={id:'blocked-fixture',name:'Blocked fixture',capabilities:caps,async createMessage(){throw Error('Unexpected completion');},async *createMessageStream(request){
        yield {type:'message_start',id:'blocked',model:request.model,usage:{input_tokens:1,output_tokens:0}};
        yield {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'owned-process',name:'Bash',input:{command:workerData.command,timeout:120000}}};
        yield {type:'content_block_stop',index:0};
        await new Promise(()=>{});
      }};
      const binding=createSdkCollaboration({sessionId:'worker-source',getOptions:()=>({model:'fixture',provider,cwd:workerData.directory,env:{HOME:workerData.directory,MARKER:workerData.marker},persistSession:false,permissionMode:'bypassPermissions',tools:['Bash','spawn_agent'],thinking:{type:'disabled'},systemPrompt:'Owned process fixture.'}),async deliverToSource(){return 'buffered';}});
      const created=await binding.server.instance.callTool('spawn_agent',{name:'runner',prompt:'Start the owned process.'});
      if(created.isError)throw Error(JSON.stringify(created));
      let pid;
      for(let i=0;i<1000;i++){try{pid=Number(await fs.readFile(workerData.marker,'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,5));}}
      if(!pid)throw Error('Owned process did not start');
      parentPort.postMessage({pid}); parentPort.on('message',()=>{});
    `), { eval: true, workerData: { module: nativeModule('collaboration-sdk.js'), directory, marker, command } });
    ({ pid } = await ready(worker));
    process.kill(pid, 0);
    assert.equal(JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions, 2);
    await worker.terminate();
    let alive = true;
    for (let attempt = 0; attempt < 200 && alive; attempt++) {
      try { process.kill(pid, 0); await delay(5); }
      catch (error) { assert.equal(error.code, 'ESRCH'); alive = false; }
    }
    assert.equal(alive, false);
    pid = undefined;
    for (let attempt = 0; attempt < 200 && JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions !== 1; attempt++) await delay(5);
    assert.equal(JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions, 1);
    await main.send('Write survivor.txt after the other environment closes.');
    for await (const event of main.stream()) if (event.type === 'result') assert.equal(event.subtype, 'success', event.result);
    assert.equal(await readFile(evidence, 'utf8'), 'another environment survived');
  } finally {
    await worker?.terminate();
    await main?.[Symbol.asyncDispose]();
    if (pid) {
      try {
        const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'command=']);
        if (stdout.includes(marker)) process.kill(pid, 'SIGKILL');
      } catch (error) { if (error.code !== 'ESRCH' && error.code !== 1) throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions, 0);
});

test('standalone collaboration keeps accepted work alive and lets an idle process exit without disposal', { timeout: 15_000 }, async () => {
  const module = nativeModule('collaboration-sdk.js');
  const source = `
    import assert from 'node:assert/strict';
    const {createSdkCollaboration}=await import(${JSON.stringify(module)});
    let notify;
    const completed=new Promise(resolve=>{notify=resolve;});
    let requests=0;
    const provider={id:'activity-fixture',name:'Activity fixture',capabilities:${capabilities.toString()},
      async createMessage(){throw Error('Unexpected completion request');},
      async *createMessageStream(request){
        requests++;
        yield {type:'message_start',id:'activity',model:request.model,usage:{input_tokens:1,output_tokens:0}};
        yield {type:'content_block_start',index:0,content_block:{type:'text',text:''}};
        yield {type:'text_delta',index:0,text:'Activity delivered.'};
        yield {type:'content_block_stop',index:0};
        yield {type:'message_delta',stopReason:'end_turn',usage:{output_tokens:1}};
        yield {type:'message_stop'};
      }
    };
    const binding=createSdkCollaboration({sessionId:'activity-source',getOptions:()=>({model:'fixture',provider,persistSession:false,
      tools:['spawn_agent'],permissionMode:'bypassPermissions',systemPrompt:'Activity fixture.',thinking:{type:'disabled'}}),
      async deliverToSource(envelope){assert.match(envelope.body,/Activity delivered/);notify();return 'buffered';}});
    assert.equal(binding.activeCount,0);
    if(process.argv[1]==='active'){
      const result=await binding.server.instance.callTool('spawn_agent',{name:'reader',prompt:'Finish the delegated work.'});
      assert.notEqual(result.isError,true);
      await completed;
      for(;;){const revision=binding.revision;if(binding.activeCount===0)break;await binding.waitForChange(revision);}
      assert.equal(requests,1);
    }
    process.stdout.write('settled:'+process.argv[1]);
  `;
  for (const mode of ['idle', 'active']) {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, mode], { timeout: 5000 });
    assert.equal(stdout, `settled:${mode}`);
  }
});

test('an idle standalone collaborator keeps owned background output alive until its pipes finish', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'halo-native-background-activity-'));
  const evidence = join(directory, 'completed.txt');
  const temporary = join(directory, 'tmp'); await mkdir(temporary);
  const module = nativeModule('collaboration-sdk.js');
  const command = `${quote(process.execPath)} -e ${quote(`setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(evidence)},'background completed');process.stdout.write('flushed');},400)`)}`;
  const source = `
    import assert from 'node:assert/strict';
    const {createSdkCollaboration}=await import(${JSON.stringify(module)});
    let notify;
    const completed=new Promise(resolve=>{notify=resolve;});
    let requests=0;
    const provider={id:'background-activity-fixture',name:'Background activity fixture',capabilities:${capabilities.toString()},
      async createMessage(){throw Error('Unexpected completion request');},
      async *createMessageStream(request){
        const step=++requests;
        const block=step===1?{type:'tool_use',id:'background',name:'Bash',input:{command:${JSON.stringify(command)},run_in_background:true}}:{type:'text',text:''};
        yield {type:'message_start',id:'background-'+step,model:request.model,usage:{input_tokens:1,output_tokens:0}};
        yield {type:'content_block_start',index:0,content_block:block};
        if(block.type==='text')yield {type:'text_delta',index:0,text:'Model finished before background output.'};
        yield {type:'content_block_stop',index:0};
        yield {type:'message_delta',stopReason:block.type==='tool_use'?'tool_use':'end_turn',usage:{output_tokens:1}};
        yield {type:'message_stop'};
      }
    };
    const binding=createSdkCollaboration({sessionId:'background-source',getOptions:()=>({model:'fixture',provider,cwd:${JSON.stringify(directory)},env:{HOME:${JSON.stringify(directory)}},persistSession:false,
      tools:['Bash','spawn_agent'],permissionMode:'bypassPermissions',systemPrompt:'Background activity fixture.',thinking:{type:'disabled'}}),
      async deliverToSource(){notify();return 'buffered';}});
    const result=await binding.server.instance.callTool('spawn_agent',{name:'writer',prompt:'Start background work and finish the model turn.'});
    assert.notEqual(result.isError,true);
    await completed;
    for(;;){const revision=binding.revision;if(binding.activeCount===0)break;await binding.waitForChange(revision);}
    assert.equal(requests,2);
    process.stdout.write('model-idle');
  `;
  let pending;
  try {
    const env = { HOME: directory, TMPDIR: temporary, TEMP: temporary, TMP: temporary, SDK_SYNTHETIC_SECRET: 'synthetic-shell-state' };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
    pending = promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { timeout: 7000, env });
    const { stdout } = await pending;
    assert.match(stdout, /model-idle$/);
    assert.equal(await readFile(evidence, 'utf8'), 'background completed');
    assert.deepEqual((await readdir(temporary)).filter(name => /^agent-shell-.*\.state$/.test(name)), []);
  } finally { await pending?.catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
