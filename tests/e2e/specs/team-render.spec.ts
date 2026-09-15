/**
 * Production checklist §2 — UI & interaction (render layer), automatable subset.
 *
 * §2 is otherwise a manual-testing blind spot (pixel-level animation, perceived
 * flicker, long observation cannot be asserted headlessly); this spec covers
 * the sub-checks a real renderer CAN verify headlessly (see
 * tests/decentralized/CHECKLIST-COVERAGE.md §2). Items 2.2, 2.6, 2.7 remain
 * manual — recorded as such in the checklist results, not silently skipped.
 */

import { test, expect } from '../fixtures/electron'
import { navigateToApps } from '../fixtures/helpers'
import type { Page } from '@playwright/test'
import { openTeamWorkbench } from '../fixtures/team-workbench'

/** Navigate to the Teams tab inside the Studio/Apps page. */
async function navigateToTeams(window: Page) {
  await navigateToApps(window)
  await window.getByRole('button', { name: /^Teams\b|^团队/ }).click()
  // Empty state or team list — either proves the view mounted
  // (actual copy from TeamEmptyState.tsx / TeamList.tsx).
  await window.waitForSelector(
    'text=/New team|Join a team|新建团队|加入团队/i',
    { timeout: 10000 }
  )
}

test.describe('Team render — §2 automatable subset', () => {
  test.setTimeout(60000)

  test('2.1 (proxy): Teams view renders with zero console/page errors over an observation window', async ({ window }) => {
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    window.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    window.on('pageerror', (err) => pageErrors.push(err.message))

    await navigateToTeams(window)

    // Observation window (scaled: the checklist's literal "10 minutes of
    // watching" is a manual pass; this catches immediate render loops).
    await window.waitForTimeout(15000)

    // The view must still be interactive (not white-screened): the tab bar exists.
    const alive = await window.getByRole('button', { name: /^Teams\b|^团队/ }).count()
    expect(alive).toBeTruthy()

    const updateDepthErrors = [...consoleErrors, ...pageErrors].filter((e) =>
      /Maximum update depth|Too many re-renders/i.test(e)
    )
    expect(updateDepthErrors, `render-loop errors: ${updateDepthErrors.join('\n')}`).toHaveLength(0)
    // Filter benign noise (favicon, devtools, network to model endpoints absent in test env)
    const hardErrors = consoleErrors.filter((e) =>
      !/favicon|net::|ERR_INTERNET|Failed to load resource/i.test(e)
    )
    expect(hardErrors, `console errors: ${hardErrors.join('\n')}`).toHaveLength(0)

    await window.screenshot({ path: 'tests/e2e/results/team-render-teams-view.png' })
  })

  test('2.3: no horizontal overflow at mobile width (<640px)', async ({ window }) => {
    await navigateToTeams(window)
    await window.setViewportSize({ width: 375, height: 812 })
    await window.waitForTimeout(1000)

    const overflow = await window.evaluate(() => {
      const el = document.documentElement
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
      }
    })
    expect(
      overflow.scrollWidth,
      `horizontal overflow at 375px: ${JSON.stringify(overflow)}`
    ).toBeLessThanOrEqual(overflow.clientWidth + 1)

    await window.screenshot({ path: 'tests/e2e/results/team-render-mobile-375.png' })
  })

  test('2.4: theme toggle keeps the Teams view alive in both themes', async ({ window }) => {
    await navigateToTeams(window)

    for (const theme of ['light', 'dark']) {
      await window.evaluate((t) => {
        document.documentElement.classList.remove('light', 'dark')
        document.documentElement.classList.add(t)
        localStorage.setItem('halo-theme', t)
      }, theme)
      await window.waitForTimeout(500)
      const alive = await window.getByRole('button', { name: /^Teams\b|^团队/ }).count()
      expect(alive, `Teams view died after switching to ${theme}`).toBeTruthy()
      await window.screenshot({ path: `tests/e2e/results/team-render-theme-${theme}.png` })
    }
  })

  test('2.5: switching to Chinese translates the tab and leaves no bare i18n keys', async ({ window }) => {
    await navigateToTeams(window)

    await window.evaluate(() => {
      localStorage.setItem('halo-locale', 'zh')
    })
    await window.reload()
    await window.waitForSelector('#root', { timeout: 15000 })
    await window.waitForTimeout(2000)

    // Navigate back to the teams view under the zh locale.
    const studio = await window.waitForSelector('text=/^Studio$|^工坊$|^Apps$/i', { timeout: 15000 })
    await studio.click()
    const zhTab = window.getByRole('button', { name: /^团队/ })
    await expect(zhTab).toBeVisible()
    await zhTab.click()

    // Heuristic: no visible text node looks like a raw i18n key (dotted.lower.case).
    const rawKeys = await window.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      const suspicious: string[] = []
      let n: Node | null
      while ((n = walker.nextNode())) {
        const text = (n.textContent ?? '').trim()
        if (/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){2,}$/.test(text)) suspicious.push(text)
      }
      return suspicious
    })
    expect(rawKeys, `bare i18n keys visible: ${rawKeys.join(', ')}`).toHaveLength(0)

    await window.screenshot({ path: 'tests/e2e/results/team-render-zh.png' })
  })
})


