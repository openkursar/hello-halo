import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execute } from '../../../scripts/acceptance/lib/process.mjs'

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-cluster-lifecycle-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const write = async (name, contents) => {
    const file = path.join(root, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, contents)
  }
  await write('package.json', JSON.stringify({ name: 'cluster-lifecycle-fixture', type: 'module', main: 'out/main/index.cjs' }))
  await write('tests/decentralized/_lib.mjs', await fs.readFile(fileURLToPath(new URL('../../decentralized/_lib.mjs', import.meta.url))))
  await write('tests/decentralized/_acceptance.mjs', `export { clusterDetached } from ${JSON.stringify(new URL('../../decentralized/_acceptance.mjs', import.meta.url).href)};`)
  await write('scripts/cluster/launch-nodes.mjs', await fs.readFile(fileURLToPath(new URL('../../../scripts/cluster/launch-nodes.mjs', import.meta.url))))
  await write('node_modules/electron/package.json', JSON.stringify({ name: 'electron', main: 'index.cjs' }))
  await write('node_modules/electron/index.cjs', 'module.exports = process.execPath;')
  await write('out/main/index.cjs', `const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const config=JSON.parse(fs.readFileSync(path.join(process.env.HALO_DATA_DIR,'config.json'),'utf8'));http.createServer((_request,response)=>response.end(JSON.stringify({success:true,data:[]}))).listen(config.port,'127.0.0.1');`)
  return { root, write }
}

test('a revived ordinary process is recorded and stopped before the driver exits its owned group', { skip: process.platform === 'win32' }, async context => {
  const { root, write } = await fixture(context)
  await write('driver.mjs', `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { api, clusterStop, killNode, loadManifest, pollUntil, reviveNode } from './tests/decentralized/_lib.mjs';
const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const clusterDir=path.resolve('profiles');const nodeDir=path.join(clusterDir,'node-1');
fs.mkdirSync(path.join(nodeDir,'.halo'),{recursive:true});
fs.writeFileSync(path.join(nodeDir,'.halo/config.json'),JSON.stringify({port}));
const initial=spawn(process.execPath,['out/main/index.cjs'],{stdio:'ignore',env:{...process.env,HALO_DATA_DIR:path.join(nodeDir,'.halo')}});
await once(initial,'spawn');
const node={index:1,pid:initial.pid,port,baseUrl:'http://127.0.0.1:'+port,token:'synthetic-lifecycle',logFile:path.join(nodeDir,'node.log')};
fs.writeFileSync(path.join(clusterDir,'nodes.json'),JSON.stringify({nodes:[node]}));
try {
  assert(await pollUntil(async()=>((await api(node,'GET','/api/teams')).status===200),{timeoutMs:3000,intervalMs:20}));
  const stopped=once(initial,'exit');assert.equal(killNode(node),true);await stopped;
  const originalPid=node.pid;
  const replacement=await reviveNode(node,clusterDir);
  assert(replacement && replacement!==originalPid);
  assert.equal(loadManifest(clusterDir).nodes[0].pid,replacement);
  fs.writeFileSync('replacement.pid',String(replacement));
} finally {clusterStop(clusterDir)}
console.log('Owned replacement lifecycle completed');
`)
  const result = await execute(root, ['driver.mjs'], {
    environment: { HALO_ACCEPTANCE_CLUSTER_RUN: '1', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' },
    timeoutMs: 15000,
  })
  assert.equal(result.code, 0, result.log)
  assert.equal(result.cleanupFailed, false, result.log)
  assert.doesNotMatch(result.log, /runner exited with live descendants/)
  const pid = Number(await fs.readFile(path.join(root, 'replacement.pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('stopping a nonexistent cluster is a no-op but a registered stopper failure is propagated', async context => {
  const { root, write } = await fixture(context)
  await write('scripts/cluster/launch-nodes.mjs', `import fs from 'node:fs';fs.writeFileSync('stop-attempted','yes');process.exit(7);`)
  const { clusterStop } = await import(pathToFileURL(path.join(root, 'tests/decentralized/_lib.mjs')).href)
  const profiles = path.join(root, 'profiles')
  clusterStop(profiles)
  await assert.rejects(fs.access(path.join(root, 'stop-attempted')), { code: 'ENOENT' })
  await write('profiles/nodes.json', JSON.stringify({ nodes: [] }))
  assert.throws(() => clusterStop(profiles), /Cluster stop failed \(7\)/)
  assert.equal(await fs.readFile(path.join(root, 'stop-attempted'), 'utf8'), 'yes')
})

test('a driver that really leaves a descendant remains unsuccessful even when the guard cleans it up', { skip: process.platform === 'win32' }, async context => {
  const { root, write } = await fixture(context)
  await write('leaked-child.cjs', "require('node:fs').writeFileSync('leaked.pid',String(process.pid));setInterval(()=>{},1000);")
  await write('leaking-driver.cjs', "const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['leaked-child.cjs'],{stdio:'ignore'});child.unref();const timer=setInterval(()=>{if(fs.existsSync('leaked.pid')){clearInterval(timer);process.exit(0)}},10);")
  const result = await execute(root, ['leaking-driver.cjs'], { timeoutMs: 5000 })
  assert.equal(result.code, 1)
  assert.equal(result.timedOut, false)
  assert.equal(result.cleanupFailed, false)
  assert.match(result.log, /runner exited with live descendants/)
  const pid = Number(await fs.readFile(path.join(root, 'leaked.pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
