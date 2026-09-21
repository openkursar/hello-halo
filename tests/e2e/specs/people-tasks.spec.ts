/**
 * The task panel's team entry: a team blocked on the user is a task like any
 * other, and clicking it must land on that team's workbench — not on a person.
 */

import { test, expect } from '../fixtures/people'
import { waitForHomePage } from '../fixtures/helpers'

test.setTimeout(60000)
test.use({ peopleCount: 2 })

test('a team waiting for the user appears in the task panel and opens its workbench', async ({ window }) => {
  await waitForHomePage(window)
  await window.getByRole('button', { name: /^Tasks/ }).click()

  const row = window.getByText('Decision team', { exact: true })
  await expect(row).toBeVisible()

  await row.click()
  await expect(window.getByRole('heading', { name: 'Decision team', exact: true })).toBeVisible()
  // The Apps page header names where its back button leads once a team is open.
  await expect(window.getByRole('button', { name: 'Teams', exact: true })).toBeVisible()
})
