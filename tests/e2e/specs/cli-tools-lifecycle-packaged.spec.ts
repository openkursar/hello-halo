/**
 * The whole CLI tool lifecycle in an installed (packaged) Halo, against a real
 * local registry and admin API:
 *
 *   presets shipped in the package (F01) → an administrator imports a partner
 *   CLI from npm and approves it → the user installs it from the enterprise
 *   catalog → every entry runs it (F02) → a newer version is approved and shown
 *   as an update; a corrupted download leaves the installed version intact; the
 *   update installs for new tasks → rollback only
 *   changes later tasks → revoke and delisting keep the tool out of new tasks →
 *   unsigned or wrongly signed catalog entries are refused → the user imports a
 *   standard package (F03) and registers an existing program (F04); a second
 *   source does not take over (F06); disable and removal (F08/F09).
 *
 * Prerequisites (outside this spec, see the evidence README):
 *   - a package built with product.json pointing the official registry at
 *     http://127.0.0.1:18290 (dhp-v2, identityProvider "claude") and with presets
 *     plus trusted-keys.json injected into resources/cli-preset;
 *   - the registry on 127.0.0.1:18292 with cli_signing, an introspection stub on
 *     127.0.0.1:18291 accepting the simulated account token, and the fault proxy
 *     on 127.0.0.1:18290 (stack-aux.mjs).
 * The store identity is simulated: a Claude account whose token only the local
 * stub accepts. Company identity is not exercised.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { CliToolsOverview, CliToolView } from '../../../src/shared/types/cli-tools'
import { test, expect } from '../fixtures/electron-packaged'
import { navigateToChat } from '../fixtures/helpers'
import { parseProbe, startEntryModel, startProbe, terminalProbe, useScriptedModel, type ProbeEntry } from '../fixtures/cli-tools-entries'

test.setTimeout(45 * 60 * 1000)

const ADMIN = process.env.CLI_E2E_ADMIN_URL ?? 'http://127.0.0.1:18292/store'
const ADMIN_PASSWORD = process.env.CLI_E2E_ADMIN_PASSWORD ?? ''
const FAULT = process.env.CLI_E2E_FAULT_URL ?? 'http://127.0.0.1:18290/__fault'
const PACKAGES = process.env.CLI_E2E_PACKAGES ?? ''
const EVIDENCE = process.env.CLI_E2E_EVIDENCE ?? ''
const ENTRIES = (process.env.CLI_E2E_ENTRIES ?? 'chat,dh,auto,collab,team,terminal').split(',') as ProbeEntry[]

const COWSAY = 'npm.cowsay'
/** Simulated sign-in of the build's identity provider; the local identity stub accepts this token. */
const STORE_IDENTITY: Record<string, unknown> = {
  id: 'cli-e2e-store-identity', name: 'Store identity (simulated)', provider: 'claude', authType: 'oauth',
  accessToken: 'acct-e2e-token', refreshToken: 'unused', tokenExpires: Date.now() + 30 * 24 * 3600 * 1000,
  user: { uid: 'e2e-user', name: 'E2E' }, model: 'claude-sonnet-4-5',
  availableModels: [{ id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5' }], createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z',
}
const PRESETS = ['com.github.nodeca.js-yaml', 'io.prettier.cli', 'org.typescriptlang.tsc']

type Api = HaloAPI
const api = (page: Page) => ({
  overview: () => page.evaluate(() => (globalThis as unknown as { halo: Api }).halo.cliToolsOverview()) as Promise<{ success: boolean; data?: CliToolsOverview; error?: string }>,
  catalog: () => page.evaluate(() => (globalThis as unknown as { halo: Api }).halo.storeGetCliCatalog()),
  install: (id: string, version: string) => page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.storeInstallCliTool(input), { id, version }),
  setCurrent: (id: string, version: string) => page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.cliToolsSetCurrent(input), { id, version }),
  setDisabled: (id: string, disabled: boolean) => page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.cliToolsSetDisabled(input), { id, disabled }),
  removeVersion: (id: string, version: string) => page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.cliToolsRemoveVersion(input), { id, version }),
  removeTool: (id: string) => page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.cliToolsRemoveTool(input), { id }),
  pickPackage: () => page.evaluate(() => (globalThis as unknown as { halo: Api }).halo.cliToolsPickPackage()),
  confirmImport: (previewId: string, makeCurrent: boolean) => page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.cliToolsConfirmImport(input), { previewId, makeCurrent }),
  cancelImport: (previewId: string) => page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.cliToolsCancelImport(input), { previewId }),
  pickExternal: () => page.evaluate(() => (globalThis as unknown as { halo: Api }).halo.cliToolsPickExternal()),
  registerExternal: (input: { pickId: string; command: string; name: string; description?: string }) => page.evaluate(value => (globalThis as unknown as { halo: Api }).halo.cliToolsRegisterExternal(value), input),
  reconfirmExternal: (id: string) => page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.cliToolsReconfirmExternal(input), { id }),
})

