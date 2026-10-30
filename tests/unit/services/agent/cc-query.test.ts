import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const state = vi.hoisted(() => ({ launch: null as any }))
vi.mock('../../../../src/main/services/cc-runtime', () => ({ resolveCcRuntimeLaunch: async () => state.launch }))
import { createCcSdkModule } from '../../../../src/main/services/agent/cc'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'halo-cc-query-'))
  const entry = join(directory, 'cli.cjs')
  writeFileSync(entry, `
const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') write({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{commands:[],models:[]}}});
  if (frame.type === 'user') {
    write({type:'system',subtype:'init',session_id:'query-session'});
    if (frame.uuid) write({...frame,isReplay:true});
    write({type:'result',subtype:'success',session_id:'query-session',result:frame.message.content});
  }
});
`)
  state.launch = { command: process.execPath, argsPrefix: [entry], env: { ELECTRON_RUN_AS_NODE: '1' }, path: entry, kind: 'javascript', version: 'test' }
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const options = () => ({ cwd: directory, env: process.env })

describe('external CC query facade', () => {
  it('returns a single query and retires its process', async () => {
    const frames = []
    for await (const frame of createCcSdkModule().query({ prompt: 'hello', options: options() })) frames.push(frame)
    expect(frames.at(-1)).toMatchObject({ type: 'result', result: [{ type: 'text', text: 'hello' }] })
  })
  it('accepts a later input after a result while the producer is still open', async () => {
    let release!: () => void
    const firstResult = new Promise<void>(resolve => { release = resolve })
    async function* prompt() { yield 'first'; await firstResult; yield 'second' }
    const results = []
    for await (const frame of createCcSdkModule().query({ prompt: prompt(), options: options() })) {
      if (frame.type === 'result') { results.push(frame); release() }
    }
    expect(results).toHaveLength(2)
    expect(results[1].result).toEqual([{ type: 'text', text: 'second' }])
  })
  it('finishes an empty input stream without waiting for a result', async () => {
    async function* prompt() {}
    const frames = []
    for await (const frame of createCcSdkModule().query({ prompt: prompt(), options: options() })) frames.push(frame)
    expect(frames).toEqual([])
  })
  it('propagates a producer failure and closes its process', async () => {
    async function* prompt(): AsyncGenerator<string> { throw new Error('input failed') }
    const query = createCcSdkModule().query({ prompt: prompt(), options: options() })
    await expect(query.next()).rejects.toThrow('input failed')
  })
})
