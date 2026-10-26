import { describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkInstallation, launchForInstallation } from '../../../src/main/services/cc-runtime/probe'
import { resolveCandidatePath } from '../../../src/main/services/cc-runtime/paths'
import { discoverInstallations } from '../../../src/main/services/cc-runtime/discovery'

vi.mock('../../../src/main/services/cc-runtime/paths', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/main/services/cc-runtime/paths')>()
  return { ...actual, fileExists: (path: string) => path.startsWith(globalThis.__HALO_TEST_DIR__) ? actual.fileExists(path) : Promise.resolve(false) }
})

async function executable(name: string, version = '2.1.89', mode = 'success'): Promise<string> {
  const path = join(globalThis.__HALO_TEST_DIR__, `${name}.cjs`)
  await writeFile(path, `
const fs = require('node:fs')
if (process.argv.includes('--version')) {
  console.log('${version} (Claude Code)')
  process.exit(0)
}
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) process.exit(13)
if (process.env.DISABLE_AUTOUPDATER !== '1' || process.env.DISABLE_UPDATES !== '1') process.exit(14)
if (!process.argv.includes('--strict-mcp-config')) process.exit(15)
if (['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA'].some(key => process.env[key] !== process.env.CLAUDE_CONFIG_DIR)) process.exit(17)
if (process.env.ANTHROPIC_BASE_URL !== 'http://127.0.0.1:9' || process.env.HTTPS_PROXY !== 'http://127.0.0.1:9') process.exit(18)
if (!process.argv.includes('{"disableAllHooks":true}')) process.exit(19)
fs.writeFileSync(${JSON.stringify(`${path}.probe`)}, process.env.CLAUDE_CONFIG_DIR)
fs.writeFileSync(${JSON.stringify(`${path}.pid`)}, String(process.pid))
const rl = require('node:readline').createInterface({ input: process.stdin })
if ('${mode}' === 'stubborn') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}
rl.on('line', line => {
  if (['hang', 'stubborn'].includes('${mode}')) return
  const message = JSON.parse(line)
  if (message.type !== 'control_request') process.exit(16)
  const response = message.request.subtype === 'initialize' ? { commands: [], models: [] }
    : message.request.subtype === 'cancel_async_message' ? { cancelled: false } : {}
  console.log(JSON.stringify({ type: 'control_response', response: {
    subtype: '${mode === 'reject' ? 'error' : 'success'}', request_id: message.request_id,
    response: ${mode === 'malformed' ? '{}' : 'response'}
  } }))
})
`)
  return path
}

describe('CC runtime protocol checking', () => {
  it.skipIf(!process.env.HALO_TEST_CC_PATH)('checks the explicitly supplied real CC binary without credentials or model calls', async () => {
    const result = await checkInstallation(process.env.HALO_TEST_CC_PATH!, { force: true })
    expect(result.issue).toBeUndefined()
    expect(['verified', 'compatible']).toContain(result.compatibility)
    expect(result.version).toBeTruthy()
    console.log('[CcRuntime test] Real executable probe passed', { version: result.version, kind: result.kind, compatibility: result.compatibility })
  }, 60_000)

  it('checks the control interface in isolation and cleans up its temporary state', async () => {
    const path = await executable('supported')
    const result = await checkInstallation(path)
    expect(result).toMatchObject({ compatibility: process.platform === 'darwin' && process.arch === 'arm64' ? 'verified' : 'compatible', version: '2.1.89', kind: 'javascript', recommended: true })
    const temporary = await readFile(`${path}.probe`, 'utf8')
    await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await launchForInstallation(path)).toMatchObject({
      command: process.execPath, argsPrefix: [await realpath(path)], env: { ELECTRON_RUN_AS_NODE: '1', DISABLE_UPDATES: '1' }
    })
  })

  it('allows a newer version after successful checks without claiming verification', async () => {
    const result = await checkInstallation(await executable('newer', '3.1.7'))
    expect(result).toMatchObject({ compatibility: 'compatible', recommended: false, version: '3.1.7' })
  })

  it('does not mistake a recognized version for protocol compatibility', async () => {
    expect(await checkInstallation(await executable('reject', '2.1.89', 'reject'))).toMatchObject({ compatibility: 'incompatible', issue: 'protocol-unsupported' })
    expect(await checkInstallation(await executable('bad-shape', '2.1.89', 'malformed'))).toMatchObject({ compatibility: 'incompatible', issue: 'protocol-unsupported' })
  })

  it('rejects known old releases and missing paths with distinct states', async () => {
    expect(await checkInstallation(await executable('old', '1.0.0'))).toMatchObject({ compatibility: 'incompatible', issue: 'version-too-old' })
    expect(await checkInstallation(join(globalThis.__HALO_TEST_DIR__, 'missing'))).toMatchObject({ compatibility: 'unavailable', issue: 'not-found' })
  })

  it('terminates an unresponsive process and removes isolated state when cancelled', async () => {
    const path = await executable('cancelled', '2.1.89', 'stubborn')
    const controller = new AbortController()
    const running = checkInstallation(path, { signal: controller.signal })
    const deadline = Date.now() + 3000
    let pid = 0
    while (!pid && Date.now() < deadline) {
      try { pid = Number(await readFile(`${path}.pid`, 'utf8')) } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
    }
    expect(pid).toBeGreaterThan(0)
    controller.abort()
    expect(await running).toMatchObject({ compatibility: 'unavailable', issue: 'cancelled' })
    expect(() => process.kill(pid, 0)).toThrow()
    await expect(stat(await readFile(`${path}.probe`, 'utf8'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns a bounded scan result and terminates a real child after its scan deadline', async () => {
    const path = await executable('scan-deadline', '2.1.89', 'stubborn')
    const started = Date.now()
    const scan = await discoverInstallations(path, { deadlineMs: 500 })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(scan).toMatchObject({ installations: [], truncated: true })
    const pid = Number(await readFile(`${path}.pid`, 'utf8'))
    const directory = await readFile(`${path}.probe`, 'utf8')
    const cleanupDeadline = Date.now() + 2000
    let running = true
    let directoryExists = true
    while ((running || directoryExists) && Date.now() < cleanupDeadline) {
      try { process.kill(pid, 0) } catch { running = false }
      try { await stat(directory) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') directoryExists = false
        else throw error
      }
      if (running || directoryExists) await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(running).toBe(false)
    expect(directoryExists).toBe(false)
  })

  it('invalidates a selected symlink when its target changes without modifying either installation', async () => {
    const path = join(globalThis.__HALO_TEST_DIR__, 'claude')
    const first = await executable('first')
    const second = await executable('second', '3.1.7')
    await symlink(first, path)
    expect((await launchForInstallation(path))?.version).toBe('2.1.89')
    await rm(path)
    await symlink(second, path)
    expect((await launchForInstallation(path))?.version).toBe('3.1.7')
    expect(await readFile(first, 'utf8')).toContain('2.1.89')
    await rm(second)
    expect(await launchForInstallation(path)).toBeNull()
  })

  it('resolves selected directories through known package layouts without executing shell launchers', async () => {
    const directory = join(globalThis.__HALO_TEST_DIR__, 'package')
    await mkdir(directory)
    await writeFile(join(directory, 'cli.js'), '#!/usr/bin/env node\n')
    expect(await resolveCandidatePath(directory)).toBe(join(directory, 'cli.js'))
    const script = join(globalThis.__HALO_TEST_DIR__, 'wrapper')
    await writeFile(script, '#!/bin/sh\necho forbidden\n')
    expect(await checkInstallation(script)).toMatchObject({ compatibility: 'unavailable', issue: 'unsupported-launcher' })
  })
})
