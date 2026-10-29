import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { ActivityEntry } from '../../../src/shared/apps/app-types'
import { expect, readAutomationActivity, readAutomationRuns, readAutomationState } from './acceptance-automation'

export {
  test, expect, acceptance, openAutomation, startAutomation, readAutomationActivity,
  readAutomationRuns, readAutomationState, readAutomationTranscript,
} from './acceptance-automation'

export function decisionCard(page: Page, entryId: string) {
  return page.locator(`[id="activity-${entryId}"]`)
}

export async function readDecision(page: Page, appId: string, entryId: string): Promise<ActivityEntry> {
  const result = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appGetActivityEntry(input), { appId, entryId })
  expect(result.success, 'The actual decision record must remain readable').toBe(true)
  expect(result.data).toMatchObject({ id: entryId, appId, type: 'escalation' })
  return result.data!
}

export async function pendingDecisions(page: Page, appId: string): Promise<ActivityEntry[]> {
  const result = await page.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appGetPendingEntries({ appId }), appId)
  expect(result.success).toBe(true)
  return result.data!
}

export async function waitForDecisionQuestion(page: Page, appId: string, runId: string, question: string): Promise<ActivityEntry> {
  const matches = async () => (await readAutomationActivity(page, appId)).filter(entry => entry.runId === runId && entry.type === 'escalation' && entry.content.summary === question)
  await expect.poll(async () => (await matches()).length, { timeout: 30000 }).toBe(1)
  await expect.poll(async () => (await readAutomationRuns(page, appId)).find(run => run.runId === runId)?.status, { timeout: 30000 }).toBe('waiting_user')
  await expect.poll(async () => ['running', 'queued'].includes((await readAutomationState(page, appId)).status), { timeout: 30000 }).toBe(false)
  const entry = (await matches())[0]
  expect(entry.userResponse).toBeUndefined()
  expect(entry.continuation).toBeUndefined()
  await expect(decisionCard(page, entry.id)).toHaveCount(1)
  await expect(decisionCard(page, entry.id)).toContainText(question)
  await expect(decisionCard(page, entry.id).getByRole('button', { name: 'Submit and continue this work', exact: true })).toBeDisabled()
  return entry
}

export async function waitForDecisionCompletion(page: Page, appId: string, entry: ActivityEntry) {
  await expect.poll(async () => (await readDecision(page, appId, entry.id)).continuation?.status, { timeout: 45000, message: 'The saved answer must complete exactly one continuation of its original work' }).toBe('completed')
  await expect.poll(async () => (await readAutomationRuns(page, appId)).find(run => run.runId === entry.runId)?.status).toBe('ok')
  await expect.poll(async () => ['running', 'queued'].includes((await readAutomationState(page, appId)).status)).toBe(false)
  const stored = await readDecision(page, appId, entry.id)
  expect(stored.runId).toBe(entry.runId)
  expect(stored.sessionKey).toBe(entry.sessionKey)
  expect(stored.continuation).toMatchObject({ status: 'completed', attempts: 1 })
  return stored
}

export async function assertAnsweredCard(page: Page, entryId: string, answer: string) {
  const card = decisionCard(page, entryId)
  await expect(card).toHaveCount(1)
  await expect(card.getByText('Answered', { exact: true }).first()).toBeVisible()
  await expect(card).toContainText(answer)
  await expect(card.getByRole('button', { name: /Submit and continue this work|Sending your answer/ })).toHaveCount(0)
  await expect(card.getByRole('textbox')).toHaveCount(0)
}
