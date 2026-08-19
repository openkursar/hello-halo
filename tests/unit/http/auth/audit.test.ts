/**
 * Audit log rotation tests. rotateIfNeeded rotates the active log once it
 * reaches MAX_SIZE_BYTES (5 MiB), shifting .1 -> .2 -> .3 from the top down
 * and renaming the active file to .1. Rename failures are best-effort and
 * must never propagate out of the auth path.
 *
 * `fs` is fully mocked so file sizes and rename outcomes are scripted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const MAX_SIZE_BYTES = 5 * 1024 * 1024

const existsSync = vi.fn()
const statSync = vi.fn()
const renameSync = vi.fn()
const mkdirSync = vi.fn()
const appendFile = vi.fn(() => Promise.resolve())

vi.mock('fs', () => ({
  existsSync,
  statSync,
  renameSync,
  mkdirSync,
  promises: {
    appendFile: (...args: unknown[]) => appendFile(...args),
  },
}))

// logAuthEvent resolves the log path lazily on first call and caches it in
// module state. Reset the module before each test so the mkdir/exists path
// is re-evaluated against fresh mock scripting.
beforeEach(() => {
  vi.resetModules()
  existsSync.mockReset()
  statSync.mockReset()
  renameSync.mockReset()
  mkdirSync.mockReset()
  appendFile.mockReset()
  appendFile.mockResolvedValue(undefined)
})

async function loadAudit() {
  return (await import('../../../../src/main/http/auth/audit')).logAuthEvent
}

describe('audit rotateIfNeeded', () => {
  it('does not rotate when the active log does not exist', async () => {
    // First existsSync call (getLogPath dir check) -> true; log file -> false.
    existsSync.mockImplementation((p: string) => !p.endsWith('.log'))
    const log = await loadAudit()

    log('login_success', { ip: '1.1.1.1' })

    expect(renameSync).not.toHaveBeenCalled()
    expect(appendFile).toHaveBeenCalledTimes(1)
  })

  it('does not rotate when the active log is below the threshold', async () => {
    existsSync.mockReturnValue(true)
    statSync.mockReturnValue({ size: MAX_SIZE_BYTES - 1 })
    const log = await loadAudit()

    log('login_fail', { ip: '2.2.2.2' })

    expect(renameSync).not.toHaveBeenCalled()
  })

  it('rotates at exactly MAX_SIZE_BYTES, shifting .1 -> .2 -> .3 and active -> .1', async () => {
    // Log + all rotated files exist so every shift branch runs.
    existsSync.mockReturnValue(true)
    statSync.mockReturnValue({ size: MAX_SIZE_BYTES })
    const log = await loadAudit()

    log('lockout_start', { ip: '3.3.3.3', reason: 'ip' })

    const calls = renameSync.mock.calls.map((c) => [
      (c[0] as string).replace(/^.*auth-audit/, 'auth-audit'),
      (c[1] as string).replace(/^.*auth-audit/, 'auth-audit'),
    ])
    // Top-down shift preserves the newest rotated file; order matters so a
    // later rename never overwrites a file a subsequent rename still needs.
    expect(calls).toEqual([
      ['auth-audit.log.2', 'auth-audit.log.3'],
      ['auth-audit.log.1', 'auth-audit.log.2'],
      ['auth-audit.log', 'auth-audit.log.1'],
    ])
  })

  it('swallows a rename error during rotation and still appends the entry', async () => {
    existsSync.mockReturnValue(true)
    statSync.mockReturnValue({ size: MAX_SIZE_BYTES })
    renameSync.mockImplementation(() => {
      throw new Error('EPERM')
    })
    const log = await loadAudit()

    expect(() => log('login_blocked', { ip: '4.4.4.4' })).not.toThrow()
    expect(appendFile).toHaveBeenCalledTimes(1)
  })

  it('returns without rotating when statSync throws', async () => {
    existsSync.mockReturnValue(true)
    statSync.mockImplementation(() => {
      throw new Error('EACCES')
    })
    const log = await loadAudit()

    log('login_success', { ip: '5.5.5.5' })

    expect(renameSync).not.toHaveBeenCalled()
    expect(appendFile).toHaveBeenCalledTimes(1)
  })
})
