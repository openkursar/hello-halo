import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, cp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const enabled = process.env.HALO_WORKER_ELECTRON_E2E === '1'

describe.skipIf(!enabled)('packaged SDK worker in real Electron', () => {
  it('starts the unpacked worker and host setup from an asar application', async () => {
    const root = resolve(__dirname, '../../../../..')
    const temp = await mkdtemp(join(tmpdir(), 'halo-worker-asar-'))
    const source = join(temp, 'source')
    try {
      const sdk = join(source, 'node_modules/@hello-halo/agent-sdk')
      await mkdir(sdk, { recursive: true })
      await promisify(execFile)(process.execPath, [require.resolve('typescript/bin/tsc'),
        '--project', join(root, 'src/sdk/halo-sdk/tsconfig.json'), '--outDir', join(sdk, 'dist')], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000,
      })
      const { buildWorker } = await import(/* @vite-ignore */ pathToFileURL(join(root, 'src/sdk/halo-sdk/scripts/build-worker.mjs')).href)
      await buildWorker(join(sdk, 'dist/worker/entry.js'))
      await cp(join(root, 'src/sdk/halo-sdk/package.json'), join(sdk, 'package.json'))
      await mkdir(join(source, 'out/main/worker'), { recursive: true })
      await require('esbuild').build({ entryPoints: [join(root, 'src/main/services/agent/halo/worker-setup.ts')],
        outfile: join(source, 'out/main/worker/halo-setup.cjs'), bundle: true, platform: 'node', format: 'cjs' })
      await cp(join(root, 'src/sdk/halo-sdk/worker/fixtures/setup.mjs'), join(source, 'fixture-setup.mjs'))
      await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'worker-smoke', version: '1.0.0', main: 'main.cjs' }))
      await writeFile(join(source, 'main.cjs'), `
const { app } = require('electron');
const { createServer } = require('node:http');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const profile=join(require('node:path').dirname(__dirname),'profile');
require('node:fs').mkdirSync(profile,{recursive:true});
app.setPath('userData',profile);
app.setPath('sessionData',profile);
app.whenReady().then(async () => {
  let runtime;
  let request;
  const server = createServer((req,res) => {
    let body=''; req.on('data', chunk => body+=chunk);
    req.on('end', () => {
      request={headers:req.headers,body:JSON.parse(body)};
      res.writeHead(200,{'content-type':'text/event-stream'});
      const events=[
        {type:'message_start',message:{id:'fixture',type:'message',role:'assistant',model:'test-model',content:[],usage:{input_tokens:10,output_tokens:0}}},
        {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'worker reply'}},
        {type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}},
        {type:'message_stop'}];
      res.end(events.map(event=>'event: '+event.type+'\\ndata: '+JSON.stringify(event)+'\\n\\n').join(''));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const sdk=await import(pathToFileURL(join(__dirname,'node_modules/@hello-halo/agent-sdk/dist/worker/index.js')).href);
    runtime=sdk.createWorkerRuntime({workerUrl:new URL(sdk.getWorkerEntryUrl().href.replace('.asar/','.asar.unpacked/')),maxWorkers:1});
    await runtime.initialize();
    const session=await runtime.createSession({model:'test-model',apiKey:'fixture',anthropicBaseUrl:'http://127.0.0.1:'+server.address().port,
      cwd:profile,env:{HOME:profile,USERPROFILE:profile,CLAUDE_CONFIG_DIR:profile},tools:[],settingSources:[],persistSession:false,systemPrompt:'Test',turnEndChecks:{openWork:false,completion:false}},
      {setup:{module:pathToFileURL(join(__dirname.replace('.asar','.asar.unpacked'),'out/main/worker/halo-setup.cjs')).href,
        data:{deviceId:'test-device',sessionId:'test-session'}}});
    await session.send('hello');
    let result;
    for await(const event of session.stream()) if(event.type==='result') result=event;
    await session[Symbol.asyncDispose]();
    const diagnostics=runtime.diagnostics();
    await runtime.close();
    runtime=sdk.createWorkerRuntime({workerUrl:new URL(sdk.getWorkerEntryUrl().href.replace('.asar/','.asar.unpacked/')),
      maxWorkers:1,heartbeatIntervalMs:25,heartbeatTimeoutMs:300});
    const stuck=await runtime.createSession({model:'test-model',cwd:profile,env:{HOME:profile,USERPROFILE:profile,CLAUDE_CONFIG_DIR:profile},
      persistSession:false,tools:[],settingSources:[],systemPrompt:'Test'},
      {setup:{module:pathToFileURL(join(__dirname.replace('.asar','.asar.unpacked'),'fixture-setup.mjs')).href,data:{hang:true}}});
    let ticks=0,failure=''; const timer=setInterval(()=>ticks++,10);
    try {await stuck.send('hang');for await(const event of stuck.stream()) {}}
    catch(error) {failure=error.message;}
    finally {clearInterval(timer);}
    await runtime.close();
    console.log('WORKER_SMOKE '+JSON.stringify({result:result.result,userAgent:request.headers['user-agent'],prefix:request.body.system[0].text,
      sessionHeader:request.headers['x-claude-code-session-id'],diagnostics,ticks,failure}));
    server.close(); app.exit(0);
  } catch(error) { console.error(error); if(runtime) await runtime.close();server.close();app.exit(1); }
});
`)
      const archive = join(temp, 'app.asar')
      const packageRules = require(join(root, 'package.json')).build.asarUnpack as string[]
      await require('@electron/asar').createPackageWithOptions(source, archive, {
        unpack: `{${[...packageRules.map(rule => `**/${rule}`), '**/fixture-setup.mjs'].join(',')}}`,
      })
      const filesystem = process.versions.electron ? require('original-fs') : require('node:fs')
      expect(filesystem.existsSync(join(archive + '.unpacked', 'node_modules/@hello-halo/agent-sdk/dist/worker/entry.js'))).toBe(true)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(require('electron'), [archive], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let text = ''
        child.stdout.on('data', chunk => { text += chunk })
        child.stderr.on('data', chunk => { text += chunk })
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Electron worker timed out: ${text.slice(-2000)}`)) }, 25_000)
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(text) : reject(new Error(text.slice(-3000))) })
      })
      const line = output.split('\n').find(line => line.startsWith('WORKER_SMOKE '))!
      const report = JSON.parse(line.slice('WORKER_SMOKE '.length))
      expect(report.result).toBe('worker reply')
      expect(report.userAgent).toMatch(/^claude-cli\//)
      expect(report.prefix).toContain('x-anthropic-billing-header:')
      expect(report.sessionHeader).toBe('test-session')
      expect(report.diagnostics.workers[0].sessions).toBe(0)
      expect(report.ticks).toBeGreaterThan(3)
      expect(report.failure).toContain('heartbeat')
    } finally {
      const filesystem = process.versions.electron ? require('original-fs') : require('node:fs')
      await filesystem.promises.rm(temp, { recursive: true, force: true, maxRetries: 3 })
    }
  }, 90_000)
})
