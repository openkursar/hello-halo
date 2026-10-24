import { test, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestConfigDir, getAppEntryPath, launchElectronApp } from '../fixtures/electron'
import { navigateToChat } from '../fixtures/helpers'
import type { HaloAPI } from '../../../src/preload'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
type Probe = { conversationId: string | null; spaceId: string | null; complete: boolean; errors: number; tools: string[]; dispose: () => void }
type TestWindow = { halo: HaloAPI; sdkProbe?: Probe }

async function installProbe(window: Page) {
  await window.evaluate(() => {
    const state = globalThis as unknown as TestWindow
    state.sdkProbe?.dispose()
    const probe: Probe = { conversationId: null, spaceId: null, complete: false, errors: 0, tools: [], dispose: () => {} }
    const stops = [
      state.halo.onAgentTurnStart(value => { const event = value as { conversationId: string; spaceId: string }; probe.conversationId = event.conversationId; probe.spaceId = event.spaceId }),
      state.halo.onAgentComplete(value => { if ((value as { conversationId: string }).conversationId === probe.conversationId) probe.complete = true }),
      state.halo.onAgentError(() => { probe.errors++ }),
      state.halo.onAgentThought(value => { const event = value as { thought?: { type: string; toolName?: string } }; if (event.thought?.type === 'tool_use' && event.thought.toolName) probe.tools.push(event.thought.toolName) }),
    ]
    probe.dispose = () => stops.forEach(stop => stop())
    state.sdkProbe = probe
  })
}

async function begin(window: Page, text: string) {
  await installProbe(window)
  await window.locator('textarea').first().fill(text)
  await window.locator('[data-onboarding="send-button"]').click()
}

async function waitForIdle(window: Page, timeout = 120000) {
  await expect.poll(() => window.evaluate(async () => {
    const state = globalThis as unknown as TestWindow
    const probe = state.sdkProbe!
    const session = probe.conversationId ? await state.halo.getSessionState(probe.conversationId) : null
    return { complete: probe.complete, errors: probe.errors, active: (session?.data as { isActive?: boolean } | undefined)?.isActive }
  }), { timeout }).toEqual({ complete: true, errors: 0, active: false })
  await expect(window.locator('.streaming-cursor')).toHaveCount(0)
}

async function send(window: Page, text: string) {
  await begin(window, text)
  await waitForIdle(window)
  return window.evaluate(() => {
    const probe = (globalThis as unknown as TestWindow).sdkProbe!
    return { conversationId: probe.conversationId!, spaceId: probe.spaceId!, tools: probe.tools }
  })
}

