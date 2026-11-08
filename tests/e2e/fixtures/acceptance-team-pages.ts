import { expect, type Page } from '@playwright/test'

export async function openPeoplePage(page: Page) {
  await page.getByRole('button', { name: 'Digital Humans', exact: true }).first().click()
  const allPeople = page.getByRole('button', { name: 'All digital humans', exact: true })
  const backToTeams = page.getByRole('button', { name: 'Back to teams', exact: true })
  const teamsTab = page.getByRole('button', { name: 'Teams', exact: true })
  await expect(allPeople.or(backToTeams).or(teamsTab).first()).toBeVisible()
  if (await allPeople.isVisible()) await allPeople.click()
  if (await backToTeams.isVisible()) await backToTeams.click()
  await expect(teamsTab).toBeVisible()
}

/** The Teams tab reopens the last team viewed, so a restored team view is closed back to the list. */
export async function openTeamCard(page: Page, teamName: string) {
  await openPeoplePage(page)
  await page.getByRole('button', { name: 'Teams', exact: true }).click()
  const card = page.getByRole('button').filter({ has: page.getByRole('heading', { name: teamName, exact: true, level: 2 }) })
  const backToTeams = page.getByRole('button', { name: 'Back to teams', exact: true })
  await expect(card.or(backToTeams).first()).toBeVisible()
  if (await backToTeams.isVisible()) await backToTeams.click()
  await expect(card).toHaveCount(1)
  await card.click()
  await expect(page.getByRole('heading', { name: teamName, exact: true, level: 1 })).toBeVisible()
}
