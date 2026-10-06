/**
 * A local connection refused by security software: the engine's bare
 * "Unable to connect to API (EACCES)" is explained with the program to allow,
 * every other error is left alone, and the diagnostics make the same connection
 * from a child process to see whether it gets through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'

const env = vi.hoisted(() => ({
  engine: 'anthropic' as string | null,
  headless: '/Applications/Halo.app/Contents/Frameworks/Halo Helper.app/Contents/MacOS/Halo Helper',
  codex: null as { binaryPath: string; isJsShim: boolean; pathDirs: string[] } | null,
}))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({ getActiveEngine: () => env.engine }))
vi.mock('../../../../src/main/services/agent/helpers', () => ({ getHeadlessElectronPath: () => env.headless }))
vi.mock('../../../../src/main/services/agent/codex/transport/connection', () => ({
  resolveBundledCodexBinary: () => env.codex,
}))

import {
  checkChildLocalConnection,
  explainEngineError,
  localConnectionProgram,
} from '../../../../src/main/services/agent/local-connection'

beforeEach(() => {
  env.engine = 'anthropic'
  env.codex = null
})

describe('explainEngineError', () => {
  it.each([
    'API Error: Unable to connect to API (EACCES)',
    'API Error: Unable to connect to API (EPERM)',
    'request to http://127.0.0.1:65305/v1/messages failed, reason: connect EACCES 127.0.0.1:65305',
  ])('explains %s and names the program to allow', (error) => {
    const explained = explainEngineError(error)

    expect(explained).toMatch(/^Security software on this computer blocked Halo's internal connection to 127\.0\.0\.1/)
    expect(explained).toContain('This is not a problem with the model, the account or the gateway.')
    expect(explained).toContain(`allow this program to make local connections: ${env.headless}`)
    expect(explained).toContain(`(engine error: ${error})`)
  })

  it.each([
    'API Error: Unable to connect to API (ECONNREFUSED)',
    'API Error: Unable to connect to API. Check your internet connection',
    'Unable to connect to API: SSL certificate has expired',
    'API Error: 401 {"error":{"message":"invalid key"}}',
    'connect EACCES 10.0.0.5:443',
    '',
  ])('leaves %s as it is', (error) => {
    expect(explainEngineError(error)).toBe(error)
  })
})

describe('localConnectionProgram', () => {
  it('names the program each engine connects from', () => {
    expect(localConnectionProgram()).toBe(env.headless)

    env.engine = 'halo'
    expect(localConnectionProgram()).toBe(process.execPath)

    env.engine = 'codex'
    env.codex = { binaryPath: '/Applications/Halo.app/codex', isJsShim: false, pathDirs: [] }
    expect(localConnectionProgram()).toBe('/Applications/Halo.app/codex')
    env.codex = { binaryPath: '/Applications/Halo.app/codex.js', isJsShim: true, pathDirs: [] }
    expect(localConnectionProgram()).toBe(env.headless)
  })
})

describe('checkChildLocalConnection', () => {
  let server: net.Server | null = null

  beforeEach(() => {
    // The test runner's Node stands in for the engine's Electron-as-Node.
    env.headless = process.execPath
  })
  afterEach(async () => {
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
    server = null
  })

  it('reports a connection the child made', async () => {
    server = net.createServer(socket => socket.destroy())
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as net.AddressInfo).port

    expect(await checkChildLocalConnection(port)).toEqual({ reachable: true, blocked: false, program: process.execPath })
  })

  it('reports why the child could not connect, and that nothing blocked it', async () => {
    server = net.createServer()
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as net.AddressInfo).port
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = null

    expect(await checkChildLocalConnection(port)).toEqual({
      reachable: false, blocked: false, error: 'ECONNREFUSED', program: process.execPath,
    })
  })

  it('reports a program that cannot be started', async () => {
    env.headless = '/nonexistent/halo-helper'

    expect(await checkChildLocalConnection(1)).toEqual({
      reachable: false, blocked: false, error: 'ENOENT', program: '/nonexistent/halo-helper',
    })
  })
})
