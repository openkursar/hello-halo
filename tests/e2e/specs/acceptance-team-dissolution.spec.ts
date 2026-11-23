import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import type { Team, TeamDetail } from '../../../src/shared/apps/team-types'
import { test, expect, managementAcceptance, listManagedPeople, listManagedSpaces, seedManagedPerson, seedManagedSpace } from '../fixtures/acceptance-management'
import { openPeoplePage, openTeamCard } from '../fixtures/acceptance-team-pages'
import { setTheme } from '../fixtures/helpers'

test('dissolving a filtered team keeps moved people in their workspace across restart', {
  annotation: ['teams.cluster.dissolve', 'people.directory.removed-team'].map(id => managementAcceptance(id).annotation),
}, async ({ managementApp, window }, testInfo) => {
  test.setTimeout(120000)
  const source = await seedManagedSpace(window, 'Team workspace')
  const destination = await seedManagedSpace(window, 'Independent workspace')
  const neighbor = await seedManagedPerson(window, 'Independent reviewer')
  const name = 'Review team'
  const created = await window.evaluate(({ name, owningSpaceId }) => (globalThis as unknown as { halo: HaloAPI }).halo.teamCreate({
    input: { name, owningSpaceId, goal: '', memberSourcing: 'ai', collabMode: 'free', escalationRouting: 'user' },
    confirmedProposal: ['Moved reviewer', 'Team reviewer'].map(memberName => ({ memberName, role: 'Reviewer', responsibility: 'Review documents.' })),
  }), { name, owningSpaceId: source.id })
  expect(created.success, created.error).toBe(true)
  const team = created.data as Team
  const detail = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamGetDetail(id), team.id)
  expect(detail.success, detail.error).toBe(true)
  const members = (detail.data as TeamDetail).members
  const moved = members.find(member => member.memberName === 'Moved reviewer')!
  const stayed = members.find(member => member.memberName === 'Team reviewer')!
  const files: string[] = []
  for (const appId of [moved.appId, neighbor.id]) {
    const result = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appMoveSpace(input), { appId, newSpaceId: destination.id })
    expect(result.success, result.error).toBe(true)
    const data = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appGetDataPath(id), appId)
    expect(data.success, data.error).toBe(true)
    const root = data.data!.path
    const inside = relative(managementApp.profile, root)
    expect(inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`)).toBe(true)
    const file = join(root, 'retained-note.txt')
    writeFileSync(file, appId)
    files.push(file)
  }
  await openPeoplePage(window)
  await window.getByRole('button', { name: 'My Digital Humans', exact: true }).click()
  const filter = window.getByRole('combobox', { name: 'Filter by team' })
  await filter.selectOption(team.id)
  const movedName = (await listManagedPeople(window)).find(person => person.id === moved.appId)!.spec.name
  await expect(window.getByRole('button', { name: movedName, exact: true })).toBeVisible()
  await expect(window.getByRole('button', { name: neighbor.spec.name, exact: true })).toHaveCount(0)

  await openTeamCard(window, name)
  await window.getByRole('button', { name: 'Team settings', exact: true }).click()
  await window.getByRole('dialog', { name: 'Team settings' }).getByRole('button', { name: 'Advanced', exact: true }).click()
  await window.getByRole('button', { name: 'Dissolve team', exact: true }).click()
  const confirm = window.getByRole('alertdialog', { name: `Dissolve ${name}?` })
  await expect(confirm).toContainText('all spaces are kept')
  for (const theme of ['dark', 'light'] as const) {
    await setTheme(window, theme)
    await testInfo.attach(`dissolve-${theme}`, { body: await confirm.screenshot(), contentType: 'image/png' })
  }
  await confirm.getByRole('button', { name: 'Dissolve', exact: true }).click()
  await expect.poll(async () => (await listManagedPeople(window)).some(p => p.id === stayed.appId)).toBe(false)
  for (const restart of [false, true]) {
    const page = restart ? await managementApp.restart() : window
    await openPeoplePage(page)
    await page.getByRole('button', { name: 'My Digital Humans', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Filter by team' })).toHaveValue('')
    const people = await listManagedPeople(page)
    for (const [id, name] of [[moved.appId, movedName], [neighbor.id, neighbor.spec.name]]) {
      expect(people.find(person => person.id === id)?.spaceId).toBe(destination.id)
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
    }
    expect(people.some(person => person.id === stayed.appId || person.id === team.leadAppId)).toBe(false)
    expect((await listManagedSpaces(page)).map(space => space.id)).toEqual(expect.arrayContaining([source.id, destination.id]))
    expect(files.map(file => readFileSync(file, 'utf8'))).toEqual([moved.appId, neighbor.id])
  }
})
