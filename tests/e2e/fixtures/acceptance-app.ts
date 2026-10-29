import { test as base, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestConfigDir, getAppEntryPath, launchElectronApp, cleanupTestConfigDir } from './electron'
import { startAcceptanceModel, type AcceptanceModel } from './acceptance-model'
import type { HaloAPI } from '../../../src/preload'

interface TurnRecord { conversationId: string; spaceId: string; completed: boolean }
interface AcceptanceProbe { turns: TurnRecord[]; errors: unknown[]; tools: string[]; dispose: () => void }
interface AcceptanceWindow { halo: HaloAPI; acceptanceProbe?: AcceptanceProbe }

export interface AcceptanceApp {
  profile: string
  app: ElectronApplication
  window: Page
  restart(afterClose?: (profile: string) => void | Promise<void>): Promise<Page>
}

interface Fixtures {
  model: AcceptanceModel
  acceptanceApp: AcceptanceApp
  window: Page
}

export function acceptance(caseId: string, variant: Record<string, string> = {}) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'app-e2e', mode: 'scripted', variant }) } }
}

async function attachProbe(window: Page) {
  await window.evaluate(() => {
    const state = globalThis as unknown as AcceptanceWindow
    state.acceptanceProbe?.dispose()
    const probe: AcceptanceProbe = { turns: [], errors: [], tools: [], dispose: () => {} }
    const stops = [
      state.halo.onAgentTurnStart(value => {
        const event = value as { conversationId: string; spaceId: string }
        probe.turns.push({ conversationId: event.conversationId, spaceId: event.spaceId, completed: false })
      }),
      state.halo.onAgentComplete(value => {
        const event = value as { conversationId: string }
        const turn = probe.turns.findLast(turn => turn.conversationId === event.conversationId && !turn.completed)
        if (turn) turn.completed = true
      }),
      state.halo.onAgentError(value => { probe.errors.push(value) }),
      state.halo.onAgentThought(value => {
        const event = value as { thought?: { type?: string; toolName?: string } }
        if (event.thought?.type === 'tool_use' && event.thought.toolName) probe.tools.push(event.thought.toolName)
      }),
    ]
    probe.dispose = () => stops.forEach(stop => stop())
    state.acceptanceProbe = probe
  })
}

interface OwnedApplication {
  app: ElectronApplication
  child: ChildProcess | null
}

function hasExited(owned: OwnedApplication): boolean {
  return !!owned.child && (owned.child.exitCode != null || owned.child.signalCode != null)
}

async function open(entry: string, profile: string, register: (app: ElectronApplication) => void) {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const app = await launchElectronApp(entry, profile, { bootstrapDirectory: project })
  register(app)
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await attachProbe(window)
  return { app, window }
}

async function close(owned: OwnedApplication) {
  const { app, child } = owned
  if (hasExited(owned)) return
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onExit!: () => void
  const exited = child ? new Promise<void>(resolve => { onExit = resolve; child.once('exit', onExit) }) : Promise.resolve()
  try {
    await Promise.race([
      Promise.all([app.close(), exited]),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Acceptance application did not close within 15 seconds')), 15000) }),
    ])
    if (!child) throw new Error('Acceptance application exit could not be confirmed without a process handle')
  } finally { clearTimeout(timeout); if (child) child.removeListener('exit', onExit) }
}

async function attachEvidence(profile: string, model: AcceptanceModel, info: TestInfo) {
  await info.attach('scripted-model-exchanges', { body: JSON.stringify({ exchanges: model.exchanges, errors: model.errors }, null, 2), contentType: 'application/json' })
  const log = join(profile, '.halo/logs/main.log')
  if (existsSync(log)) await info.attach('application-main-log', { body: readFileSync(log).subarray(-1000000), contentType: 'text/plain' })
}

