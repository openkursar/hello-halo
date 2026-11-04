import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { Team, TeamDetail } from '../../../src/shared/apps/team-types'
import { openPeoplePage, openTeamCard } from '../fixtures/acceptance-team-pages'
import { test, expect } from '../fixtures/acceptance-app'

async function installPerson(page: Page, name: string): Promise<string> {
  const installed = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appInstall({ spaceId: 'halo-temp',
    spec: { spec_version: '1.0', type: 'automation', version: '1.0.0', name: input, author: 'Acceptance author',
      description: 'A person whose team names are checked after a rename.', system_prompt: 'Do only the explicit team work.',
      subscriptions: [], requires: {}, config_schema: [], permissions: [] },
  }), name)
  expect(installed.success, `Install ${name}`).toBe(true)
  return (installed.data as { appId: string }).appId
}

async function createTeam(page: Page, name: string, members: Array<{ appId: string; memberName?: string }>): Promise<string> {
  const created = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.teamCreate({ input }), {
    name, goal: `Keep ${name} working together.`, owningSpaceId: 'halo-temp',
    memberSourcing: 'manual' as const, collabMode: 'structured' as const, escalationRouting: 'user' as const,
    members: members.map(member => ({ ...member, role: 'Reviewer' })),
  })
  expect(created.success, `Create ${name}: ${created.error}`).toBe(true)
  return (created.data as Team).id
}

async function memberNames(page: Page, teamId: string): Promise<Record<string, string>> {
  const detail = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamGetDetail(id), teamId)
  expect(detail.success).toBe(true)
  return Object.fromEntries((detail.data as TeamDetail).members.filter(member => !member.isSystemCoordinator).map(member => [member.appId, member.memberName]))
}

async function openMemberList(page: Page, teamName: string) {
  await openTeamCard(page, teamName)
  const rail = page.getByRole('complementary', { name: 'Members', exact: true })
  await expect(rail).toBeVisible()
  return rail
}

async function expectListed(page: Page, teamName: string, present: string[], absent: string[]) {
  const rail = await openMemberList(page, teamName)
  for (const name of present) await expect(rail.getByRole('button', { name: `View ${name}’s work in this task`, exact: true })).toBeVisible()
  for (const name of absent) await expect(rail.getByRole('button', { name: `View ${name}’s work in this task`, exact: true })).toHaveCount(0)
}

test('renaming a person in its settings renames its default team names, made unique per team, and keeps a name chosen for one team', {
  annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'people.settings.team-name', evidence: 'app-e2e', mode: 'none', variant: {} }) },
}, async ({ window }, testInfo) => {
  test.setTimeout(180000)
  await window.setViewportSize({ width: 1440, height: 1000 })
  await expect.poll(() => window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.teamList().then(result => result.success)), { timeout: 30000 }).toBe(true)
  const alice = await installPerson(window, 'Alice')
  const peer = await installPerson(window, 'Casey')
  const teams = {
    own: { name: 'Research desk', id: '' },
    taken: { name: 'Review desk', id: '' },
    chosen: { name: 'Editing desk', id: '' },
  }
  teams.own.id = await createTeam(window, teams.own.name, [{ appId: alice }, { appId: peer }])
  teams.taken.id = await createTeam(window, teams.taken.name, [{ appId: peer, memberName: 'Bea' }, { appId: alice }])
  teams.chosen.id = await createTeam(window, teams.chosen.name, [{ appId: alice, memberName: 'Copy editor' }, { appId: peer }])

  expect(await memberNames(window, teams.own.id)).toEqual({ [alice]: 'Alice', [peer]: 'Casey' })
  expect(await memberNames(window, teams.taken.id)).toEqual({ [peer]: 'Bea', [alice]: 'Alice' })
  expect(await memberNames(window, teams.chosen.id)).toEqual({ [alice]: 'Copy editor', [peer]: 'Casey' })
  await expectListed(window, teams.own.name, ['Alice', 'Casey'], ['Bea'])
  await expectListed(window, teams.taken.name, ['Bea', 'Alice'], ['Bea-2'])
  await expectListed(window, teams.chosen.name, ['Copy editor', 'Casey'], ['Alice'])

  await openPeoplePage(window)
  await window.getByRole('button', { name: 'My Digital Humans', exact: true }).click()
  await window.getByRole('button', { name: 'Alice', exact: true }).click()
  await window.getByRole('button', { name: 'Capabilities and settings', exact: true }).click()
  const identity = window.locator('#settings-group-identity')
  const name = identity.locator('input[type="text"]').first()
  await expect(name).toHaveValue('Alice')
  await name.fill('Bea')
  await identity.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => window.evaluate(async id => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.appGet(id)
    return (result.data as { spec?: { name?: string } } | undefined)?.spec?.name
  }, alice)).toBe('Bea')

  await expect.poll(() => memberNames(window, teams.own.id)).toEqual({ [alice]: 'Bea', [peer]: 'Casey' })
  await expect.poll(() => memberNames(window, teams.taken.id)).toEqual({ [peer]: 'Bea', [alice]: 'Bea-2' })
  await expect.poll(() => memberNames(window, teams.chosen.id)).toEqual({ [alice]: 'Copy editor', [peer]: 'Casey' })
  await expectListed(window, teams.own.name, ['Bea', 'Casey'], ['Alice'])
  await expectListed(window, teams.taken.name, ['Bea', 'Bea-2'], ['Alice'])
  await expectListed(window, teams.chosen.name, ['Copy editor', 'Casey'], ['Alice', 'Bea'])
  await testInfo.attach('team-names', { body: JSON.stringify({ own: await memberNames(window, teams.own.id), taken: await memberNames(window, teams.taken.id), chosen: await memberNames(window, teams.chosen.id) }, null, 2), contentType: 'application/json' })
})
