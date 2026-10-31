import { test as base, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import { cleanupTestConfigDir, createTestConfigDir, getAppEntryPath, launchElectronApp } from './electron'
import { seedDigitalHumanChat, type SeededDigitalHumanChat } from './seed-digital-human-chat'
import { navigateToApps, navigateToChat, navigateToWorkspaces, waitForHomePage } from './helpers'
import { closeManagementApp, trackManagementApp, type OwnedManagementApp } from './acceptance-management-process'

export interface ManagedSpace {
  id: string
  name: string
  path: string
  color?: string
  workingDir?: string
  isMissing?: boolean
}

export interface ManagedConversation {
  id: string
  title: string
  starred?: boolean
  messages: Array<{ id: string; role: string; content: string }>
}

interface ManagementApp {
  profile: string
  app: ElectronApplication
  window: Page
  personChat?: SeededDigitalHumanChat
  restart(): Promise<Page>
}

interface ManagementFixtures {
  diagnoseShutdown: boolean
  seedPersonChat: boolean
  managementApp: ManagementApp
  window: Page
}

export function managementAcceptance(caseId: string, variant: Record<string, string> = {}) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'app-e2e', mode: 'none', variant }) } }
}

export const test = base.extend<ManagementFixtures>({
  seedPersonChat: [false, { option: true }],
  diagnoseShutdown: [false, { option: true }],
  managementApp: async ({ seedPersonChat, diagnoseShutdown }, use, testInfo) => {
    const entry = getAppEntryPath()
    const profile = createTestConfigDir(entry, [])
    const configuration = join(profile, '.halo/config.json')
    const config = JSON.parse(readFileSync(configuration, 'utf8'))
    config.api = { provider: 'openai', apiKey: '', apiUrl: 'http://127.0.0.1:9', model: 'not-configured' }
    config.aiSources = { version: 2, currentId: null, sources: [] }
    config.agent = { ...config.agent, sdkEngine: 'halo', configDirMode: 'custom', customConfigDir: join(profile, 'sdk-state') }
    config.modelConfigSkipped = true
    config.imChannels = { instances: [] }
    config.notificationChannels = {}
    writeFileSync(configuration, JSON.stringify(config, null, 2))
    const personChat = seedPersonChat ? seedDigitalHumanChat(profile, { name: 'Management Recorder', turnCount: 3 }) : undefined
    const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const ownedApplications: OwnedManagementApp[] = []
    const close = async (app: ElectronApplication, phase: string) => {
      const owned = ownedApplications.find(owned => owned.application === app)
      if (!owned) throw new Error('Refusing to close an application outside this management fixture')
      await closeManagementApp(owned, 15000, phase)
    }
    const open = async () => {
      const app = await launchElectronApp(entry, profile, { bootstrapDirectory: project })
      ownedApplications.push(trackManagementApp(app, diagnoseShutdown))
      try {
        const window = await app.firstWindow()
        await window.waitForLoadState('domcontentloaded')
        await waitForHomePage(window)
        await expect.poll(() => window.evaluate(() => (globalThis.window as unknown as { halo: HaloAPI }).halo.appList({ type: 'automation' }).then(result => result.success)), {
          timeout: 30000,
          message: 'The real app manager must be ready after every launch and restart',
        }).toBe(true)
        return { app, window }
      } catch (error) {
        await close(app, 'startup-failure')
        throw error
      }
    }
    let session: ManagementApp | undefined
    try {
      session = {
        profile,
        personChat,
        ...await open(),
        async restart() {
          await close(this.app, 'restart')
          const next = await open()
          this.app = next.app
          this.window = next.window
          return this.window
        },
      }
      await use(session)
    } finally {
      try {
        if (session && !session.window.isClosed()) await session.window.screenshot({ path: testInfo.outputPath('management-final-window.png') })
      } finally {
        try {
          if (session) await close(session.app, 'teardown')
        } finally {
          const log = join(profile, '.halo/logs/main.log')
          if (existsSync(log)) await testInfo.attach('management-main-log', { body: readFileSync(log).subarray(-1000000), contentType: 'text/plain' })
          if (ownedApplications.every(owned => owned.closed)) cleanupTestConfigDir(profile)
          else console.error('[AcceptanceManagement] Retained the isolated profile because an owned application has not exited', { profile, pids: ownedApplications.filter(owned => !owned.closed).map(owned => owned.child.pid) })
          if (diagnoseShutdown) await testInfo.attach('management-shutdown-diagnostics', { body: JSON.stringify({ version: 1, applications: ownedApplications.map(owned => owned.diagnostics) }, null, 2), contentType: 'application/json' })
        }
      }
    }
  },
  window: async ({ managementApp }, use) => { await use(managementApp.window) },
})