async function close(app: ElectronApplication) {
  const process = app.process()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([app.close(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Application did not close within 10 seconds')), 10000) })])
    expect(process.exitCode).toBe(0)
    expect(process.signalCode).toBeNull()
  } finally { clearTimeout(timer) }
}

function createProfile() {
  if (!process.env.HALO_TEST_API_KEY || !process.env.HALO_LIVE_SDK_ROOT) throw new Error('Launch this test through tests/e2e/sdk/run-live.mjs')
  const entry = getAppEntryPath()
  const profile = createTestConfigDir(entry, [])
  const configFile = join(profile, '.halo/config.json')
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  config.agent = { ...config.agent, sdkEngine: 'halo', configDirMode: 'custom', customConfigDir: join(profile, 'sdk-state'), enableDigitalHumans: false, maxTurns: 20 }
  writeFileSync(configFile, JSON.stringify(config, null, 2))
  return { entry, profile }
}

async function finish(app: ElectronApplication | undefined, profile: string, testInfo: TestInfo, failed: boolean) {
  try {
    if (app) await close(app)
  } catch (error) {
    if (!failed) throw error
    await testInfo.attach('cleanup-error', { body: String(error), contentType: 'text/plain' })
  } finally {
    const log = join(profile, '.halo/logs/main.log')
    if (existsSync(log)) await testInfo.attach('main-log', { body: readFileSync(log).subarray(-1000000), contentType: 'text/plain' })
    await testInfo.attach('isolated-profile', { body: JSON.stringify({ profile }), contentType: 'application/json' })
  }
}

async function verifyRuntime(app: ElectronApplication, window: Page, testInfo: TestInfo) {
  const availability = await window.evaluate(() => (globalThis as unknown as TestWindow).halo.getEngineAvailability())
  expect(availability).toMatchObject({ success: true, data: { activeEngine: 'halo', degradedFrom: null } })
  const engine = (availability.data as { engines: Array<{ engineId: string; available: boolean; fingerprint: string }> }).engines.find(engine => engine.engineId === 'halo')
  expect(engine).toMatchObject({ available: true, fingerprint: process.env.HALO_LIVE_WORKER_SHA!.slice(0, 12) })
  const identity = await app.evaluate(({ app }) => ({ appPath: app.getAppPath(), electron: process.versions.electron, node: process.versions.node }))
  expect(realpathSync(identity.appPath)).toBe(realpathSync(project))
  await testInfo.attach('loaded-runtime', { body: JSON.stringify({ ...identity, engine }, null, 2), contentType: 'application/json' })
}

test('Halo SDK worker renders and persists real file work across reload and restart', async ({}, testInfo) => {
  const { entry, profile } = createProfile()
  const nonce = randomUUID()
  const receipt = join(profile, '.halo/temp', 'sdk-receipt.txt')
  let app: ElectronApplication | undefined
  let failed = false
  try {
    app = await launchElectronApp(entry, profile, { bootstrapDirectory: project })
    let window = await app.firstWindow()
    await navigateToChat(window)
    await verifyRuntime(app, window, testInfo)

    const first = await send(window, `Use the Write tool to create ${receipt} with exactly ${nonce}. Then reply with exactly WRITTEN ${nonce}.`)
    expect(first.tools).toContain('Write')
    expect(readFileSync(receipt, 'utf8').trim()).toBe(nonce)
    await expect(window.locator('.message-assistant').last()).toContainText(`WRITTEN ${nonce}`)
    const diagnostic = await window.evaluate(() => (globalThis as unknown as TestWindow).halo.generateHealthReport())
    expect(diagnostic).toMatchObject({ success: true, data: { sdk: { engine: 'halo', initialized: true } } })
    const runtime = (diagnostic.data as any).sdk.runtime
    expect(runtime.workers.some((worker: any) => worker.state === 'ready' && worker.sessions > 0 && worker.threadId > 0)).toBe(true)
    await testInfo.attach('worker-state', { body: JSON.stringify(runtime, null, 2), contentType: 'application/json' })
    const saved = await window.evaluate(({ spaceId, conversationId }) =>
      (globalThis as unknown as TestWindow).halo.getConversation(spaceId, conversationId), first)
    expect(saved.success).toBe(true)
    expect((saved.data as any).messages.at(-1).content).toContain(`WRITTEN ${nonce}`)
    const title = (saved.data as { title: string }).title
    expect(title.length).toBeGreaterThan(0)
    await window.reload()
    await navigateToChat(window)
    await window.getByText(title, { exact: true }).first().click()
    await expect(window.locator('.message-assistant').last()).toContainText(`WRITTEN ${nonce}`)
    const second = await send(window, 'Without using tools, reply with only the value you wrote in the previous turn.')
    expect(second.conversationId).toBe(first.conversationId)
    expect(second.tools).toHaveLength(0)
    await expect(window.locator('.message-assistant').last()).toContainText(nonce)
    await window.screenshot({ path: testInfo.outputPath('completed-chat.png') })
    const initialApp = app
    app = undefined
    await close(initialApp)

    app = await launchElectronApp(entry, profile, { bootstrapDirectory: project })
    window = await app.firstWindow()
    await navigateToChat(window)
    await window.getByText(title, { exact: true }).first().click()
    await expect(window.locator('.message-assistant').last()).toContainText(nonce)
    const third = await send(window, 'Again, without tools, reply with only that same saved value.')
    expect(third.conversationId).toBe(first.conversationId)
    expect(third.tools).toHaveLength(0)
    await expect(window.locator('.message-assistant').last()).toContainText(nonce)
    await window.screenshot({ path: testInfo.outputPath('resumed-chat.png') })
    const resumedApp = app
    app = undefined
    await close(resumedApp)
  } catch (error) {
    failed = true
    throw error
  } finally {
    await finish(app, profile, testInfo, failed)
  }
})

test('Halo SDK stops a running command from the UI and accepts another turn', async ({}, testInfo) => {
  if (process.platform === 'win32') throw new Error('Application subprocess ancestry validation currently requires POSIX ps')
  const { entry, profile } = createProfile()
  const readiness = join(profile, 'cancel-ready.json')
  const nonce = randomUUID()
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const script = 'const fs = require("node:fs"); const path = ' + JSON.stringify(readiness) + ';' +
    ' fs.writeFileSync(path + ".tmp", JSON.stringify({pid:process.pid, nonce:' + JSON.stringify(nonce) + '}));' +
    ' fs.renameSync(path + ".tmp", path); setInterval(() => {}, 1000);'
  const command = quote(process.execPath) + ' -e ' + quote(script)
  let app: ElectronApplication | undefined
  let failed = false
  try {
    app = await launchElectronApp(entry, profile, { bootstrapDirectory: project })
    const window = await app.firstWindow()
    await navigateToChat(window)
    await verifyRuntime(app, window, testInfo)
    await begin(window, 'Run exactly this command using Bash in the foreground, with timeout 120000 and run_in_background false. Do not change it or start other tools; wait for me to stop it.\n' + command)
    await expect.poll(() => existsSync(readiness), { timeout: 90000 }).toBe(true)
    const ready = JSON.parse(readFileSync(readiness, 'utf8')) as { pid: number; nonce: string }
    expect(ready.nonce).toBe(nonce)
    expect(Number.isInteger(ready.pid) && ready.pid > 1).toBe(true)
    const ancestors: number[] = []
    let pid = ready.pid
    for (let depth = 0; depth < 16 && pid > 1; depth++) {
      ancestors.push(pid)
      if (pid === app.process().pid) break
      pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    }
    expect(ancestors).toContain(app.process().pid)
    const original = await window.evaluate(() => {
      const probe = (globalThis as unknown as TestWindow).sdkProbe!
      return { conversationId: probe.conversationId, tools: probe.tools }
    })
    expect(original.tools).toContain('Bash')
    await window.getByTitle('Stop generation (Esc)', { exact: true }).click()
    await waitForIdle(window, 20000)
    await expect.poll(() => {
      try { process.kill(ready.pid, 0); return true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
    }, { timeout: 10000 }).toBe(false)
    const recovered = await send(window, 'Without tools, reply with exactly CANCEL_RECOVERED ' + nonce)
    expect(recovered.conversationId).toBe(original.conversationId)
    expect(recovered.tools).toHaveLength(0)
    await expect(window.locator('.message-assistant').last()).toContainText('CANCEL_RECOVERED ' + nonce)
    await testInfo.attach('cancelled-command', { body: JSON.stringify({ ...ready, ancestors, exited: true }), contentType: 'application/json' })
    await window.screenshot({ path: testInfo.outputPath('cancel-recovered.png') })
  } catch (error) {
    failed = true
    throw error
  } finally {
    await finish(app, profile, testInfo, failed)
  }
})
