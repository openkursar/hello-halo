import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { test, expect } from '../fixtures/acceptance-app'
import { navigateToSettings } from '../fixtures/helpers'

test.setTimeout(90000)

interface StoredConfiguration {
  appearance: { theme: string }
  aiSources: {
    currentId: string | null
    sources: Array<{ id: string; name: string; provider: string; model: string; authType: string; apiUrl: string; apiKey: string }>
  }
  permissions: unknown
  agent: { sdkEngine: string; configDirMode: string }
}

function readConfiguration(file: string): StoredConfiguration {
  return JSON.parse(readFileSync(file, 'utf8')) as StoredConfiguration
}

function preservedSettings(config: StoredConfiguration) {
  return {
    currentSource: config.aiSources.currentId,
    sources: config.aiSources.sources.map(({ id, name, provider, model, authType, apiUrl }) => ({ id, name, provider, model, authType, apiUrl })),
    permissions: config.permissions,
    engine: config.agent.sdkEngine,
    configDirMode: config.agent.configDirMode,
  }
}

async function effectiveSourceCredentials(page: Page) {
  return page.evaluate(async () => {
    const result = await (window as unknown as { halo: HaloAPI }).halo.getConfig()
    if (!result.success || !result.data) throw new Error('Could not read the recovered application configuration')
    const config = result.data as StoredConfiguration
    return {
      currentSource: config.aiSources.currentId,
      sources: config.aiSources.sources.map(source => ({
        id: source.id, authType: source.authType, apiUrl: source.apiUrl,
        matchesSyntheticCredential: source.apiKey === 'local-scripted-endpoint',
      })),
    }
  })
}