export async function listManagedSpaces(page: Page): Promise<ManagedSpace[]> {
  const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.listSpaces())
  expect(result.success, 'Workspace records must be readable through the real application').toBe(true)
  return result.data as ManagedSpace[]
}

export async function seedManagedSpace(page: Page, name: string, customPath?: string): Promise<ManagedSpace> {
  const result = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.createSpace(input), { name, icon: 'folder', customPath })
  expect(result.success, 'Workspace precondition must use a real stored workspace').toBe(true)
  return result.data as ManagedSpace
}

export function workspaceCard(page: Page, name: string): Locator {
  return page.locator('[role="button"]:not([aria-roledescription="sortable"])').filter({
    has: page.getByRole('heading', { name, exact: true, level: 3 }),
  })
}

export async function openWorkspaceMenu(page: Page, name: string, action: string) {
  const card = workspaceCard(page, name)
  await expect(card).toHaveCount(1)
  await card.hover()
  await card.getByTitle('More', { exact: true }).click()
  await card.getByRole('button', { name: action, exact: true }).click()
}

export async function createWorkspaceThroughUi(page: Page, name: string): Promise<ManagedSpace> {
  await navigateToWorkspaces(page)
  await page.getByRole('button', { name: 'New Workspace', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Create Dedicated Workspace', exact: true })).toBeVisible()
  await page.getByPlaceholder('e.g. Payment Refactor', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('textarea')).toBeVisible()
  const space = (await listManagedSpaces(page)).find(space => space.name === name)
  expect(space, 'The UI-created workspace must exist in the real registry').toBeTruthy()
  return space!
}

export async function seedManagedConversation(page: Page, spaceId: string, title: string, messages: Array<{ role: string; content: string }>): Promise<ManagedConversation> {
  return page.evaluate(async ({ spaceId, title, messages }) => {
    const api = (window as unknown as { halo: HaloAPI }).halo
    const created = await api.createConversation(spaceId, title)
    if (!created.success || !created.data) throw new Error(`Could not create conversation precondition: ${created.error}`)
    const id = (created.data as { id: string }).id
    for (const message of messages) {
      const added = await api.addMessage(spaceId, id, message)
      if (!added.success) throw new Error(`Could not persist conversation precondition: ${added.error}`)
    }
    const named = await api.updateConversation(spaceId, id, { title })
    if (!named.success) throw new Error(`Could not name conversation precondition: ${named.error}`)
    const saved = await api.getConversation(spaceId, id)
    if (!saved.success || !saved.data) throw new Error('Conversation precondition could not be read back')
    return saved.data as ManagedConversation
  }, { spaceId, title, messages })
}

export async function readManagedConversation(page: Page, spaceId: string, id: string): Promise<ManagedConversation> {
  const result = await page.evaluate(({ spaceId, id }) => (window as unknown as { halo: HaloAPI }).halo.getConversation(spaceId, id), { spaceId, id })
  expect(result.success, 'Conversation must still be present in application storage').toBe(true)
  return result.data as ManagedConversation
}

export async function listManagedConversations(page: Page, spaceId = 'halo-temp'): Promise<Array<Omit<ManagedConversation, 'messages'>>> {
  const result = await page.evaluate(spaceId => (window as unknown as { halo: HaloAPI }).halo.listConversations(spaceId), spaceId)
  expect(result.success).toBe(true)
  return result.data as Array<Omit<ManagedConversation, 'messages'>>
}

export function conversationRow(page: Page, title: string): Locator {
  return page.getByText(title, { exact: true }).locator('..').filter({
    has: page.locator('button[title="Pin"], button[title="Unpin"]'),
  })
}

export async function openManagedConversation(page: Page, title: string, spaceId = 'halo-temp', options: { empty?: boolean } = {}) {
  await navigateToChat(page)
  const space = await page.evaluate(spaceId => (window as unknown as { halo: HaloAPI }).halo.getSpace(spaceId), spaceId)
  expect(space.success, 'The conversation workspace must still exist').toBe(true)
  const displayName = spaceId === 'halo-temp' ? 'Halo Workspace' : (space.data as ManagedSpace).name
  const selector = page.getByTitle(/^Current workspace: .* — click to switch$/)
  await expect(selector).toBeVisible()
  const expectedTitle = `Current workspace: ${displayName} — click to switch`
  if (await selector.getAttribute('title') !== expectedTitle) {
    await selector.click()
    const workspace = selector.locator('..').locator('[role="button"]').filter({ has: page.getByText(displayName, { exact: true }) })
    await expect(workspace).toHaveCount(1)
    await workspace.click()
    await expect(selector).toHaveAttribute('title', expectedTitle)
  }
  const row = conversationRow(page, title)
  await expect(row).toHaveCount(1)
  await row.click()
  if (options.empty) {
    await expect(page.getByRole('banner').getByText(title, { exact: true })).toBeVisible()
    await expect(page.locator('textarea').first()).toHaveValue('')
    await expect(page.locator('.message-user')).toHaveCount(0)
    await expect(page.locator('.message-assistant')).toHaveCount(0)
  } else {
    await expect(page.locator('[data-testid="transcript-scroller"]')).toBeVisible()
  }
}

export async function listManagedPeople(page: Page): Promise<InstalledApp[]> {
  const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.appList({ type: 'automation' }))
  expect(result.success).toBe(true)
  return result.data as InstalledApp[]
}

export async function readManagedPerson(page: Page, id: string): Promise<InstalledApp> {
  const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.appGet(id), id)
  expect(result.success).toBe(true)
  expect(result.data).toBeTruthy()
  return result.data as InstalledApp
}

