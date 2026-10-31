import { test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HaloAPI } from '../../../src/preload'
import { cleanupTestConfigDir, createTestConfigDir, getAppEntryPath, launchElectronApp } from './electron'
import { closeManagementApp, trackManagementApp, type OwnedManagementApp } from './acceptance-management-process'
import { startProviderGateway, type ProviderGateway } from './acceptance-model-settings'

interface FirstUseApp {
  profile: string
  app: ElectronApplication
  window: Page
  restart(): Promise<Page>
}

interface Fixtures {
  firstUseEngine: 'halo' | null
  providerGateway: ProviderGateway
  firstUseApp: FirstUseApp
  window: Page
}

export const test = base.extend<Fixtures>({
  firstUseEngine: [null, { option: true }],
  providerGateway: async ({}, use, info) => {
    const gateway = await startProviderGateway()
    try { await use(gateway) }
    finally {
      await gateway.close()
      await info.attach('first-use-provider-requests', { body: JSON.stringify({ requests: gateway.requests, errors: gateway.errors }, null, 2), contentType: 'application/json' })
      expect(gateway.errors).toEqual([])
    }
  },
  firstUseApp: async ({ firstUseEngine, providerGateway: _providerGateway }, use, info) => {
    const entry = getAppEntryPath()
    const profile = createTestConfigDir(entry, [])
    const file = join(profile, '.halo/config.json')
    const configuration = {
      api: { provider: 'openai', apiKey: '', apiUrl: 'http://127.0.0.1:9', model: 'not-configured' },
      aiSources: { version: 2, currentId: null, sources: [] },
      isFirstLaunch: true,
      modelConfigSkipped: false,
      onboarding: { completed: false },
      agent: { configDirMode: 'custom', customConfigDir: join(profile, 'engine-state'), ...(firstUseEngine ? { sdkEngine: firstUseEngine } : {}) },
      appStore: { registries: [], autoCheckUpdates: false, cacheTtlMs: 3600000 },
      imChannels: { instances: [] },
      notificationChannels: {},
    }
    writeFileSync(file, JSON.stringify(configuration, null, 2))
    await info.attach('first-use-prelaunch-state', { body: JSON.stringify({ previouslyLaunched: false, accountCount: 0, isFirstLaunch: true, modelConfigSkipped: false, onboardingCompleted: false, requestedEngine: firstUseEngine }, null, 2), contentType: 'application/json' })
    const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const applications: Array<{ app: ElectronApplication; owned: OwnedManagementApp | null }> = []
    const failures: unknown[] = []
    let unknownLaunch = false
    let session: FirstUseApp | undefined
    const open = async () => {
      let registered: { app: ElectronApplication; owned: OwnedManagementApp | null } | undefined
      try {
        const app = await launchElectronApp(entry, profile, { bootstrapDirectory: project })
        registered = { app, owned: null }
        applications.push(registered)
        registered.owned = trackManagementApp(app)
        const window = await app.firstWindow()
        await window.waitForLoadState('domcontentloaded')
        return { app, window }
      } catch (error) {
        if (!registered?.owned) unknownLaunch = true
        throw error
      }
    }
    const close = async (app: ElectronApplication, phase: string) => {
      const registered = applications.find(registered => registered.app === app)
      if (!registered) throw new Error('Refusing to close an application outside the first-use fixture')
      if (registered.owned) return closeManagementApp(registered.owned, 15000, phase)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          app.close(),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('First-use application did not close within 15 seconds')), 15000) }),
        ])
      } finally { clearTimeout(timer) }
      throw new Error('First-use application exit could not be confirmed without a process handle')
    }
    try {
      session = {
        profile, ...await open(),
        async restart() {
          await close(this.app, 'restart')
          const next = await open()
          this.app = next.app
          this.window = next.window
          return this.window
        },
      }
      await use(session)
    } catch (error) { failures.push(error) }
    finally {
      try { if (session && !session.window.isClosed()) await info.attach('first-use-final-window', { body: await session.window.screenshot(), contentType: 'image/png' }) }
      catch (error) { failures.push(error) }
      for (const registered of applications) {
        try { await close(registered.app, 'teardown') } catch (error) { failures.push(error) }
      }
      try {
        const log = join(profile, '.halo/logs/main.log')
        if (existsSync(log)) await info.attach('first-use-main-log', { body: readFileSync(log).subarray(-1000000), contentType: 'text/plain' })
      } catch (error) { failures.push(error) }
      if (!unknownLaunch && applications.length > 0 && applications.every(registered => registered.owned?.closed)) {
        try { cleanupTestConfigDir(profile) } catch (error) { failures.push(error) }
      } else console.error('[AcceptanceFirstUse] Retained the isolated profile because application exit was not established', { profile, unknownLaunch, pids: applications.filter(registered => !registered.owned?.closed).map(registered => registered.owned?.child.pid ?? null) })
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'First-use fixture lifecycle failed')
  },
  window: async ({ firstUseApp }, use) => { await use(firstUseApp.window) },
})

export async function completeFirstPreferences(page: Page) {
  const preferences = page.getByText("Let's set things up", { exact: true })
  const skipGitBash = page.getByRole('radio', { name: /Skip, install manually later/ })
  await expect(preferences.or(skipGitBash).first()).toBeVisible({ timeout: 15000 })
  const skippedGitBash = await skipGitBash.isVisible()
  if (skippedGitBash) {
    await skipGitBash.check()
    await expect(skipGitBash).toBeChecked()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
  }
  await expect(preferences).toBeVisible()
  await page.getByRole('button', { name: 'Light', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(preferences).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Skip for now', exact: true })).toBeVisible()
  return { skippedGitBash }
}

export async function firstUseState(page: Page, expectedKey?: string) {
  return page.evaluate(async expectedKey => {
    const result = await (window as unknown as { halo: HaloAPI }).halo.getConfig()
    if (!result.success || !result.data) throw new Error('Could not read the real first-use configuration')
    const config = result.data as {
      isFirstLaunch?: boolean; modelConfigSkipped?: boolean; onboarding?: { completed?: boolean }; appearance?: { theme?: string }
      aiSources: { currentId: string | null; sources: Array<{ id: string; name: string; provider: string; authType: string; apiUrl: string; apiKey: string; model: string }> }
    }
    return {
      isFirstLaunch: config.isFirstLaunch, modelConfigSkipped: config.modelConfigSkipped ?? false,
      onboardingCompleted: config.onboarding?.completed ?? false, theme: config.appearance?.theme,
      currentId: config.aiSources.currentId,
      sources: config.aiSources.sources.map(source => ({
        id: source.id, name: source.name, provider: source.provider, authType: source.authType, apiUrl: source.apiUrl, model: source.model,
        ...(expectedKey === undefined ? {} : { credentialMatches: source.apiKey === expectedKey }),
      })),
    }
  }, expectedKey)
}

export function firstUseAcceptance(caseId: string, mode: 'scripted' | 'none') {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'app-e2e', mode, variant: {} }) } }
}

export { expect } from '@playwright/test'
