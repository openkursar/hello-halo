import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CcRuntimeLaunch } from '../../../../src/shared/types/cc-runtime'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn,
}))
import { CcSession } from '../../../../src/main/services/agent/cc/session'

const sessions: CcSession[] = []
beforeEach(() => {
  spawn.mockReset().mockImplementation(() => {
    const child = new EventEmitter() as any
    child.pid = 1234
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        const frame = JSON.parse(chunk.toString())
        if (frame.type === 'control_request') queueMicrotask(() => {
          child.stdout.write(JSON.stringify({ type: 'control_response', response: {
            subtype: 'success', request_id: frame.request_id, response: { commands: [], models: [] },
          } }) + '\n')
        })
        done()
      },
      final(done) {
        done()
        queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0, null) })
      },
    })
    child.kill = vi.fn(() => true)
    return child
  })
})
afterEach(async () => {
  for (const session of sessions.splice(0)) { session.close(); await session.flush() }
})

describe('external CC console policy', () => {
  it.each(['native', 'javascript'] as const)('hides the Halo-owned %s process and retains its explicit environment', async kind => {
    const launch: CcRuntimeLaunch = {
      kind,
      command: kind === 'native' ? 'C:\\Tools With Spaces\\claude.exe' : 'C:\\Halo Next\\Halo Next.exe',
      argsPrefix: kind === 'javascript' ? ['C:\\Custom CC\\cli.js'] : [],
      env: kind === 'javascript' ? { ELECTRON_RUN_AS_NODE: '1' } : {},
      path: 'C:\\Custom CC', version: '2.1.310',
    }
    const env = { PATH: 'C:\\Windows\\System32', HTTPS_PROXY: 'http://127.0.0.1:8000', ELECTRON_RUN_AS_NODE: '1' }
    const session = new CcSession({ cwd: 'C:\\Workspace With Spaces', env, model: 'test-model' }, launch)
    sessions.push(session)
    await session.ready()
    const [command, args, options] = spawn.mock.calls[0]
    expect(command).toBe(launch.command)
    expect(args.slice(0, launch.argsPrefix.length)).toEqual(launch.argsPrefix)
    expect(args).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--model', 'test-model']))
    expect(options).toMatchObject({ windowsHide: true, cwd: 'C:\\Workspace With Spaces', stdio: 'pipe' })
    expect(options.shell).not.toBe(true)
    expect(options.env.PATH).toBe(env.PATH)
    expect(options.env.HTTPS_PROXY).toBe(env.HTTPS_PROXY)
    expect(options.env.DISABLE_AUTOUPDATER).toBe('1')
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe(kind === 'javascript' ? '1' : undefined)
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})