function digest(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function reachStartupSurface(page: Page, target: Locator): Promise<boolean> {
  const skipGitBash = page.getByRole('radio', { name: /Skip, install manually later/ })
  await expect(skipGitBash.or(target).first()).toBeVisible({ timeout: 15000 })
  if (!await skipGitBash.isVisible()) return false
  await skipGitBash.check()
  await expect(skipGitBash).toBeChecked()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(target).toBeVisible({ timeout: 15000 })
  return true
}

test('an unreadable configuration survives a refused setup save and recovers through Check again', {
  annotation: {
    type: 'acceptance',
    description: JSON.stringify({ caseId: 'settings.safety.unreadable', evidence: 'app-e2e', mode: 'none', variant: {} }),
  },
}, async ({ acceptanceApp, window, model }, testInfo) => {
  const file = join(acceptanceApp.profile, '.halo/config.json')
  const unrelated = join(acceptanceApp.profile, 'configuration-recovery-control.txt')
  const control = 'This unrelated file must survive configuration recovery.\n'
  writeFileSync(unrelated, control)
  const damaged = Buffer.from('{"acceptanceDamagedConfiguration": true,\n')
  const observations: Array<Record<string, unknown>> = []
  const recordBytes = (phase: string, expected: Buffer) => {
    const actual = readFileSync(file)
    observations.push({ phase, sha256: digest(actual), expectedSha256: digest(expected), unchanged: actual.equals(expected) })
    expect(actual.equals(expected), `${phase} must preserve the exact configuration bytes`).toBe(true)
  }
  try {
    const skippedInitially = await reachStartupSurface(window, window.locator('nav button').first())
    observations.push({ phase: 'initial-startup', skippedGitBash: skippedInitially })
    await navigateToSettings(window)
    const appearance = window.locator('#appearance')
    await appearance.scrollIntoViewIfNeeded()
    await appearance.getByRole('button', { name: 'Light', exact: true }).click()
    await expect(window.locator('html')).toHaveClass(/\blight\b/)
    await expect.poll(() => readConfiguration(file).appearance.theme).toBe('light')
    const credentials = await effectiveSourceCredentials(window)
    expect(credentials).toEqual({ currentSource: 'acceptance-local', sources: [{
      id: 'acceptance-local', authType: 'api-key', apiUrl: model.url, matchesSyntheticCredential: true,
    }] })

    let savedBytes!: Buffer
    let retained!: ReturnType<typeof preservedSettings>
    const reopened = await acceptanceApp.restart(() => {
      savedBytes = readFileSync(file)
      retained = preservedSettings(readConfiguration(file))
      expect(retained.currentSource).toBe('acceptance-local')
      expect(retained.sources).toContainEqual(expect.objectContaining({ id: 'acceptance-local', name: 'Local acceptance model', provider: 'openai', model: 'gpt-4o' }))
      writeFileSync(file, damaged)
      recordBytes('damaged-after-confirmed-exit', damaged)
    })
    const warning = reopened.getByRole('alert').filter({ hasText: 'The configuration file cannot be read. Halo has paused saving settings to protect your data.' })
    await expect(warning).toBeVisible()
    await expect(warning).toContainText(file)
    const preferences = reopened.getByText("Let's set things up", { exact: true })
    const skippedAfterDamage = await reachStartupSurface(reopened, preferences)
    observations.push({ phase: 'damaged-startup', surface: 'first-launch-preferences', skippedGitBash: skippedAfterDamage })
    await expect(reopened.locator('nav').getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0)
    recordBytes('damaged-startup', damaged)

    const notSaved = reopened.getByRole('heading', { name: 'Not saved', exact: true })
    if (await notSaved.isVisible()) {
      await notSaved.locator('..').locator('..').getByRole('button', { name: 'Dismiss', exact: true }).click()
      await expect(notSaved).toHaveCount(0)
    }
    await reopened.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect(reopened.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await reopened.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(notSaved).toBeVisible()
    await expect(reopened.getByText('Halo cannot read its configuration file, so this change was not saved.', { exact: true }).first()).toBeVisible()
    await expect(warning).toBeVisible()
    recordBytes('refused-preferences-save', damaged)
    await testInfo.attach('unreadable-config-warning', { body: await reopened.screenshot(), contentType: 'image/png' })
    writeFileSync(file, savedBytes)
    await warning.getByRole('button', { name: 'Check again', exact: true }).click()
    await expect(warning).toHaveCount(0)
    await expect(reopened.getByRole('heading', { name: 'Settings reloaded', exact: true })).toBeVisible()
    await expect(reopened.locator('html')).toHaveClass(/\blight\b/)
    recordBytes('recovered-check', savedBytes)
    expect(preservedSettings(readConfiguration(file))).toEqual(retained)
    expect(await effectiveSourceCredentials(reopened)).toEqual(credentials)

    // Reloading settings preserves the current setup route; leave it through its real UI.
    await expect(reopened.getByRole('button', { name: 'Skip for now', exact: true })).toBeVisible()
    await reopened.getByRole('button', { name: 'Skip for now', exact: true }).click()
    await navigateToSettings(reopened)
    await expect(reopened.locator('#ai-model').getByText('Local acceptance model', { exact: true })).toBeVisible()
    const restoredAppearance = reopened.locator('#appearance')
    await restoredAppearance.scrollIntoViewIfNeeded()
    await restoredAppearance.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect(reopened.locator('html')).toHaveClass(/\btheme-dark\b/)
    await expect.poll(() => readConfiguration(file).appearance.theme).toBe('dark')
    expect(preservedSettings(readConfiguration(file))).toEqual(retained)
    expect(await effectiveSourceCredentials(reopened)).toEqual(credentials)
    observations.push({ phase: 'ordinary-save-after-recovery', theme: 'dark', preservedSettings: retained, sourceCredentials: credentials })

    const finalWindow = await acceptanceApp.restart()
    await navigateToSettings(finalWindow)
    await expect(finalWindow.locator('#ai-model').getByText('Local acceptance model', { exact: true })).toBeVisible()
    await expect(finalWindow.getByText('The configuration file cannot be read. Halo has paused saving settings to protect your data.', { exact: false })).toHaveCount(0)
    await expect(finalWindow.locator('html')).toHaveClass(/\btheme-dark\b/)
    expect(readConfiguration(file).appearance.theme).toBe('dark')
    expect(preservedSettings(readConfiguration(file))).toEqual(retained)
    expect(await effectiveSourceCredentials(finalWindow)).toEqual(credentials)
    expect(readFileSync(unrelated, 'utf8')).toBe(control)
    expect(model.exchanges).toEqual([])
    observations.push({ phase: 'restarted-after-recovery', theme: 'dark', unrelatedFilePreserved: true, modelRequests: model.exchanges.length })
  } finally {
    await testInfo.attach('configuration-recovery', { body: JSON.stringify({ observations }, null, 2), contentType: 'application/json' })
  }
})
