import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import type { HaloAPI } from '../../../src/preload'
import type { EngineAvailabilityReport, HaloConfig } from '../../../src/renderer/types'
import { navigateToSettings } from './helpers'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page, TestInfo } from '@playwright/test'
import { expect, type AcceptanceApp } from './acceptance-app'

export async function assertNoCcRecoveryNotice(page: Page) {
  // A negative assertion must survive asynchronous availability rendering before any send.
  for (let sample = 0; sample < 12; sample++) {
    await expect(page.getByText(/^(Set up Claude Code|Install or connect Claude Code|Continue with Halo SDK|Halo SDK is currently running\.)/)).toHaveCount(0)
    await page.waitForTimeout(250)
  }
}

export function seedAutomaticCcInstallation(profile: string) {
  const selectedPath = process.env.HALO_ACCEPTANCE_CLAUDE_CLI
  if (!selectedPath || !existsSync(selectedPath)) throw new Error('Blocked prerequisite: HALO_ACCEPTANCE_CLAUDE_CLI must name an installed external Claude Code')
  const file = join(profile, '.halo', 'config.json')
  const config: { agent?: Partial<NonNullable<HaloConfig['agent']>> } = JSON.parse(readFileSync(file, 'utf8'))
  config.agent = { ...config.agent, sdkEngine: 'anthropic', ccRuntime: { selectedPath } }
  writeFileSync(file, JSON.stringify(config))
  const root = join(profile, '.halo', 'runtimes', 'claude-code')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'catalog.json'), JSON.stringify({ version: 1, truncated: false, entries: [
    { installation: { path: selectedPath, compatibility: 'unchecked', managed: false, recommended: false } },
  ] }))
  return selectedPath
}

export async function readCcAvailability(page: Page) {
  const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
  expect(result.success).toBe(true)
  expect(result.data).toBeTruthy()
  return result.data as EngineAvailabilityReport
}

export async function reselectAutomaticCcInstallation(session: AcceptanceApp, page: Page, info: TestInfo, selectedPath: string, fromNotice = false) {
  if (fromNotice) await page.getByRole('button', { name: 'Select Claude Code in Settings', exact: true }).click()
  else {
    await navigateToSettings(page)
    await page.locator('#advanced').scrollIntoViewIfNeeded()
    await page.getByRole('button', { name: 'Set up Claude Code', exact: true }).click()
  }
  const panel = page.getByRole('region', { name: 'Claude Code setup', exact: true })
  const item = panel.getByRole('list', { name: 'Installed Claude Code versions', exact: true }).getByRole('article').filter({ hasText: selectedPath })
  await expect(item).toBeVisible()
  await item.getByText('Details', { exact: true }).click()
  await expect(item.getByText(selectedPath, { exact: true })).toBeVisible()
  await expect(item.getByRole('button', { name: 'Use this version', exact: true })).toBeEnabled()
  for (let sample = 0; sample < 12; sample++) {
    expect((await readCcAvailability(page)).engines.find(engine => engine.engineId === 'anthropic')?.available).toBe(false)
    await expect(item.getByText('Selected', { exact: true })).toHaveCount(0)
    await page.waitForTimeout(250)
  }
  await assertEngineDiscovery(session, info)
  const configFile = join(session.profile, '.halo', 'config.json')
  expect(JSON.parse(readFileSync(configFile, 'utf8')).agent.ccRuntime).toEqual({ selectedPath })
  await item.getByRole('button', { name: 'Use this version', exact: true }).click()
  await expect(item.getByRole('button', { name: 'Selected', exact: true })).toBeDisabled()
  await expect.poll(async () => (await readCcAvailability(page)).engines.find(engine => engine.engineId === 'anthropic')?.available).toBe(true)
  await expect.poll(() => JSON.parse(readFileSync(configFile, 'utf8')).agent.ccRuntime).toMatchObject({ selectedPath, selectionOrigin: 'user' })
  const advanced = page.locator('#advanced')
  // Exercise saving the default independently of the installation selector's own activation.
  await advanced.locator('input[name="sdkEngine"][value="halo"]').check()
  await expect.poll(() => JSON.parse(readFileSync(configFile, 'utf8')).agent.sdkEngine).toBe('halo')
  await advanced.locator('input[name="sdkEngine"][value="anthropic"]').check()
  await expect.poll(() => JSON.parse(readFileSync(configFile, 'utf8')).agent.sdkEngine).toBe('anthropic')
  await expect(advanced.locator('input[name="sdkEngine"][value="anthropic"]')).toBeChecked()
  await expect.poll(() => readCcAvailability(page)).toMatchObject({ activeEngine: 'anthropic', degradedFrom: null })
  await assertEngineDiscovery(session, info, [selectedPath, realpathSync(selectedPath)])
}

export const engineDiscoveryObserver = fileURLToPath(new URL('./engine-discovery-observer.cjs', import.meta.url))

export async function assertEngineDiscovery(session: AcceptanceApp, info: TestInfo, selectedPaths: string[] = []) {
  const evidence = JSON.parse(readFileSync(join(session.profile, '.halo', 'engine-discovery-observation.json'), 'utf8')) as {
    pid: number; truncated: boolean; operations: Array<{ operation: string; path: string }>
  }
  await info.attach('engine-discovery-observation', { body: JSON.stringify(evidence), contentType: 'application/json' })
  expect(evidence.pid, 'Observation must belong to the restarted application').toBe(session.app.process().pid)
  expect(evidence.truncated).toBe(false)
  expect(evidence.operations.filter(item => item.operation === 'opendir'), 'No runtime discovery directories may be traversed').toEqual([])
  expect(evidence.operations.filter(item => !selectedPaths.includes(item.path)), 'Only the explicitly selected runtime may be inspected').toEqual([])
  if (selectedPaths.length) expect(evidence.operations.some(item => selectedPaths.includes(item.path))).toBe(true)
}
