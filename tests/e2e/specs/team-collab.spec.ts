/**
 * A temporary space collaboration, opened the way a person opens one: from the
 * collaboration card in the space conversation that coordinates it.
 *
 * It has exactly one conversation — the room its coordinator talks to the team
 * in — so the workbench shows that room and offers no task list, no way to open
 * a second conversation, and no way to create one. The seeded profile is a real
 * collaboration (see fixtures/team-collab.ts), so the room below is projected by
 * the same code that runs for a user.
 */

import { test, expect, COLLAB_CONVERSATION_TITLE, COLLAB_MEMBER_NAME, COLLAB_TEAM_NAME } from '../fixtures/team-collab'
import { waitForHomePage } from '../fixtures/helpers'

test.setTimeout(60000)

test('a collaboration is one room: no task list, no task to create', async ({ window }) => {
  await waitForHomePage(window)

  await window.getByText(COLLAB_CONVERSATION_TITLE, { exact: true }).first().click()
  const openTeamView = window.getByRole('button', { name: 'Open team view', exact: true })
  await expect(openTeamView).toBeVisible()
  await expect(window.getByText(`Team: ${COLLAB_TEAM_NAME}`, { exact: true })).toBeVisible()

  await openTeamView.click()

  // The collaboration's workbench: the one action it offers is keeping the team.
  const room = window.getByRole('region', { name: 'Task room' })
  await expect(room).toBeVisible()
  await expect(window.getByText('Temporary collaboration', { exact: true })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Keep this team', exact: true })).toBeVisible()
  await expect(room.getByText(COLLAB_MEMBER_NAME, { exact: true }).first()).toBeVisible()

  // A collaboration has one conversation, so there is no task list to search,
  // filter, pick from or create into — and no drawer holding one at narrow
  // widths. (Distinct from the app's own "Tasks" rail panel, which is unrelated.)
  await expect(window.getByRole('navigation', { name: 'Tasks', exact: true })).toHaveCount(0)
  await expect(window.getByRole('searchbox', { name: 'Search tasks' })).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'New task', exact: true })).toHaveCount(0)
  await window.screenshot({ path: 'tests/e2e/results/team-collab-desktop.png' })

  // The members stay reachable: the rail at desktop width, the drawer below it.
  await window.setViewportSize({ width: 375, height: 812 })
  await expect(window.getByRole('dialog', { name: 'Tasks', exact: true })).toHaveCount(0)
  await expect(room.getByText(COLLAB_MEMBER_NAME, { exact: true }).first()).toBeVisible()
  expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy()
  await window.screenshot({ path: 'tests/e2e/results/team-collab-mobile.png' })
  await window.getByRole('button', { name: 'Members', exact: true }).click()
  await expect(window.getByRole('dialog', { name: 'Members' })).toBeVisible()
})
