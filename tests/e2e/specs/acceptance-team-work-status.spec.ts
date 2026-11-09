import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { AutomationAppState } from '../../../src/shared/apps/app-types'
import { buildTeamSessionKey } from '../../../src/shared/apps/im-keys'
import type { Team, TeamConversation, TeamDetail } from '../../../src/shared/apps/team-types'
import { openPeoplePage, openTeamCard } from '../fixtures/acceptance-team-pages'
import { test, expect, acceptance } from '../fixtures/acceptance-app'
import { createModelGate } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'

const teamName = 'Launch crew'
const memberName = 'Dev'
const message = 'Dev, please draft the launch checklist for this release.'
const answer = 'Dev drafted the launch checklist.'

async function installPerson(page: Page, name: string): Promise<string> {
  const installed = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appInstall({ spaceId: 'halo-temp',
    spec: { spec_version: '1.0', type: 'automation', version: '1.0.0', name: input, author: 'Acceptance author',
      description: 'A team member whose working state is watched outside the team view.', system_prompt: 'Answer the team message briefly.',
      subscriptions: [], requires: {}, config_schema: [], permissions: [] },
  }), name)
  expect(installed.success, `Install ${name}`).toBe(true)
  return (installed.data as { appId: string }).appId
}

async function teamWorking(page: Page, appId: string): Promise<boolean> {
  const states = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.appGetAllStates())
  expect(states.success).toBe(true)
  return (states.data as Record<string, AutomationAppState>)[appId]?.teamWorking === true
}

/** The space rail's Digital Humans tab, opened from the conversation page of the current space. */
async function openRail(page: Page): Promise<Locator> {
  await navigateToChat(page)
  const files = page.getByRole('button', { name: 'Files', exact: true })
  if (!await files.isVisible()) await page.getByRole('button', { name: 'Open workspace resources', exact: true }).click()
  const strip = files.locator('xpath=..')
  await strip.getByRole('button', { name: 'Digital Humans', exact: true }).click()
  await expect(strip.getByRole('button', { name: 'Digital Humans', exact: true })).toHaveAttribute('aria-current', 'true')
  return page.locator('div.overflow-y-auto:visible').filter({ has: page.locator('[role="button"]') }).filter({ hasText: memberName }).last()
}

function railRow(rail: Locator, name: string): Locator {
  return rail.locator('[role="button"]').filter({ has: rail.page().getByText(name, { exact: true }) })
}

async function expectRail(page: Page, lead: string, status: 'Working' | 'Standing by') {
  const rail = await openRail(page)
  const member = railRow(rail, memberName)
  await expect(member).toHaveCount(1)
  await expect(member.getByText(status, { exact: true })).toBeVisible()
  const leadRow = railRow(rail, lead)
  await expect(leadRow).toHaveCount(1)
  await expect(leadRow.getByText(/^Team lead · /)).toHaveText(/^Team lead · (Standing by|Working)$/)
  await member.hover()
  await expect(member.getByRole('button', { name: 'Chat', exact: true })).toBeVisible()
  await leadRow.hover()
  await expect(leadRow.getByRole('button', { name: 'Chat', exact: true })).toHaveCount(0)
  return { rail, leadRow }
}

async function expectSwitcher(page: Page, status: 'Working' | 'Standing by') {
  const other = status === 'Working' ? 'Standing by' : 'Working'
  await openPeoplePage(page)
  await page.getByRole('button', { name: 'My Digital Humans', exact: true }).click()
  await expect(page.locator('article').first()).toBeVisible()
  const card = page.locator('article').filter({ has: page.getByRole('button', { name: memberName, exact: true }) })
  await expect(card).toContainText(status)
  await expect(card).not.toContainText(other)
  await card.getByRole('button', { name: memberName, exact: true }).click()
  const entry = page.getByRole('button', { name: memberName, exact: true }).and(page.locator('[aria-current]'))
  await expect(entry).toHaveCount(1)
  await entry.hover()
  const tooltip = page.getByRole('tooltip').filter({ hasText: memberName })
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText(status)
  await expect(tooltip).not.toContainText(other)
  await page.mouse.move(0, 0)
  await expect(tooltip).toHaveCount(0)
}