export async function seedManagedPerson(page: Page, name: string): Promise<InstalledApp> {
  await expect.poll(() => page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.appList({ type: 'automation' }).then(result => result.success))).toBe(true)
  const result = await page.evaluate(name => (window as unknown as { halo: HaloAPI }).halo.appInstall({
    spaceId: 'halo-temp',
    spec: {
      spec_version: '1.0', version: '1.0.0', name, author: 'acceptance', type: 'automation',
      description: 'Reviews isolated acceptance evidence', system_prompt: 'Review the supplied evidence and explain its limits.',
      subscriptions: [], requires: {}, config_schema: [], permissions: [],
    },
  }), name)
  expect(result.success, 'Person precondition must be installed through production orchestration').toBe(true)
  const { appId, activationWarning } = result.data as { appId: string; activationWarning?: string }
  expect(activationWarning).toBeUndefined()
  return readManagedPerson(page, appId)
}

export async function openManagedPerson(page: Page, name: string) {
  await navigateToApps(page)
  const directory = page.getByRole('textbox', { name: 'Search digital humans', exact: true })
  if (!(await directory.isVisible())) await page.getByRole('button', { name: 'All digital humans', exact: true }).click()
  await directory.fill(name)
  await page.getByRole('button', { name, exact: true }).click()
}

export async function openManagedPersonSettings(page: Page, name: string) {
  await openManagedPerson(page, name)
  await page.getByRole('button', { name: 'Capabilities and settings', exact: true }).click()
  await expect(page.locator('#settings-group-identity')).toBeVisible()
}

export { expect } from '@playwright/test'