test.describe('Task workbench interaction', () => {
  test.setTimeout(60000)

  test('bounded collaboration previews preserve task and member boundaries', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window)
    const room = window.getByRole('region', { name: 'Task room' })
    const segment = room.locator('details').filter({ hasText: '100 collaboration messages' })
    await expect(segment).toHaveCount(1)
    await expect(segment).not.toHaveAttribute('open', '')
    await expect(room.getByText('Unrelated coordination record', { exact: true })).toHaveCount(0)
    await segment.locator('summary').click()
    await expect(segment.locator('ol > li')).toHaveCount(3)
    await expect(segment.locator('ol time')).toHaveCount(3)
    await expect(segment.getByText('Evidence from source 98. Ready for review.', { exact: true })).toBeVisible()
    await expect(segment.getByText('Evidence from source 1. Ready for review.', { exact: true })).toHaveCount(0)
    await segment.getByRole('button', { name: 'View more in task activity', exact: true }).click()
    const activity = window.getByRole('dialog', { name: 'Task activity' })
    await expect(activity.getByText('Product research', { exact: true })).toBeVisible()
    await expect(activity.getByText('Compare product capabilities', { exact: true })).toHaveCount(1)
    await expect(activity.getByText('Collect product documentation', { exact: true })).toHaveCount(0)
    await expect(activity.getByText('research-notes.md', { exact: true })).toHaveCount(1)
    await expect(activity.locator('[data-activity-id="coord-99"]')).toBeFocused()
    await expect(activity.locator('[data-activity-id="unrelated"]')).toHaveCount(1)
    await expect(activity.locator('[data-activity-id="other-task"]')).toHaveCount(0)
    await expect(activity.getByText('Release notes coordination', { exact: true })).toHaveCount(0)
    await window.screenshot({ path: 'tests/e2e/results/team-workbench-activity.png' })
    await window.keyboard.press('Escape')
    await expect(activity).toHaveCount(0)
    await expect(segment).toHaveAttribute('open', '')
    await window.screenshot({ path: 'tests/e2e/results/team-workbench-desktop-dark.png' })
    await window.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light') })
    await window.waitForTimeout(400)
    await window.screenshot({ path: 'tests/e2e/results/team-workbench-desktop-light.png' })
  })

  test('malformed collaboration timestamps preserve the conversation and complete activity', async ({ electronApp, window }) => {
    const pageErrors: string[] = []
    window.on('pageerror', error => pageErrors.push(error.message))
    await openTeamWorkbench(electronApp, window, { timestampAnomalies: true })
    const room = window.getByRole('region', { name: 'Task room' })
    await expect(room.getByText('Please research this product.', { exact: true })).toBeVisible()
    const segment = room.locator('details').filter({ hasText: '7 collaboration messages' })
    await expect(segment).toHaveCount(1)
    await segment.locator('summary').click()
    await expect(segment.locator('ol > li')).toHaveCount(3)
    await expect(segment.locator('ol > li').filter({ hasText: 'Preserved collaboration content:' })).toHaveCount(3)
    await expect(room.getByText(/Invalid Date|NaN/)).toHaveCount(0)
    await segment.getByRole('button', { name: 'View more in task activity', exact: true }).click()
    const dialog = window.getByRole('dialog', { name: 'Task activity' })
    await expect(dialog).toBeVisible()
    const groups = dialog.locator('details').filter({ has: window.locator('article[data-activity-id]') })
    for (const group of await groups.all()) {
      if (await group.getAttribute('open') === null) await group.locator(':scope > summary').click()
    }
    for (const kind of ['invalid', 'missing', 'null', 'overflow', 'underflow', 'iso', 'milliseconds']) {
      const record = dialog.locator(`[data-activity-id="timestamp-${kind}"]`)
      await expect(record.getByText(`Preserved collaboration content: ${kind}`, { exact: true })).toBeVisible()
      if (kind === 'iso' || kind === 'milliseconds') {
        const datetime = await record.locator('time').getAttribute('datetime')
        expect(datetime).toBeTruthy()
        expect(Number.isFinite(Date.parse(datetime!))).toBe(true)
      } else {
        await expect(record.getByText('Time unknown', { exact: true })).toBeVisible()
        await expect(record.locator('time[datetime]')).toHaveCount(0)
      }
    }
    await expect(dialog.getByText(/Invalid Date|NaN/)).toHaveCount(0)
    expect(pageErrors).toEqual([])
    await window.keyboard.press('Escape')
    await expect(room.locator('textarea')).toBeVisible()
  })

  test('system input stays out of human bubbles while the requested answer remains visible', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window, { provenanceMessages: true })
    const room = window.getByRole('region', { name: 'Task room' })
    await expect(room.getByText('[System] A teammate stopped its work. Internal notification.', { exact: true })).toHaveCount(0)
    await expect(room.getByText('Internal response to the teammate stopping.', { exact: true })).toBeVisible()
    await expect(room.getByText('[System] This is my literal message, not a system event.', { exact: true })).toBeVisible()
    await expect(room.getByText('[System] This older human message has no origin metadata.', { exact: true })).toBeVisible()
    await expect(room.getByText('Your literal message is preserved.', { exact: true })).toBeVisible()
    await room.getByRole('button', { name: 'Task activity', exact: true }).click()
    const dialog = window.getByRole('dialog', { name: 'Task activity' })
    await expect(dialog.getByText('Internal response to the teammate stopping.', { exact: true })).toHaveCount(0)
    const notification = dialog.locator('details[data-system-notification-id]').filter({ has: window.locator('[data-message-id="stopped-system"]') })
    await expect(notification).not.toHaveAttribute('open', '')
    await notification.scrollIntoViewIfNeeded()
    await window.screenshot({ path: '/tmp/halo-audience-review/notifications-collapsed.png' })
    await expect(notification.getByText('[System] A teammate stopped its work. Internal notification.', { exact: true })).toBeHidden()
    await notification.locator(':scope > summary').click()
    const notificationRecord = notification.locator('article[data-message-id="stopped-system"]')
    await expect(notificationRecord.getByText('[System] A teammate stopped its work. Internal notification.', { exact: true })).toBeVisible()
    await expect(notificationRecord.locator('[class*="bg-primary"]')).toHaveCount(0)
    await notificationRecord.scrollIntoViewIfNeeded()
    await window.screenshot({ path: '/tmp/halo-audience-review/notifications-expanded.png' })
    await window.setViewportSize({ width: 375, height: 812 })
    await expect(notificationRecord).toBeVisible()
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy()
    await window.screenshot({ path: '/tmp/halo-audience-review/notifications-mobile-expanded.png' })
    await expect(dialog.getByText('[System] This is my literal message, not a system event.', { exact: true })).toHaveCount(0)
    await expect(dialog.getByText('[System] This older human message has no origin metadata.', { exact: true })).toHaveCount(0)
  })

  test('delegated answers return to the requester without exposing another member’s prior internal results', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window, { collaborationJourney: true })
    const room = window.getByRole('region', { name: 'Task room' })
    const picker = room.getByRole('combobox', { name: 'Choose which of your digital humans to talk to' })
    await expect(room.getByText('Final research conclusion after consulting Research.', { exact: true })).toBeVisible()
    await expect(room.getByText('[Team message from Research] The investigation is complete.', { exact: true })).toHaveCount(0)
    await room.getByRole('button', { name: 'Task activity', exact: true }).click()
    let dialog = window.getByRole('dialog', { name: 'Task activity' })
    await expect(dialog.getByText('Research completed before any human contacted me.', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Final research conclusion after consulting Research.', { exact: true })).toHaveCount(0)
    await window.keyboard.press('Escape')
    await picker.selectOption('research')
    await expect(room.getByText('Research completed before any human contacted me.', { exact: true })).toHaveCount(0)
    await expect(room.getByText('Final research conclusion after consulting Research.', { exact: true })).toHaveCount(0)
    await room.locator('textarea').fill('Explain your findings to me.')
    await room.locator('textarea').press('Enter')
    await expect(room.locator('textarea')).toHaveValue('')
    await picker.selectOption('lead')
    await picker.selectOption('research')
    await expect(room.getByText('Explain your findings to me.', { exact: true })).toBeVisible()
    await expect(room.getByText('Here is the explanation you requested.', { exact: true })).toBeVisible()
    await expect(room.getByText('I have also validated those findings for you.', { exact: true })).toBeVisible()
    await expect(room.getByText('Research completed before any human contacted me.', { exact: true })).toHaveCount(0)
    await expect(room.getByText('[System] Source validation finished.', { exact: true })).toHaveCount(0)
    await room.getByRole('button', { name: 'Task activity', exact: true }).click()
    dialog = window.getByRole('dialog', { name: 'Task activity' })
    await expect(dialog.getByText('Research completed before any human contacted me.', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Here is the explanation you requested.', { exact: true })).toHaveCount(0)
    await expect(dialog.getByText('I have also validated those findings for you.', { exact: true })).toHaveCount(0)
  })

  test('avatar selection matches the composer and preserves per-member drafts', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window)
    const room = window.getByRole('region', { name: 'Task room' })
    const picker = room.getByRole('combobox', { name: 'Choose which of your digital humans to talk to' })
    await room.locator('textarea').fill('Keep this Lead draft')
    await window.getByRole('button', { name: 'Switch to Research', exact: true }).click()
    await expect(picker).toHaveValue('research')
    await expect(room.getByRole('heading', { name: 'Product research', exact: true })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Back to task', exact: true })).toHaveCount(0)
    await expect(room.getByText('Please research this product.', { exact: true })).toHaveCount(0)
    await expect(room.locator('textarea')).toHaveValue('')
    await room.locator('textarea').fill('Research draft')
    await picker.selectOption('lead')
    await expect(room.locator('textarea')).toHaveValue('Keep this Lead draft')
    await expect(room.getByText('Please research this product.', { exact: true })).toBeVisible()
  })

  test('one owned digital human has no redundant composer selector', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window, { ownCount: 1 })
    const room = window.getByRole('region', { name: 'Task room' })
    await expect(room.getByRole('combobox')).toHaveCount(0)
    await expect(room.locator('textarea')).toBeVisible()
    await window.screenshot({ path: 'tests/e2e/results/team-workbench-single-member.png' })
  })

  test('task selection changes both conversation and activity without losing drafts', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window)
    const room = window.getByRole('region', { name: 'Task room' })
    const sidebar = window.getByRole('navigation', { name: 'Tasks', exact: true })
    await room.locator('textarea').fill('Unsent product question')
    await sidebar.getByRole('button', { name: /Release notes/ }).click()
    await expect(room.getByText('Please research this product.', { exact: true })).toHaveCount(0)
    await expect(room.getByText('Release notes coordination', { exact: true })).toBeVisible()
    await expect(room.locator('textarea')).toHaveValue('')
    await room.getByRole('button', { name: 'Task activity', exact: true }).click()
    const activity = window.getByRole('dialog', { name: 'Task activity' })
    await expect(activity.getByText('Release notes', { exact: true })).toBeVisible()
    await expect(activity.getByText('Unrelated coordination record', { exact: true })).toHaveCount(0)
    await window.keyboard.press('Escape')
    await sidebar.getByRole('button', { name: /Product research/ }).click()
    await expect(room.locator('textarea')).toHaveValue('Unsent product question')
  })

  test('a decision links back to its single answering surface', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window, { withDecision: true })
    const room = window.getByRole('region', { name: 'Task room' })
    await room.getByRole('button', { name: /^Task activity/ }).click()
    const dialog = window.getByRole('dialog', { name: 'Task activity' })
    await expect(dialog.getByRole('button', { name: 'Approve scope', exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: /Go to conversation to answer/ }).click()
    await expect(dialog).toHaveCount(0)
    await expect(room.locator('#decision-decision-1')).toBeFocused()
    await room.getByRole('button', { name: 'Approve scope', exact: true }).click()
    await expect(room.getByText('Approve the research scope?', { exact: true })).toHaveCount(0)
  })

  test('a rejected send restores the draft after switching members', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window, { sendFailure: true })
    const room = window.getByRole('region', { name: 'Task room' })
    const picker = room.getByRole('combobox', { name: 'Choose which of your digital humans to talk to' })
    await room.locator('textarea').fill('Keep this message if delivery fails')
    await room.locator('textarea').press('Enter')
    await picker.selectOption('research')
    await expect(room.locator('textarea')).toHaveValue('')
    await window.waitForTimeout(750)
    await picker.selectOption('lead')
    await expect(room.locator('textarea')).toHaveValue('Keep this message if delivery fails')
  })

  test('a rejection refreshes the composer when returning before the send settles', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window, { sendFailure: true, sendFailureDelay: 1500 })
    const room = window.getByRole('region', { name: 'Task room' })
    const picker = room.getByRole('combobox', { name: 'Choose which of your digital humans to talk to' })
    await room.locator('textarea').fill('Restore this after a quick round trip')
    await room.locator('textarea').press('Enter')
    await picker.selectOption('research')
    await picker.selectOption('lead')
    await expect(room.locator('textarea')).toHaveValue('')
    await expect(room.locator('textarea')).toHaveValue('Restore this after a quick round trip')
  })

  test('a draft creates exactly one task on its first send', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window, { allowCreate: true })
    const sidebar = window.getByRole('navigation', { name: 'Tasks', exact: true })
    const room = window.getByRole('region', { name: 'Task room' })
    await sidebar.getByRole('button', { name: 'New task', exact: true }).click()
    await room.locator('textarea').fill('Prepare a launch checklist')
    await expect(sidebar.getByRole('button', { name: /Prepare a launch checklist/ })).toHaveCount(0)
    await room.locator('textarea').press('Enter')
    await expect(room.getByRole('heading', { name: 'Prepare a launch checklist', exact: true })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: /Prepare a launch checklist/ })).toHaveCount(1)
    await expect(room.getByText('Prepare a launch checklist', { exact: true })).toHaveCount(2)
  })

  test('a rejected first message remains recoverable in the newly created task', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window, { allowCreate: true, sendFailure: true })
    const sidebar = window.getByRole('navigation', { name: 'Tasks', exact: true })
    const room = window.getByRole('region', { name: 'Task room' })
    await sidebar.getByRole('button', { name: 'New task', exact: true }).click()
    await room.locator('textarea').fill('Draft requiring a retry')
    await room.locator('textarea').press('Enter')
    await expect(room.getByRole('heading', { name: 'Draft requiring a retry', exact: true })).toBeVisible()
    await expect(room.locator('textarea')).toHaveValue('Draft requiring a retry')
    await sidebar.getByRole('button', { name: /Product research/ }).click()
    await sidebar.getByRole('button', { name: /Draft requiring a retry/ }).click()
    await expect(room.locator('textarea')).toHaveValue('Draft requiring a retry')
  })

  test('renaming supports cancel and updates the room and task list together', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window)
    const room = window.getByRole('region', { name: 'Task room' })
    await room.getByRole('button', { name: 'Rename task', exact: true }).click()
    await room.getByRole('textbox', { name: 'Task title', exact: true }).fill('Discard this title')
    await room.getByRole('textbox', { name: 'Task title', exact: true }).press('Escape')
    await expect(room.getByRole('heading', { name: 'Product research', exact: true })).toBeVisible()
    await room.getByRole('button', { name: 'Rename task', exact: true }).click()
    await room.getByRole('textbox', { name: 'Task title', exact: true }).fill('Research brief')
    await room.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(room.getByRole('heading', { name: 'Research brief', exact: true })).toBeVisible()
    await expect(window.getByRole('navigation', { name: 'Tasks', exact: true }).getByRole('button', { name: /Research brief/ })).toBeVisible()
  })

  test('history failure is distinguishable from empty and can recover', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window, { historyFailure: true })
    const room = window.getByRole('region', { name: 'Task room' })
    await expect(room.getByText('Couldn’t load the chat history right now.', { exact: true })).toBeVisible()
    await expect(room.getByText('You have not talked to this digital human in this task yet.', { exact: true })).toHaveCount(0)
    await room.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(room.getByText('Please research this product.', { exact: true })).toBeVisible()
  })

  for (const kind of ['im', 'run'] as const) {
    test(`${kind} history is readable without an editable composer`, async ({ electronApp, window }) => {
      await openTeamWorkbench(electronApp, window, { readonlyKind: kind })
      const room = window.getByRole('region', { name: 'Task room' })
      await expect(room.locator('textarea')).toHaveCount(0)
      await expect(room.getByRole('combobox')).toHaveCount(0)
      await expect(room.getByText(/read-only/)).toBeVisible()
      await room.getByRole('button', { name: 'Task activity', exact: true }).click()
      await expect(window.getByRole('dialog', { name: 'Task activity' })).toBeVisible()
    })
  }

  test('a viewer without owned members sees an honest empty state and can inspect activity', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window, { ownCount: 0 })
    const room = window.getByRole('region', { name: 'Task room' })
    await expect(room.locator('textarea')).toHaveCount(0)
    await expect(room.getByRole('combobox')).toHaveCount(0)
    await expect(room.getByText('Bring one of your digital humans into this team to start talking.', { exact: true })).toBeVisible()
    await room.getByRole('button', { name: 'Task activity', exact: true }).click()
    await expect(window.getByRole('dialog', { name: 'Task activity' })).toBeVisible()
  })

  test('mobile drawers, composer and expanded previews fit in both themes', async ({ electronApp, window }) => {
    await openTeamWorkbench(electronApp, window)
    await window.setViewportSize({ width: 375, height: 812 })
    const room = window.getByRole('region', { name: 'Task room' })
    await room.locator('details summary').click()
    for (const theme of ['light', 'dark']) {
      await window.evaluate(value => {
        document.documentElement.classList.remove('light', 'dark')
        document.documentElement.classList.add(value)
      }, theme)
      await window.waitForTimeout(400)
      await expect(room.locator('textarea')).toBeVisible()
      expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy()
      await window.screenshot({ path: `tests/e2e/results/team-workbench-mobile-${theme}.png` })
    }
    await room.getByRole('button', { name: 'Task activity', exact: true }).click()
    const dialog = window.getByRole('dialog', { name: 'Task activity' })
    await expect(dialog).toBeVisible()
    const bounds = await dialog.boundingBox()
    expect(bounds!.width).toBeLessThanOrEqual(375)
    await window.screenshot({ path: 'tests/e2e/results/team-workbench-mobile-activity.png' })
    await window.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
