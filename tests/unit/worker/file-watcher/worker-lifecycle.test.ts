/**
 * Worker entry lifecycle: when the fork IPC channel closes without SIGTERM
 * (main crashed or was force-quit) the worker stops its watchers and exits
 * instead of living on as an orphan. The real entry runs in its own forked
 * process so the test runner's IPC channel is never touched.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'

const repository = resolve(__dirname, '../../../..')
let directory: string
let entry: string
let worker: ChildProcess | undefined

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'file-watcher-lifecycle-'))
  entry = join(directory, 'worker.cjs')
  await build({
    entryPoints: [join(repository, 'src/worker/file-watcher/index.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['@parcel/watcher'],
    logLevel: 'silent',
  })
})

afterEach(() => {
  if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL')
  worker = undefined
})

afterAll(() => { rmSync(directory, { recursive: true, force: true }) })

interface Worker { child: ChildProcess; errors: () => string }

function spawnWorker(root: string): Worker {
  const child = fork(entry, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_PATH: join(repository, 'node_modules') },
  })
  worker = child
  let errors = ''
  child.stdout!.resume()
  child.stderr!.on('data', chunk => { errors += String(chunk) })
  child.send({ type: 'init-space', spaceId: 'lifecycle', rootPath: root })
  return { child, errors: () => errors }
}

async function startWatchingWorker(root: string): Promise<Worker> {
  const started = spawnWorker(root)
  await new Promise<void>((resolveActive, reject) => {
    let output = ''
    started.child.stdout!.on('data', chunk => {
      output += String(chunk)
      if (output.includes('Active for space')) resolveActive()
    })
    started.child.once('exit', code => reject(new Error(`Worker exited before watching (code=${code})`)))
  })
  return started
}

async function exitWithin(child: ChildProcess, trigger: () => void) {
  const exited = once(child, 'exit')
  trigger()
  const [code, signal] = await Promise.race([
    exited,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Worker outlived its host channel')), 5000)),
  ])
  return { code, signal }
}

describe('file-watcher worker lifecycle', () => {
  it('stops watching and exits with a failure code when the channel to its host closes', async () => {
    const { child, errors } = await startWatchingWorker(mkdtempSync(join(directory, 'space-')))
    expect(await exitWithin(child, () => child.disconnect())).toEqual({ code: 1, signal: null })
    expect(errors()).toBe('')
  }, 20000)

  it('exits without crashing when file events are still being delivered as the channel closes', async () => {
    const root = mkdtempSync(join(directory, 'space-'))
    const { child, errors } = await startWatchingWorker(root)
    for (let index = 0; index < 20; index++) writeFileSync(join(root, `change-${index}.txt`), String(index))
    expect(await exitWithin(child, () => child.disconnect())).toEqual({ code: 1, signal: null })
    expect(errors()).toBe('')
  }, 20000)

  it('exits without crashing when the channel closes while it is still answering', async () => {
    for (let delay = 0; delay < 20; delay++) {
      const { child, errors } = spawnWorker(mkdtempSync(join(directory, 'space-')))
      const outcome = await exitWithin(child, () => { setTimeout(() => { if (child.connected) child.disconnect() }, delay) })
      // A clean disconnect and an EPIPE crash both exit 1; only the empty stderr tells them apart.
      expect({ delay, ...outcome, errors: errors() }).toEqual({ delay, code: 1, signal: null, errors: '' })
    }
  }, 60000)

  it('still stops with success on SIGTERM', async () => {
    const { child } = await startWatchingWorker(mkdtempSync(join(directory, 'space-')))
    expect(await exitWithin(child, () => child.kill('SIGTERM'))).toEqual({ code: 0, signal: null })
  }, 20000)
})
