import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeProvider } from '../../../src/main/services/external-runtime/provider'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getHaloDir: () => globalThis.__HALO_TEST_DIR__ }))
import { createRuntimeProbe } from '../../../src/main/services/external-runtime/probe'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('unreapable external runtime probes', () => {
  it('settles after hard-kill grace and reports cleanup as unconfirmed exactly once', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: 12345, exitCode: null, signalCode: null,
      kill: vi.fn(() => true), unref: vi.fn()
    })
    mocks.spawn.mockReturnValue(child)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = {
      id: 'codex', directoryName: 'codex',
      resolveCandidate: async (path: string) => ({ path, resolvedPath: path, stamp: path,
        launch: { command: path, path, argsPrefix: [], env: {}, kind: 'native' } }),
      probe: async (_candidate: unknown, run: (request: { args: string[] }) => Promise<string>) => { await run({ args: ['--version'] }); return '1.0.0' },
      isRecommendedVersion: () => false, isVerifiedRuntime: () => false
    } as unknown as RuntimeProvider
    const probe = createRuntimeProbe(provider)
    const controller = new AbortController()
    const pending = probe.checkInstallation('/unreapable', { signal: controller.signal })
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())
    vi.useFakeTimers()
    controller.abort()
    await vi.advanceTimersByTimeAsync(2000)
    vi.useRealTimers()
    await expect(pending).resolves.toMatchObject({ compatibility: 'unavailable', issue: 'cancelled' })
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(child.unref).toHaveBeenCalledOnce()
    expect(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true)
    expect(warning.mock.calls.filter(call => call[0] === '[ExternalRuntime] Probe cleanup unconfirmed after termination deadline')).toEqual([
      ['[ExternalRuntime] Probe cleanup unconfirmed after termination deadline', { pid: 12345, issue: 'process-failed' }]
    ])
    child.emit('exit')
    child.emit('close', null)
    await probe.shutdownProbes()
    expect(child.unref).toHaveBeenCalledOnce()
  })
})
