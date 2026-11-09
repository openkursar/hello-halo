import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { killProcessTree } from '../utils/processes.js';
import { createCodeSearchService } from './index.js';
import type { CodeSearchOptions } from './index.js';

let directory: string;
let workerPath: string;
let supervisorPath: string;
let hostPath: string;
let modulePath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(),'halo-search-supervisor-'));
  workerPath = join(directory,'worker.mjs');
  supervisorPath = join(directory,'supervisor.mjs');
  hostPath = join(directory,'host.mjs');
  const common = {bundle:true,platform:'node' as const,format:'esm' as const,target:'node20'};
  await build({...common,entryPoints:[fileURLToPath(new URL('./worker.ts',import.meta.url))],outfile:workerPath});
  await build({...common,entryPoints:[fileURLToPath(new URL('./supervisor.ts',import.meta.url))],outfile:supervisorPath});
  const hostSource = join(directory,'host.ts');
  await writeFile(hostSource, `
    import { createCodeSearchService } from ${JSON.stringify(fileURLToPath(new URL('./index.ts',import.meta.url)))};
    import { setChildProcessObserver } from ${JSON.stringify(fileURLToPath(new URL('../utils/processes.ts',import.meta.url)))};
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const input=JSON.parse(process.argv[2]);
    setChildProcessObserver(child=>writeFileSync(join(input.root,'supervisor.pid'),String(child.pid)));
    await createCodeSearchService(input.options).search({root:input.root,query:'block'});
  `);
  await build({...common,entryPoints:[hostSource],outfile:hostPath});
  modulePath=join(directory,'backend.mjs');
  await writeFile(modulePath, `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    export async function createZvecGrep(){
      let root;
      return {
        async index(options){root=options.rootPaths[0].absolutePath;},
        async context(){
          writeFileSync(join(root,'backend.pid'),String(process.pid));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
          return {items:[]};
        },
        async close(){}
      };
    }
  `);
});
afterAll(async()=>{await rm(directory,{recursive:true,force:true});});

async function configuration():Promise<{root:string;options:CodeSearchOptions}>{
  const dir=await mkdtemp(join(directory,'case-'));
  const root=join(dir,'source');await mkdir(root);
  return {root,options:{backend:'zvec-grep',nodePath:process.execPath,modulePath,workerPath,supervisorPath,cachePath:join(dir,'cache'),timeoutMs:10000}};
}
async function pidAt(file:string):Promise<number>{
  let pid=0;
  await vi.waitFor(async()=>{pid=Number(await readFile(file,'utf8'));expect(pid).toBeGreaterThan(0);},{timeout:5000,interval:10});
  return pid;
}
function running(pid:number):boolean{
  try {
    if(process.platform==='win32'){process.kill(pid,0);return true;}
    const state=execFileSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    return state.length>0&&!state.startsWith('Z');
  } catch {return false;}
}

describe('search supervisor process ownership',()=>{
  it('kills a synchronously blocked backend when its host is killed',async()=>{
    const input=await configuration();
    const host=spawn(process.execPath,[hostPath,JSON.stringify(input)],{stdio:'ignore',windowsHide:true});
    let guardian=0;let backend=0;
    try {
      guardian=await pidAt(join(input.root,'supervisor.pid'));
      backend=await pidAt(join(input.root,'backend.pid'));
      expect(running(backend)).toBe(true);
      const closed=new Promise<void>(resolve=>host.once('close',()=>resolve()));
      host.kill('SIGKILL');await closed;
      await vi.waitFor(()=>{expect(running(guardian)).toBe(false);expect(running(backend)).toBe(false);},{timeout:3000,interval:10});
    } finally {
      host.kill('SIGKILL');
      if(guardian)await killProcessTree(guardian,'SIGKILL');
      if(backend&&running(backend))await killProcessTree(backend,'SIGKILL');
    }
  });

  it('cancels native-style blocking without waiting for the backend event loop',async()=>{
    const input=await configuration();
    const search=createCodeSearchService(input.options);
    const controller=new AbortController();
    const result=search.search({root:input.root,query:'block',signal:controller.signal}).catch(error=>error);
    let backend=0;
    try {
      backend=await pidAt(join(input.root,'backend.pid'));
      controller.abort();
      expect((await result).message).toMatch(/cancelled/);
      await search.dispose();
      await vi.waitFor(()=>expect(running(backend)).toBe(false),{timeout:3000,interval:10});
    } finally {
      await search.dispose();
      if(backend&&running(backend))await killProcessTree(backend,'SIGKILL');
    }
  });
});