/** Unwraps an IPC response carrying a CliToolsResult. */
function ok<T>(label: string, response: { success: boolean; data?: unknown; error?: string }): T {
  expect(response.success, `${label}: ${response.error ?? ''}`).toBe(true)
  const result = response.data as { ok: boolean; data?: T; code?: string; message?: string }
  if (result && typeof result === 'object' && 'ok' in result) {
    expect(result.ok, `${label}: ${result.code ?? ''} ${result.message ?? ''}`).toBe(true)
    return result.data as T
  }
  return response.data as T
}

function refused(label: string, response: { success: boolean; data?: unknown; error?: string }): string {
  if (!response.success) return response.error ?? ''
  const result = response.data as { ok: boolean; code?: string; message?: string }
  expect(result.ok, `${label} must be refused`).toBe(false)
  return `${result.code ?? ''} ${result.message ?? ''}`
}

class Admin {
  private cookie = ''
  async login(): Promise<void> {
    const res = await fetch(`${ADMIN}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: ADMIN_PASSWORD }) })
    expect(res.status, 'admin login').toBe(200)
    this.cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  }
  async call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${ADMIN}${route}`, { method, headers: { Cookie: this.cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let json: unknown = text
    try { json = JSON.parse(text) } catch { /* plain text */ }
    return { status: res.status, json }
  }
  async importNpm(pkg: string, version: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await this.call('POST', '/api/clis/import-npm', { package: pkg, version, ...extra })
    expect([200, 201], `import ${pkg}@${version}: ${JSON.stringify(res.json)}`).toContain(res.status)
    return (res.json as { version: { id: string } }).version.id
  }
  async decide(id: string, version: string, action: 'approve' | 'withdraw', reason = 'e2e'): Promise<void> {
    const res = await this.call('POST', `/api/clis/${id}/versions/${version}/${action}`, { reason })
    expect(res.status, `${action} ${id}@${version}: ${JSON.stringify(res.json)}`).toBe(200)
  }
  async revoke(id: string, revoke: boolean): Promise<void> {
    const res = await this.call('POST', `/api/clis/${id}/${revoke ? 'revoke' : 'unrevoke'}`, { reason: 'e2e revoke check' })
    expect(res.status, `${revoke ? 'revoke' : 'unrevoke'} ${id}: ${JSON.stringify(res.json)}`).toBe(200)
  }
}

async function fault(mode: 'none' | 'corrupt-download' | 'strip-signature' | 'bad-signature'): Promise<void> {
  const res = await fetch(FAULT, { method: 'POST', body: JSON.stringify({ mode }) })
  expect(res.status, `fault ${mode}`).toBe(200)
}

function tool(overview: CliToolsOverview, id: string): CliToolView | undefined {
  return overview.tools.find(item => item.id === id)
}

function summarize(overview: CliToolsOverview) {
  return {
    signature: overview.signature, pendingCleanup: overview.pendingCleanup,
    tools: overview.tools.map(item => ({
      id: item.id, current: item.current, status: item.status, disabled: item.disabled, revoked: item.revoked, delisted: item.delisted,
      catalogUpdate: item.catalogUpdate, hasPreset: item.hasPreset, commands: item.commands,
      versions: item.versions.map(v => ({ version: v.version, source: v.source, current: v.current, inUse: v.inUse, removable: v.removable, withdrawn: v.withdrawn, external: v.external ? { interpreter: v.external.interpreter, changed: v.external.changed } : undefined })),
    })),
  }
}

test.describe('CLI tool lifecycle with Halo', () => {
  test.use({ sdkEngine: 'halo', hostCommands: 'system-only', seedAiSources: [STORE_IDENTITY] })

  test('presets, partner catalog, update, rollback, revoke, delisting, signatures, user import and registered programs', async ({ electronApp, window }, testInfo) => {
    expect(ADMIN_PASSWORD, 'CLI_E2E_ADMIN_PASSWORD names the throwaway admin password of the local registry').not.toBe('')
    expect(fs.existsSync(PACKAGES), 'CLI_E2E_PACKAGES names the directory of local .hcli packages').toBe(true)
    expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(true)
    const runtime = await electronApp.evaluate(({ app }) => ({ userData: app.getPath('userData'), resources: process.resourcesPath }))
    const cliRoot = path.join(runtime.userData, 'cli')
    const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, cliRoot, entries: ENTRIES }
    const steps: Array<{ step: string; result: unknown }> = []
    const record = (step: string, result: unknown) => { steps.push({ step, result }) }
    const tools = api(window)
    const admin = new Admin()
    const model = await startEntryModel()
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-e2e-'))

    /** Runs one probe round through the selected entries and returns each entry's parsed output. */
    const probeAll = async (round: string, commands: string[], entries: ProbeEntry[] = ENTRIES) => {
      model.round(round, commands)
      const out: Record<string, ReturnType<typeof parseProbe> & { isError: boolean }> = {}
      for (const entry of entries) {
        if (entry === 'terminal') {
          const result = await terminalProbe(window, commands)
          out.terminal = { ...parseProbe(result.text), isError: result.isError }
          continue
        }
        await startProbe(window, entry, round)
        const result = await model.wait(entry, round)
        out[entry] = { ...parseProbe(result.text), isError: result.isError }
      }
      record(`probe:${round}`, out)
      return out
    }
    const expectEvery = (label: string, out: Record<string, ReturnType<typeof parseProbe>>, command: string, expected: RegExp | string) => {
      for (const [entry, probe] of Object.entries(out)) {
        const value = probe.commands[command]
        if (typeof expected === 'string') expect.soft(value, `${label}: ${entry} ${command}`).toBe(expected)
        else expect.soft(value, `${label}: ${entry} ${command}`).toMatch(expected)
      }
    }

    try {
      // ---- Setup: scripted model, simulated store identity, partner CLI v1 approved.
      await admin.login()
      await useScriptedModel(window, model.url, [STORE_IDENTITY.id as string])
      await window.reload()
      await navigateToChat(window)

      const cowsayId = await admin.importNpm('cowsay', '1.5.0')
      expect(cowsayId).toBe(COWSAY)
      await admin.decide(COWSAY, '1.5.0', 'approve')
      await fault('none')

      // ---- F01: presets shipped in the package are imported and usable; signatures are enforced.
      const packaged = fs.readdirSync(path.join(runtime.resources, 'cli-preset')).sort()
      record('packaged-cli-preset', packaged)
      expect(packaged).toContain('trusted-keys.json')
      let overview = ok<CliToolsOverview>('overview', await tools.overview())
      record('overview:first-launch', summarize(overview))
      expect(overview.signature, 'the injected trust file turns signature checks on').toBe('on')
      for (const id of PRESETS) {
        expect.soft(tool(overview, id)?.status, `${id} preset available`).toBe('available')
        expect.soft(tool(overview, id)?.versions.every(v => v.source === 'preset'), `${id} source preset`).toBe(true)
      }
      const presetProbe = await probeAll('preset', ['prettier', 'tsc', 'js-yaml', 'cowsay'], ['chat'])
      expectEvery('preset', presetProbe, 'prettier', '3.9.10')
      expectEvery('preset', presetProbe, 'tsc', /Version 5\.9\.3/)
      expectEvery('preset', presetProbe, 'cowsay', 'MISSING')

      // ---- F02: catalog lists the approved partner CLI; installing needs the user's action.
      const catalog = ok<{ tools: Array<{ id: string; latest: string; installed: unknown; versions: Array<{ version: string; signature?: unknown }> }> }>('catalog', await tools.catalog())
      record('catalog:v1', catalog.tools.map(t => ({ id: t.id, latest: t.latest, installed: t.installed })))
      expect(catalog.tools.find(t => t.id === COWSAY)?.latest).toBe('1.5.0')
      expect(catalog.tools.find(t => t.id === COWSAY)?.installed, 'not installed until the user asks').toBeNull()
      ok('install cowsay 1.5.0', await tools.install(COWSAY, '1.5.0'))
      const v1 = await probeAll('v1', ['cowsay'])
      expectEvery('v1', v1, 'cowsay', '1.5.0')
      evidence.v1Bins = Object.fromEntries(Object.entries(v1).map(([entry, probe]) => [entry, probe.bin]))

      // ---- F07: a newer approved version shows as an update and is not downloaded on its own.
      await admin.importNpm('cowsay', '1.6.0')
      await admin.decide(COWSAY, '1.6.0', 'approve')
      ok('catalog refresh', await tools.catalog())
      overview = ok<CliToolsOverview>('overview', await tools.overview())
      record('overview:update-available', summarize(overview))
      expect(tool(overview, COWSAY)?.catalogUpdate).toBe('1.6.0')
      expect(tool(overview, COWSAY)?.current, 'an update is not installed without confirmation').toBe('1.5.0')

      // ---- v2 preparation failure leaves v1 intact.
      await fault('corrupt-download')
      const corrupt = refused('corrupted 1.6.0 download', await tools.install(COWSAY, '1.6.0'))
      record('install:corrupt-download', corrupt)
      await fault('none')
      overview = ok<CliToolsOverview>('overview', await tools.overview())
      expect(tool(overview, COWSAY)?.current).toBe('1.5.0')
      expect(tool(overview, COWSAY)?.versions.map(v => v.version)).toEqual(['1.5.0'])
      const afterFailure = await probeAll('after-failure', ['cowsay'], ['chat'])
      expectEvery('after failed update', afterFailure, 'cowsay', '1.5.0')

      // ---- New tasks use v2. Pinning a version for a task already running needs the services/agent change awaiting approval.
      evidence.inflightNote = 'Not covered: per-execution version pinning for a running task needs the services/agent change awaiting separate approval.'
      ok('install cowsay 1.6.0', await tools.install(COWSAY, '1.6.0'))
      const v2 = await probeAll('v2', ['cowsay'])
      expectEvery('v2', v2, 'cowsay', '1.6.0')
      overview = ok<CliToolsOverview>('overview', await tools.overview())
      record('overview:v2', summarize(overview))
      expect(tool(overview, COWSAY)?.catalogUpdate).toBeUndefined()

      // ---- F05/F08: rollback only changes later tasks.
      ok('rollback to 1.5.0', await tools.setCurrent(COWSAY, '1.5.0'))
      const rolledBack = await probeAll('rollback', ['cowsay'], ['chat', 'dh'])
      expectEvery('rollback', rolledBack, 'cowsay', '1.5.0')
      ok('forward to 1.6.0', await tools.setCurrent(COWSAY, '1.6.0'))

      // ---- F08: disable is the user's switch, separate from revoke.
      ok('disable cowsay', await tools.setDisabled(COWSAY, true))
      const disabled = await probeAll('disabled', ['cowsay'], ['chat'])
      expectEvery('disabled', disabled, 'cowsay', 'MISSING')
      ok('enable cowsay', await tools.setDisabled(COWSAY, false))
      const enabled = await probeAll('enabled', ['cowsay'], ['chat'])
      expectEvery('enabled', enabled, 'cowsay', '1.6.0')

      // ---- Unsigned or wrongly signed catalog entries are refused (js-yaml from npm, a different id).
      const yamlId = await admin.importNpm('js-yaml', '4.1.0')
      await admin.decide(yamlId, '4.1.0', 'approve')
      await fault('strip-signature')
      ok('catalog unsigned', await tools.catalog())
      record('install:unsigned', refused('unsigned install', await tools.install(yamlId, '4.1.0')))
      await fault('bad-signature')
      ok('catalog bad signature', await tools.catalog())
      record('install:bad-signature', refused('wrongly signed install', await tools.install(yamlId, '4.1.0')))
      await fault('none')
      ok('catalog signed', await tools.catalog())
      ok('install signed js-yaml 4.1.0', await tools.install(yamlId, '4.1.0'))

      // ---- F09: a tool that disappears from the catalog is kept out of new tasks.
      await admin.decide(yamlId, '4.1.0', 'withdraw', 'e2e delist')
      ok('catalog after delist', await tools.catalog())
      overview = ok<CliToolsOverview>('overview', await tools.overview())
      record('overview:delisted', summarize(overview))
      expect(tool(overview, yamlId)?.status).toBe('delisted')

      // ---- Revoke: after the next sync, new tasks cannot use the tool.
      await admin.revoke(COWSAY, true)
      ok('catalog after revoke', await tools.catalog())
      overview = ok<CliToolsOverview>('overview', await tools.overview())
      record('overview:revoked', summarize(overview))
      expect(tool(overview, COWSAY)?.status).toBe('revoked')
      const revoked = await probeAll('revoked', ['cowsay'])
      expectEvery('revoked', revoked, 'cowsay', 'MISSING')
      record('install:revoked', refused('install a revoked tool', await tools.install(COWSAY, '1.6.0')))

      // ---- F03: user import with preview; a tampered package is refused; a second source does not take over.
      const pick = async (file: string) => {
        await electronApp.evaluate(({ dialog }, chosen) => {
          (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] })
        }, file)
      }
      await pick(path.join(PACKAGES, 'io.prettier.cli-3.10.2-tampered.hcli'))
      record('import:tampered', refused('tampered package', await tools.pickPackage()))
      await pick(path.join(PACKAGES, 'io.prettier.cli-3.10.1.hcli'))
      const preview = ok<{ previewId: string; id: string; version: string; existing: unknown; commands: unknown }>('preview prettier 3.10.1', await tools.pickPackage())
      record('import:preview', preview)
      expect(preview).toMatchObject({ id: 'io.prettier.cli', version: '3.10.1', existing: { current: '3.9.10', currentSource: 'preset' } })
      ok('confirm import without taking over', await tools.confirmImport(preview.previewId, false))
      const noTakeover = await probeAll('no-takeover', ['prettier'], ['chat'])
      expectEvery('import does not take over', noTakeover, 'prettier', '3.9.10')

      // ---- F06: the user chooses the instance and the choice is remembered across a restart-free resync.
      ok('choose prettier 3.10.1', await tools.setCurrent('io.prettier.cli', '3.10.1'))
      ok('catalog resync', await tools.catalog())
      overview = ok<CliToolsOverview>('overview', await tools.overview())
      expect(tool(overview, 'io.prettier.cli')?.current).toBe('3.10.1')
      const chosen = await probeAll('chosen', ['prettier'], ['chat', 'terminal'])
      expectEvery('chosen instance', chosen, 'prettier', '3.10.1')

      // ---- F04: register an existing program; not copied; a change blocks it until reconfirmed; removal keeps the file.
      const program = path.join(scratch, 'e2e-hello.mjs')
      fs.writeFileSync(program, "console.log(process.argv.includes('--version') ? 'e2e-hello 1.0.0' : 'hello')\n")
      await pick(program)
      const external = ok<{ pickId: string; interpreter: string | null }>('pick external', await tools.pickExternal())
      expect(external.interpreter).toBe('halo-node')
      ok('register external', await tools.registerExternal({ pickId: external.pickId, command: 'e2e-hello', name: 'E2E hello' }))
      overview = ok<CliToolsOverview>('overview', await tools.overview())
      record('overview:external', summarize(overview))
      const externalTool = overview.tools.find(item => item.commands.includes('e2e-hello'))!
      expect(externalTool.versions.find(v => v.external)?.external?.path).toBe(program)
      expect(fs.readdirSync(cliRoot, { recursive: true }).map(String).some(entry => entry.endsWith('e2e-hello.mjs')), 'the program is not copied').toBe(false)
      const ext1 = await probeAll('external', ['e2e-hello'], ['chat', 'terminal'])
      expectEvery('external program', ext1, 'e2e-hello', 'e2e-hello 1.0.0')
      fs.appendFileSync(program, '// changed outside Halo\n')
      const changed = await probeAll('external-changed', ['e2e-hello'], ['chat'])
      expectEvery('changed program is blocked', changed, 'e2e-hello', 'MISSING')
      overview = ok<CliToolsOverview>('overview', await tools.overview())
      expect(overview.tools.find(item => item.id === externalTool.id)?.status).toBe('external-changed')
      ok('reconfirm external', await tools.reconfirmExternal(externalTool.id))
      const reconfirmed = await probeAll('external-reconfirmed', ['e2e-hello'], ['chat'])
      expectEvery('reconfirmed program', reconfirmed, 'e2e-hello', 'e2e-hello 1.0.0')
      ok('remove external', await tools.removeTool(externalTool.id))
      expect(fs.existsSync(program), 'removing the registration keeps the program').toBe(true)

      // ---- F09: removal; presets can only be disabled.
      record('remove-preset', refused('remove a preset tool', await tools.removeTool('org.typescriptlang.tsc')))
      ok('remove prettier 3.10.1 after switching back', await tools.setCurrent('io.prettier.cli', '3.9.10'))
      ok('remove prettier 3.10.1', await tools.removeVersion('io.prettier.cli', '3.10.1'))
      ok('remove cowsay', await tools.removeTool(COWSAY))
      overview = ok<CliToolsOverview>('overview', await tools.overview())
      record('overview:final', summarize(overview))
      expect(tool(overview, COWSAY)).toBeUndefined()
      expect(tool(overview, 'io.prettier.cli')?.versions.map(v => v.version)).toEqual(['3.9.10'])
      evidence.issues = model.issues
      expect.soft(model.issues, 'scripted model issues').toEqual([])
    } finally {
      evidence.steps = steps
      evidence.finishedAt = new Date().toISOString()
      const body = JSON.stringify(evidence, null, 2)
      await testInfo.attach('cli-lifecycle-evidence', { body, contentType: 'application/json' })
      if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, `lifecycle-${process.arch}.json`), body)
      await fault('none').catch(() => undefined)
      await model.close()
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })
})
