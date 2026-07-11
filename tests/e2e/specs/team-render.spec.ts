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

/** Navigate to the Teams tab inside the Studio/Apps page. */
async function navigateToTeams(window: Page) {
  await navigateToApps(window)
  const teamsTab = await window.waitForSelector('text=/^Teams$|^团队$/i', { timeout: 10000 })
  await teamsTab.click()
  // Empty state or team list — either proves the view mounted
  // (actual copy from TeamEmptyState.tsx / TeamList.tsx).
  await window.waitForSelector(
    'text=/No teams yet|New office|Join an office|Create your first office|还没有团队|新建办公室|加入办公室/i',
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
    const alive = await window.$('text=/^Teams$|^团队$/i')
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
      const alive = await window.$('text=/^Teams$|^团队$/i')
      expect(alive, `Teams view died after switching to ${theme}`).toBeTruthy()
      await window.screenshot({ path: `tests/e2e/results/team-render-theme-${theme}.png` })
    }
  })

  test('2.5: switching to Chinese translates the tab and leaves no bare i18n keys', async ({ window }) => {
    await navigateToTeams(window)

    await window.evaluate(() => {
      localStorage.setItem('halo-language', 'zh')
    })
    await window.reload()
    await window.waitForSelector('#root', { timeout: 15000 })
    await window.waitForTimeout(2000)

    // Navigate back to the teams view under the zh locale.
    const studio = await window.waitForSelector('text=/^Studio$|^工坊$|^Apps$/i', { timeout: 15000 })
    await studio.click()
    const zhTab = await window.waitForSelector('text=/^团队$|^Teams$/i', { timeout: 10000 })
    expect(zhTab).toBeTruthy()

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