export const test = base.extend<Fixtures>({
  model: async ({}, use) => {
    const model = await startAcceptanceModel()
    try { await use(model) } finally { await model.close() }
  },
  acceptanceApp: async ({ model }, use, testInfo) => {
    const entry = getAppEntryPath()
    const profile = createTestConfigDir(entry, [])
    const file = join(profile, '.halo/config.json')
    const config = JSON.parse(readFileSync(file, 'utf8'))
    const now = new Date().toISOString()
    config.api = { provider: 'openai', apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: 'gpt-4o' }
    config.aiSources = { version: 2, currentId: 'acceptance-local', sources: [{ id: 'acceptance-local', name: 'Local acceptance model', authType: 'api-key', ...config.api, availableModels: [{ id: 'gpt-4o', name: 'gpt-4o' }], createdAt: now, updatedAt: now }] }
    config.agent = { ...config.agent, sdkEngine: 'halo', configDirMode: 'custom', customConfigDir: join(profile, 'sdk-state'), maxTurns: 16 }
    config.imChannels = { instances: [] }
    config.notificationChannels = {}
    writeFileSync(file, JSON.stringify(config, null, 2))
    const applications: OwnedApplication[] = []
    let launchWithoutHandle = false
    const openOwned = async () => {
      let registered = false
      try {
        return await open(entry, profile, app => {
          const owned: OwnedApplication = { app, child: null }
          applications.push(owned)
          // The public Playwright facade may be disposed before final cleanup.
          owned.child = app.process() ?? null
          if (!owned.child) throw new Error('The launched acceptance application did not expose a process handle')
          registered = true
        })
      } catch (error) {
        if (!registered) launchWithoutHandle = true
        throw error
      }
    }
    const closeOwned = async (app: ElectronApplication) => {
      const owned = applications.find(owned => owned.app === app)
      if (!owned) throw new Error('Refusing to close an application outside this acceptance fixture')
      await close(owned)
    }
    const failures: unknown[] = []
    let session: AcceptanceApp | undefined
    try {
      const launched = await openOwned()
      session = {
        profile, ...launched,
        async restart(afterClose) {
          await closeOwned(this.app)
          if (afterClose) await afterClose(profile)
          const next = await openOwned()
          this.app = next.app
          this.window = next.window
          return this.window
        },
      }
      const availability = await session.window.evaluate(() => (globalThis as unknown as AcceptanceWindow).halo.getEngineAvailability())
      expect(availability).toMatchObject({ success: true, data: { activeEngine: 'halo', degradedFrom: null } })
      await testInfo.attach('application-runtime', { body: JSON.stringify(await session.app.evaluate(({ app }) => ({ packaged: app.isPackaged, platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node }))), contentType: 'application/json' })
      await use(session)
      expect(model.errors, 'Every model request must match the declared script').toEqual([])
    } catch (error) {
      failures.push(error)
    } finally {
      try {
        if (session && !session.window.isClosed()) await session.window.screenshot({ path: testInfo.outputPath('final-window.png') })
      } catch (error) { failures.push(error) }
      for (const owned of applications) {
        try { await close(owned) } catch (error) { failures.push(error) }
      }
      try { await attachEvidence(profile, model, testInfo) } catch (error) { failures.push(error) }
      if (!launchWithoutHandle && applications.length > 0 && applications.every(hasExited)) {
        try { cleanupTestConfigDir(profile) } catch (error) { failures.push(error) }
      } else {
        console.error('[AcceptanceApp] Retained the isolated profile because application exit was not established', {
          profile, launchWithoutHandle, pids: applications.filter(owned => !hasExited(owned)).map(owned => owned.child?.pid ?? null),
        })
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, `Acceptance fixture lifecycle failed: ${failures.map(error => error instanceof Error ? error.message : String(error)).join('; ')}`)
  },
  window: async ({ acceptanceApp }, use) => { await use(acceptanceApp.window) },
})

export async function sendAcceptanceMessage(window: Page, message: string) {
  const count = await window.evaluate(() => (globalThis as unknown as AcceptanceWindow).acceptanceProbe!.turns.length)
  await window.locator('textarea').first().fill(message)
  await window.locator('[data-onboarding="send-button"]').click()
  await expect.poll(() => window.evaluate(() => (globalThis as unknown as AcceptanceWindow).acceptanceProbe!.turns.length)).toBeGreaterThan(count)
  return window.evaluate(() => (globalThis as unknown as AcceptanceWindow).acceptanceProbe!.turns.at(-1)!)
}

export async function waitForAcceptanceIdle(window: Page, conversationId: string, options: {
  timeout?: number
  expectedErrors?: readonly unknown[]
} = {}) {
  await expect.poll(() => window.evaluate(async id => {
    const state = globalThis as unknown as AcceptanceWindow
    const session = await state.halo.getSessionState(id)
    if (!session.success) throw new Error('Could not inspect the real application session')
    return { active: (session.data as { isActive: boolean }).isActive, errors: state.acceptanceProbe!.errors }
  }, conversationId), { timeout: options.timeout ?? 30000 }).toEqual({ active: false, errors: options.expectedErrors ?? [] })
  await expect(window.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
}

export async function readAcceptanceErrors(window: Page) {
  return window.evaluate(() => (globalThis as unknown as AcceptanceWindow).acceptanceProbe!.errors)
}

export async function readAcceptanceConversation(window: Page, spaceId: string, conversationId: string) {
  return window.evaluate(async ({ spaceId, conversationId }) => {
    const result = await (globalThis as unknown as AcceptanceWindow).halo.getConversation(spaceId, conversationId)
    if (!result.success || !result.data) throw new Error('The conversation could not be read from persistent storage')
    return result.data as { id: string; title: string; messages: Array<{ id: string; role: string; content: string; error?: string; images?: Array<{ data?: string; mediaType?: string }> }> }
  }, { spaceId, conversationId })
}

export { expect } from '@playwright/test'
