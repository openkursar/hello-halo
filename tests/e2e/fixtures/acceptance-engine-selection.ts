import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { EngineAvailabilityReport, EngineId } from '../../../src/renderer/types'
import { expect } from './acceptance-app'
import { listManagedConversations } from './acceptance-management'
import { navigateToChat, navigateToSettings } from './helpers'

export type SelectionEngine = 'halo' | 'anthropic'

export interface EngineConversation {
  id: string
  title: string
  engineId?: EngineId
  messages: Array<{ id: string; role: string; content: string; error?: string }>
}

export function configuredEngine(profile: string): EngineId | undefined {
  return JSON.parse(readFileSync(join(profile, '.halo', 'config.json'), 'utf8')).agent?.sdkEngine
}

export async function engineReport(page: Page): Promise<EngineAvailabilityReport> {
  const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
  expect(result.success).toBe(true)
  expect(result.data).toBeTruthy()
  return result.data as EngineAvailabilityReport
}

export async function readEngineConversation(page: Page, id: string): Promise<EngineConversation> {
  const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.getConversation('halo-temp', id), id)
  expect(result.success).toBe(true)
  expect(result.data).toMatchObject({ id })
  return result.data as EngineConversation
}

export async function chooseEngine(page: Page, profile: string, engine: SelectionEngine) {
  await navigateToSettings(page)
  const section = page.locator('#advanced')
  const input = section.locator(`input[type="radio"][name="sdkEngine"][value="${engine}"]`)
  await expect(input).toBeEnabled()
  await input.check()
  await expect(input).toBeChecked()
  await expect.poll(() => configuredEngine(profile)).toBe(engine)
  await expect(section.getByText('Restart required for the engine change to take effect.', { exact: true })).toBeVisible()
  await expect(section.getByRole('button', { name: 'Restart Now', exact: true })).toBeEnabled()
}

export async function freshEngineConversation(page: Page, engine: SelectionEngine) {
  await navigateToChat(page)
  const before = new Set((await listManagedConversations(page)).map(conversation => conversation.id))
  const create = page.getByRole('button', { name: 'New', exact: true })
  await expect(create).toHaveCount(1)
  await create.click()
  await expect(page.locator('textarea').first()).toHaveValue('')
  await expect(page.locator('.message-user')).toHaveCount(0)
  await expect.poll(async () => (await listManagedConversations(page)).filter(conversation => !before.has(conversation.id)).length).toBe(1)
  const created = (await listManagedConversations(page)).find(conversation => !before.has(conversation.id))!
  const stored = await readEngineConversation(page, created.id)
  expect(stored).toMatchObject({ engineId: engine, messages: [] })
  return stored
}
