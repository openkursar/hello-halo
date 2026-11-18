import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { SubagentModelSettings } from '../../../src/shared/types/subagent-models'
import { expect } from './acceptance-app'

export type AssignmentMethod = 'listSubagentModels' | 'createSubagentModel' | 'updateSubagentModel' | 'clearBuiltinSubagentModel' | 'deleteSubagentModel' | 'setSubagentModelSelectionMode'
export interface AssignmentResult { success: boolean; data?: SubagentModelSettings; error?: string; code?: string }

export async function assignmentCall(page: Page, method: AssignmentMethod, input?: unknown): Promise<AssignmentResult> {
  return page.evaluate(async ({ method, input }) => {
    const api = (globalThis as unknown as { halo: HaloAPI }).halo
    const operation = api[method] as (input?: unknown) => Promise<AssignmentResult>
    return operation(input)
  }, { method, input })
}

export async function assignmentSettings(page: Page) {
  const result = await assignmentCall(page, 'listSubagentModels')
  expect(result.success, result.error).toBe(true)
  expect(result.data).toBeTruthy()
  return result.data!
}

export function storedAssignmentConfig(profile: string) {
  const config = JSON.parse(readFileSync(join(profile, '.halo/config.json'), 'utf8'))
  return {
    settings: config.aiSources?.subagentModels as SubagentModelSettings | undefined,
    currentId: config.aiSources?.currentId as string | undefined,
    currentGroupId: config.aiSources?.currentGroupId as string | undefined,
    model: config.api?.model as string | undefined,
    sources: config.aiSources?.sources.map((source: { id: string; model: string }) => ({ id: source.id, model: source.model })),
  }
}

export async function bindSmall(page: Page, sourceId = 'acceptance-local') {
  const before = await assignmentSettings(page)
  const slot = before.profiles.find(profile => profile.id === 'builtin:small')!
  const result = await assignmentCall(page, 'updateSubagentModel', {
    id: slot.id, expectedRevision: slot.revision, description: 'Precise field extraction',
    target: { kind: 'model', sourceId, modelId: 'gpt-4o' },
  })
  expect(result.success, result.error).toBe(true)
  return result.data!
}

export async function openAssignmentPanel(page: Page) {
  await page.getByRole('button', { name: 'More ways to add', exact: true }).click()
  await page.getByRole('button', { name: 'Configure model assignments', exact: true }).click()
  const panel = page.locator('[data-subagent-models-manager]')
  await expect(panel).toBeVisible()
  return panel
}