async function sendInTeamView(page: Page, memberAppId: string) {
  await openTeamCard(page, teamName)
  const room = page.getByRole('region', { name: 'Task room', exact: true })
  const target = room.getByRole('combobox', { name: 'Choose who to talk to', exact: true })
  await expect(room.locator('textarea')).toBeVisible()
  await target.selectOption(memberAppId)
  await expect(target).toHaveValue(memberAppId)
  await room.locator('textarea').fill(message)
  await room.locator('textarea').press('Enter')
  await expect(room.locator('textarea')).toHaveValue('')
}

test('a team member reads Working in the space rail and the people switcher while it answers in the team view and Standing by afterwards, and the lead is listed with its mark and no Chat action', acceptance('people.directory.team-work-status'), async ({ model, window }, testInfo) => {
  test.setTimeout(180000)
  await window.setViewportSize({ width: 1440, height: 1000 })
  const gate = createModelGate()
  model.respond(request => {
    if (request.lastUserText.includes(message)) return { text: answer, hold: gate.promise }
    throw new Error(`Unexpected team-status model request ${request.sequence}: ${request.lastUserText.slice(-500)}`)
  })
  await expect.poll(() => window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.teamList().then(result => result.success)), { timeout: 30000 }).toBe(true)
  const dev = await installPerson(window, memberName)
  const created = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.teamCreate({ input }), {
    name: teamName, goal: 'Prepare the release launch.', owningSpaceId: 'halo-temp',
    memberSourcing: 'manual' as const, collabMode: 'structured' as const, escalationRouting: 'user' as const,
    members: [{ appId: dev, role: 'Engineer' }],
  })
  expect(created.success, `Create team: ${created.error}`).toBe(true)
  const team = created.data as Team
  const detail = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamGetDetail(id), team.id)
  const lead = (detail.data as TeamDetail).members.find(member => member.isSystemCoordinator)
  expect(lead, 'The saved team has its own lead').toBeTruthy()
  const leadApp = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appGet(id), lead!.appId)
  const leadName = (leadApp.data as { spec: { name: string } }).spec.name

  expect(await teamWorking(window, dev)).toBe(false)
  await expectRail(window, leadName, 'Standing by')
  await expectSwitcher(window, 'Standing by')

  await sendInTeamView(window, dev)
  await expect.poll(() => model.exchanges.filter(exchange => exchange.request.lastUserText.includes(message)).length).toBe(1)
  await expect.poll(() => teamWorking(window, dev)).toBe(true)
  await expectRail(window, leadName, 'Working')
  await expectSwitcher(window, 'Working')
  expect(model.exchanges.find(exchange => exchange.request.lastUserText.includes(message))!.completed, 'The member is still answering').toBe(false)

  gate.release()
  const tasks = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamListConversations(id), team.id)
  const task = (tasks.data as TeamConversation[])[0]
  await expect.poll(async () => {
    const result = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSessionState(input.appId, input.conversationId), {
      appId: dev, conversationId: buildTeamSessionKey(dev, team.id, task.epochId),
    })
    return (result.data as { isActive: boolean } | null)?.isActive ?? false
  }, { timeout: 30000 }).toBe(false)
  await expect.poll(async () => {
    const history = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.teamChatMessages(input), { teamId: team.id, epochId: task.epochId, appId: dev, spaceId: 'halo-temp' })
    return (history.data as Array<{ role: string; content: string }>).filter(item => item.role === 'assistant').map(item => item.content)
  }).toEqual([answer])
  await expect.poll(() => teamWorking(window, dev)).toBe(false)
  const { leadRow } = await expectRail(window, leadName, 'Standing by')
  await expect(leadRow.getByText('Team lead · Standing by', { exact: true })).toBeVisible()
  await expectSwitcher(window, 'Standing by')

  const { leadRow: openLead } = await expectRail(window, leadName, 'Standing by')
  await openLead.click()
  await expect(window.getByRole('button', { name: 'Capabilities and settings', exact: true })).toBeVisible()
  await expect(window.getByRole('button', { name: leadName, exact: true }).and(window.locator('[aria-current="true"]'))).toHaveCount(1)
  await testInfo.attach('team-status', { body: JSON.stringify({ team: team.id, dev, lead: lead!.appId, exchanges: model.exchanges.map(exchange => ({ lastUserText: exchange.request.lastUserText, completed: exchange.completed })) }, null, 2), contentType: 'application/json' })
})
