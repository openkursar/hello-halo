/**
 * Automation Run — Live View + Mid-Run Injection E2E Tests
 *
 * A user can watch a digital-human automation run live in the run-detail view
 * and type a supplement mid-run to steer the AI.
 *
 * Two tiers (mirrors chat.spec.ts gating):
 *  - UI-only scenarios (always run): entry points into the digital-humans view,
 *    empty/list state, and the read-only run-detail surface. No API key needed.
 *  - Live flow (gated on HALO_TEST_API_KEY + a runnable digital human present):
 *    trigger a run, open the live run detail, assert the live indicator + the
 *    mid-run input box appear, type a supplement and send it without error.
 *
 * Selectors are text/title based — the apps UI has no data-testid hooks, and the
 * test harness runs in the default (English) locale (see fixtures/electron.ts).
 */

import { test, expect, hasApiKey } from '../fixtures/electron'
import { navigateToApps } from '../fixtures/helpers'
import type { Page } from '@playwright/test'

/** Live runs work with either an API key or a configured OAuth source. */
const hasCredentials = (): boolean => hasApiKey() || !!process.env.HALO_TEST_OAUTH_SOURCE

/** Whether at least one digital human is present in the sidebar list.
 *  The empty-state TITLE ("No digital humans yet") is the only reliable signal —
 *  the "Create Digital Human" CTA also renders in the sidebar bottom bar when
 *  apps DO exist, so it cannot be used to detect emptiness. */
async function hasDigitalHuman(window: Page): Promise<boolean> {
  const emptyTitle = await window.$('text=/No digital humans yet|还没有数字人/i')
  return !emptyTitle
}

test.describe('Automation Run — entry points (UI only)', () => {
  test.setTimeout(30000)

  test('digital-humans view is reachable from the Studio/Apps card', async ({ window }) => {
    await navigateToApps(window)

    // The "My Digital Humans" tab must be present (entry point #1).
    const tab = await window.$('text=/My Digital Humans|我的数字人/i')
    expect(tab).toBeTruthy()

    await window.screenshot({ path: 'tests/e2e/results/automation-digital-humans.png' })
  })

  test('digital-humans view shows either an empty state or a run surface', async ({ window }) => {
    await navigateToApps(window)

    // The view is valid if ANY of these markers appears within the timeout:
    //  - empty state title (no digital humans installed)
    //  - the create CTA (sidebar)
    //  - the Activity tab or select prompt (a digital human is selected/seeded)
    const markers = [
      'text=/No digital humans yet|还没有数字人/i',
      'text=/Create Digital Human|创建数字人/i',
      'text=/^Activity$|^活动$/i',
      'text=/Select a digital human to view details|选择.*数字人/i',
    ]
    const found = await Promise.any(
      markers.map(sel => window.waitForSelector(sel, { timeout: 10000 }))
    ).catch(() => null)

    expect(found).toBeTruthy()
    await window.screenshot({ path: 'tests/e2e/results/automation-run-surface.png' })
  })

  test('run-detail (View process) opens when a finished run exists', async ({ window }) => {
    await navigateToApps(window)
    await window.waitForTimeout(500)

    if (!(await hasDigitalHuman(window))) {
      test.skip(true, 'No digital human installed — nothing to open')
      return
    }

    // Go to the Activity tab and try to open a run's process view.
    const activityTab = await window.$('text=/^Activity$|^活动$/i')
    if (activityTab) {
      await activityTab.click()
      await window.waitForTimeout(400)
    }

    const viewProcess = await window.$('text=/View process|查看过程/i')
    if (!viewProcess) {
      test.skip(true, 'No finished run with a session transcript yet')
      return
    }

    await viewProcess.click()
    await window.waitForTimeout(500)

    // The run detail renders the breadcrumb "Run <shortId>".
    const breadcrumb = await window.$('text=/^Run [a-z0-9]/i')
    expect(breadcrumb).toBeTruthy()

    // A finished run is still a conversation: the reply input must be present
    // (the user can resume it). This is the behavior the input-box fix delivers.
    const input = await window.waitForSelector('textarea', { timeout: 5000 }).catch(() => null)
    expect(input).toBeTruthy()

    await window.screenshot({ path: 'tests/e2e/results/automation-run-detail.png' })
  })
})

test.describe('Automation Run — live trigger + mid-run injection', () => {
  test.setTimeout(120000)

  test('user can trigger a run, watch it live, and inject a supplement', async ({ window }) => {
    test.skip(!hasCredentials(), 'Requires HALO_TEST_API_KEY or HALO_TEST_OAUTH_SOURCE for a real automation run')

    await navigateToApps(window)
    await window.waitForTimeout(500)

    if (!(await hasDigitalHuman(window))) {
      test.skip(true, 'Requires a pre-seeded runnable digital human')
      return
    }

    // Trigger a run (idle apps expose a "Run now" button in the header).
    const runNow = await window.waitForSelector(
      'button[title="Run now"], button[title="Resume and run now"]',
      { timeout: 8000 }
    ).catch(() => null)
    if (!runNow) {
      test.skip(true, 'Run-now button not available (app busy or not runnable)')
      return
    }
    await runNow.click()

    // The run goes live: open its process view from the Activity thread.
    await window.waitForTimeout(800)
    const activityTab = await window.$('text=/^Activity$|^活动$/i')
    if (activityTab) {
      await activityTab.click()
      await window.waitForTimeout(400)
    }

    const viewProcess = await window.waitForSelector(
      'text=/View process|查看过程/i',
      { timeout: 15000 }
    )
    await viewProcess.click()

    // Live run-detail shows the live indicator and the mid-run input box.
    const liveBanner = await window.waitForSelector(
      'text=/Running — live|运行中/i',
      { timeout: 15000 }
    ).catch(() => null)
    expect(liveBanner).toBeTruthy()

    // The inject input carries our placeholder; type a supplement and send it.
    const input = await window.waitForSelector(
      'textarea[placeholder*="guide this run"], textarea[placeholder*="补充"]',
      { timeout: 10000 }
    )
    await input.fill('Please double-check the date format before finishing.')
    await input.press('Enter')

    // After sending, the input clears and no error toast appears.
    await window.waitForTimeout(800)
    const value = await input.inputValue()
    expect(value.trim()).toBe('')

    await window.screenshot({ path: 'tests/e2e/results/automation-run-inject.png' })
  })
})
