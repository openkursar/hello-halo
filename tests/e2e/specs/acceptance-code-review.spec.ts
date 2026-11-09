import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { CollabSummary } from '../../../src/shared/apps/team-types'
import type { GitReviewRecord } from '../../../src/shared/types/git'
import { test, expect, acceptance, readAcceptanceConversation, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { commandWorkspace, openCommandWorkspace } from '../fixtures/acceptance-terminal'
import { completeReviewReport, createReviewScript, reviewFile, reviewMarker, reviewRoles } from '../fixtures/acceptance-code-review'
import { openChangesWithShortcut } from '../fixtures/changes-helpers'

async function prepareReview(page: Page, profile: string) {
  const space = await commandWorkspace(page, profile, 'Review fixture')
  execFileSync('git', ['init', '--quiet', space.workingDir], { stdio: 'pipe' })
  writeFileSync(join(space.workingDir, reviewFile), `export const marker = '${reviewMarker}'\n`)
  await openCommandWorkspace(page, space)
  await openChangesWithShortcut(page)
  await page.getByRole('tab', { name: /Overview & review/ }).click()
  await expect(page.getByRole('region', { name: 'AI review', exact: true })).toBeVisible()
  return space
}

async function latestReview(page: Page, spaceId: string, root: string): Promise<GitReviewRecord> {
  const result = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.codeReviewGetLatest(input.spaceId, input.root), { spaceId, root })
  expect(result.success).toBe(true)
  expect(result.data).toBeTruthy()
  return result.data!
}

async function collaboration(page: Page, conversationId: string): Promise<CollabSummary | null> {
  const result = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id), conversationId)
  expect(result.success).toBe(true)
  return (result.data as CollabSummary | null | undefined) ?? null
}

test('a quick review reads the captured source and retains its report in a separate conversation', acceptance('changes.review.quick'), async ({ acceptanceApp, model, window }) => {
  test.setTimeout(120000)
  const space = await prepareReview(window, acceptanceApp.profile)
  const script = createReviewScript(space.workingDir, 'quick')
  model.respond(script.reply)
  const card = window.getByRole('region', { name: 'AI review', exact: true })
  await card.getByRole('button', { name: 'Quick review', exact: true }).click()
  await expect(card.getByRole('heading', { name: 'Quick review report', exact: true })).toBeVisible({ timeout: 60000 })
  const record = await latestReview(window, space.id, space.workingDir)
  await waitForAcceptanceIdle(window, record.conversationId)
  expect(script.reads).toEqual(new Set(['coordinator']))
  expect(script.errors).toEqual([])
  expect(await collaboration(window, record.conversationId)).toBeNull()
  await card.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(window.locator('.message-assistant [data-message-content]').filter({ hasText: reviewMarker })).toBeVisible()
  const stored = await readAcceptanceConversation(window, space.id, record.conversationId)
  expect(stored.messages.findLast(message => message.role === 'assistant')?.content).toBe(completeReviewReport)
})

for (const outcome of ['complete', 'stopped', 'incomplete'] as const) {
  test(`a team review ${outcome} preserves the source outcome without closing collaboration`, acceptance('changes.review.team', { outcome }), async ({ acceptanceApp, model, window }, testInfo) => {
    test.setTimeout(180000)
    const space = await prepareReview(window, acceptanceApp.profile)
    const script = createReviewScript(space.workingDir, 'team', outcome)
    model.respond(script.reply)
    const card = window.getByRole('region', { name: 'AI review', exact: true })
    try {
      await card.getByRole('button', { name: 'Team review', exact: true }).click()
      await expect.poll(() => script.created.size, { timeout: 60000 }).toBe(3)
      const record = await latestReview(window, space.id, space.workingDir)
      expect(record).toMatchObject({ variant: 'team', repoRoot: space.workingDir, scope: { kind: 'uncommitted' }, fileCount: 1 })
      await expect.poll(() => [...script.reads].sort(), { timeout: 60000 }).toEqual(['coordinator', ...reviewRoles].sort())
      if (outcome === 'stopped') {
        await expect.poll(async () => (await collaboration(window, record.conversationId))?.members.filter(member => member.status === 'working').length).toBe(3)
        await expect.poll(async () => {
          const state = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getSessionState(id), record.conversationId)
          return (state.data as { isActive: boolean }).isActive
        }).toBe(false)
        const requests = script.sourceRequests
        await card.getByRole('button', { name: 'Stop', exact: true }).click()
        await expect(card.getByRole('heading', { name: 'Review stopped', exact: true })).toBeVisible()
        await expect.poll(() => model.exchanges.filter(exchange => exchange.cancelled && exchange.request.text.includes('REVIEW_WORK_')).length, { timeout: 30000 }).toBe(3)
        script.release()
        await expect.poll(async () => (await collaboration(window, record.conversationId))?.members.every(member => member.status !== 'working' && member.status !== 'waiting_user')).toBe(true)
        const stopped = await collaboration(window, record.conversationId)
        expect(stopped).toMatchObject({ active: true, stopped: true })
        expect(script.sourceRequests, 'Cancelled reviewer callbacks must not wake the source').toBe(requests)
        const reopened = await acceptanceApp.restart()
        await openCommandWorkspace(reopened, space)
        await openChangesWithShortcut(reopened)
        await reopened.getByRole('tab', { name: /Overview & review/ }).click()
        await expect(reopened.getByRole('region', { name: 'AI review', exact: true }).getByRole('heading', { name: 'Review stopped', exact: true })).toBeVisible()
        expect(script.sourceRequests, 'Restart must not replay cancelled reviewer results').toBe(requests)
      } else {
        if (outcome === 'incomplete') {
          await expect.poll(async () => (await readAcceptanceConversation(window, space.id, record.conversationId)).messages.findLast(message => message.role === 'assistant')?.content, { timeout: 60000 })
            .toContain('review report is partial')
        }
        const label = outcome === 'complete' ? 'Team review report' : 'Review incomplete'
        await expect(card.getByRole('heading', { name: label, exact: true })).toBeVisible({ timeout: 60000 })
        await waitForAcceptanceIdle(window, record.conversationId)
        const team = await collaboration(window, record.conversationId)
        expect(team).toMatchObject({ active: true })
        expect(team!.members.map(member => member.appId).sort()).toEqual([...script.created.values()].map(receipt => receipt.handle).sort())
        const history = await readAcceptanceConversation(window, space.id, record.conversationId)
        const report = history.messages.findLast(message => message.role === 'assistant')?.content
        if (outcome === 'complete') {
          expect(report).toContain(completeReviewReport)
          const reportId = history.messages.findLast(message => message.role === 'assistant')!.id
          const reopened = await acceptanceApp.restart()
          await openCommandWorkspace(reopened, space)
          await openChangesWithShortcut(reopened)
          await reopened.getByRole('tab', { name: /Overview & review/ }).click()
          await expect(reopened.getByRole('region', { name: 'AI review', exact: true }).getByRole('heading', { name: 'Team review report', exact: true })).toBeVisible()
          const restored = await readAcceptanceConversation(reopened, space.id, record.conversationId)
          expect(restored.messages.find(message => message.id === reportId)?.content).toBe(report)
        } else expect(report).toContain('review report is partial')
        await testInfo.attach('review-history', { body: JSON.stringify({ record, team, history }, null, 2), contentType: 'application/json' })
      }
      expect(script.errors).toEqual([])
    } finally {
      script.release()
    }
  })
}
