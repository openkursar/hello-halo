/**
 * A session's CLI tool set stays pinned while the session runs: `createSession`
 * and `query` hold the session's `HALO_CLI_TOOLS_BIN` and let go only once the
 * engine has closed it, or when starting it fails.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const BIN = '/cli/views/abc/bin'
const holds: string[] = []
const releases: string[] = []
let createFails = false
let closeResult: Promise<void> = Promise.resolve()

vi.mock('../../../../src/main/foundation/config.service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getConfig: () => ({ agent: { sdkEngine: 'halo' } }) }
})
vi.mock('../../../../src/main/services/agent/engine-availability', () => ({
  getEngineAvailability: async () => [{ engineId: 'halo', available: true, version: '1.0.0', fingerprint: 'abcdef123456' }],
}))
vi.mock('../../../../src/main/services/agent/engine-migration', () => ({ resolveHistoricalEngine: (engine: string) => engine }))
vi.mock('../../../../src/main/services/agent/cc', () => ({
  createCcSdkModule: () => ({ tool: () => undefined, createSdkMcpServer: () => undefined, query: () => undefined }),
}))
vi.mock('@hello-halo/agent-sdk/worker', () => ({ setLogger: () => undefined }))
vi.mock('../../../../src/main/services/agent/halo', () => ({
  createHaloSdkModule: () => ({
    tool: () => undefined,
    createSdkMcpServer: () => undefined,
    createSession: async () => {
      if (createFails) throw new Error('engine refused')
      return { close: () => closeResult }
    },
    query: async function* () { yield { type: 'result' } },
  }),
}))
vi.mock('../../../../src/main/services/cli-tools', () => ({
  CLI_TOOLS_BIN_ENV: 'HALO_CLI_TOOLS_BIN',
  holdCliTools: (binDir: string | undefined) => {
    if (!binDir) return () => undefined
    holds.push(binDir)
    return () => { releases.push(binDir) }
  },
}))

async function freshSdk() {
  vi.resetModules()
  const sdk = await import('../../../../src/main/services/agent/resolved-sdk')
  await sdk.initSdk()
  return sdk
}

describe('resolved-sdk: CLI tool holds', () => {
  beforeEach(() => {
    holds.length = 0
    releases.length = 0
    createFails = false
    closeResult = Promise.resolve()
  })

  it('holds the tool set until the session has closed', async () => {
    const sdk = await freshSdk()
    let finishClose!: () => void
    closeResult = new Promise(resolve => { finishClose = resolve })
    const session = await sdk.createSession({ engineId: 'halo', env: { HALO_CLI_TOOLS_BIN: BIN } })
    expect(holds).toEqual([BIN])
    expect(releases).toEqual([])
    session.close()
    await Promise.resolve()
    expect(releases).toEqual([])
    finishClose()
    await session.flush()
    expect(releases).toEqual([BIN])
    session.close()
    expect(releases).toEqual([BIN])
  })

  it('releases the hold when the session cannot start', async () => {
    const sdk = await freshSdk()
    createFails = true
    await expect(sdk.createSession({ engineId: 'halo', env: { HALO_CLI_TOOLS_BIN: BIN } })).rejects.toThrow('engine refused')
    expect(holds).toEqual([BIN])
    expect(releases).toEqual([BIN])
  })

  it('holds nothing for a session without tools', async () => {
    const sdk = await freshSdk()
    const session = await sdk.createSession({ engineId: 'halo', env: {} })
    session.close()
    await session.flush()
    expect(holds).toEqual([])
    expect(releases).toEqual([])
  })

  it('holds the tool set for the length of a query', async () => {
    const sdk = await freshSdk()
    const seen: unknown[] = []
    for await (const message of sdk.query({ prompt: 'hi', options: { engineId: 'halo', env: { HALO_CLI_TOOLS_BIN: BIN } } })) {
      seen.push(message)
      expect(releases).toEqual([])
    }
    expect(seen).toHaveLength(1)
    expect(holds).toEqual([BIN])
    expect(releases).toEqual([BIN])
  })
})
