/**
 * What a starting build does with the state file a staged update left behind.
 *
 * The helper stays alive while it waits for the new version's confirmation, so
 * "helper still running" is the normal case on a successful update's first
 * start. Confirming must not be gated on the helper having exited, or every
 * update applied by a helper that records its pid rolls back after the timeout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const OUR_VERSION = '2.1.16-dev.0-rc.35'
let root = ''

const quit = vi.fn()
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'exe' ? join(root, 'Halo.exe') : join(root, 'logs')),
    getVersion: () => OUR_VERSION,
    quit: () => quit(),
  },
}))
vi.mock('../../../../src/main/foundation/product-config', () => ({
  loadProductConfig: () => ({}),
  getUpdateChannel: () => 'experience',
  getUpdateManifestPublicKey: () => 'a-key',
}))
const launchRollback = vi.fn(async () => undefined)
vi.mock('../../../../src/main/services/updater/staged/helper', () => ({
  EXPECTED_HELPER_VERSION: 1,
  launchApply: vi.fn(),
  launchRollback: () => launchRollback(),
  readHelperVersion: vi.fn(),
  stagePackage: vi.fn(),
}))

const { reconcileStagedUpdateOnStartup } = await import('../../../../src/main/services/updater/staged')

const workDir = () => join(root, '.halo-update')
const confirmFile = () => join(workDir(), `confirmed-${OUR_VERSION}.ok`)

function writeState(state: Record<string, unknown>): void {
  mkdirSync(workDir(), { recursive: true })
  writeFileSync(join(workDir(), 'state.json'), JSON.stringify(state), 'utf8')
}

// A pid that is certainly not running: above the default pid ceilings.
const DEAD_PID = 2 ** 30

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'halo-reconcile-'))
  quit.mockClear()
  launchRollback.mockClear()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('reconcileStagedUpdateOnStartup', () => {
  it('confirms the installed version while the helper is still waiting for it', async () => {
    writeState({ phase: 'awaiting-confirm', version: OUR_VERSION, helperPid: process.pid })

    await reconcileStagedUpdateOnStartup()

    expect(existsSync(confirmFile())).toBe(true)
    expect(launchRollback).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('confirms when the state predates the recorded helper pid', async () => {
    writeState({ phase: 'awaiting-confirm', version: OUR_VERSION })

    await reconcileStagedUpdateOnStartup()

    expect(existsSync(confirmFile())).toBe(true)
  })

  it('leaves a mid-swap install directory to a running helper', async () => {
    writeState({ phase: 'swapping', version: OUR_VERSION, helperPid: process.pid })

    await reconcileStagedUpdateOnStartup()

    expect(existsSync(confirmFile())).toBe(false)
    expect(launchRollback).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('does not confirm for a different version, and leaves it to a running helper', async () => {
    writeState({ phase: 'awaiting-confirm', version: '2.1.16-dev.0-rc.36', helperPid: process.pid })

    await reconcileStagedUpdateOnStartup()

    expect(existsSync(confirmFile())).toBe(false)
    expect(launchRollback).not.toHaveBeenCalled()
  })

  it('rolls back an interrupted swap once its helper is gone', async () => {
    writeState({ phase: 'swapping', version: OUR_VERSION, helperPid: DEAD_PID })

    await reconcileStagedUpdateOnStartup()

    expect(existsSync(confirmFile())).toBe(false)
    expect(launchRollback).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
