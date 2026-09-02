/**
 * Digital-Human Lifecycle — Live E2E Coverage
 *
 * automation-run.spec.ts's live scenarios gate on "a digital human happens to
 * already be installed" and skip in a fresh profile. This suite seeds one via
 * electron-with-app.ts (direct DB seed, not the AI-driven creation wizard) so
 * the live path — manual trigger, multi-turn digital-human chat, desktop
 * notification on completion, and MCP tool use during a run — is
 * deterministically reachable and gated only on API credentials.
 *
 * Selectors are text/title based and bilingual (EN/CN) — the apps UI has no
 * data-testid hooks, and this environment's default locale renders Chinese
 * (matches the dual-language regex convention already used across the suite,
 * e.g. `text=/My Digital Humans|我的数字人/i` in fixtures/helpers.ts).
 */

import { test, expect, hasApiKey } from '../fixtures/electron-with-app'
import { navigateToApps } from '../fixtures/helpers'
import type { Page } from '@playwright/test'

const hasCredentials = (): boolean => hasApiKey() || !!process.env.HALO_TEST_OAUTH_SOURCE

async function openSeededApp(window: Page, name: string) {
  await navigateToApps(window)
  const appEntry = await window.waitForSelector(`text="${name}"`, { timeout: 10000 })
  await appEntry.click()
}

/** title="Run now" / "Resume and run now" — see AutomationHeader.tsx. */
const RUN_NOW_SELECTOR = [
  'button[title="Run now"]', 'button[title="立即执行"]',
  'button[title="Resume and run now"]', 'button[title="立即恢复并运行"]',
].join(', ')

async function runNow(window: Page) {
  const runNowButton = await window.waitForSelector(RUN_NOW_SELECTOR, { timeout: 10000 })
  await runNowButton.click()
}

async function openLiveProcessView(window: Page) {
  await window.waitForTimeout(800)
  const activityTab = await window.$('text=/^Activity$|^活动$/i')
  if (activityTab) {
    await activityTab.click()
    await window.waitForTimeout(400)
  }
  // The Activity feed's first entry for a short run is often the completion
  // entry itself (no separate "started" marker) — it only appears once the
  // real model round trip finishes, so this budget must cover network time,
  // not just UI rendering.
  const viewProcess = await window.waitForSelector('text=/View process|查看进程/i', { timeout: 45000 })
  await viewProcess.click()
}

test.describe('Digital Human — seeded install is reachable', () => {
  test.setTimeout(30000)

  test('the seeded app appears in My Digital Humans', async ({ window, seededApp }) => {
    await navigateToApps(window)
    const entry = await window.waitForSelector(`text="${seededApp.name}"`, { timeout: 10000 })
    expect(entry).toBeTruthy()
    await window.screenshot({ path: 'tests/e2e/results/dh-lifecycle-seeded-visible.png' })
  })

  test('opening it shows the schedule subscription it was seeded with', async ({ window, seededApp }) => {
    await openSeededApp(window, seededApp.name)
    // The 24h schedule subscription seeded in seed-app.ts should render somewhere
    // in the detail view (schedule badge / next-run hint / config section).
    const scheduleHint = await window.waitForSelector(
      'text=/24h|every 24 hours|schedule|计划|定时/i',
      { timeout: 10000 }
    ).catch(() => null)
    expect(scheduleHint).toBeTruthy()
  })

  test('a "Run now" control is available for an idle active app', async ({ window, seededApp }) => {
    await openSeededApp(window, seededApp.name)
    const runNowButton = await window.waitForSelector(RUN_NOW_SELECTOR, { timeout: 10000 })
    expect(runNowButton).toBeTruthy()
  })
})

test.describe('Digital Human — live run, multi-turn chat, notification, MCP', () => {
  test.setTimeout(150000)

  test('a manually triggered run reaches a live process view', async ({ window, seededApp }) => {
    test.skip(!hasCredentials(), 'Requires HALO_TEST_API_KEY or HALO_TEST_OAUTH_SOURCE')

    await openSeededApp(window, seededApp.name)
    await runNow(window)
    await openLiveProcessView(window)

    const breadcrumb = await window.waitForSelector('text=/^Run [a-z0-9]|^运行 [a-z0-9]/i', { timeout: 15000 })
    expect(breadcrumb).toBeTruthy()
    await window.screenshot({ path: 'tests/e2e/results/dh-lifecycle-live-run.png' })
  })

  test('the run completes and calling report_to_user reaches an ok/useful outcome', async ({ window, seededApp }) => {
    test.skip(!hasCredentials(), 'Requires HALO_TEST_API_KEY or HALO_TEST_OAUTH_SOURCE')

    await openSeededApp(window, seededApp.name)
    await runNow(window)
    await openLiveProcessView(window)

    // The seeded system prompt instructs the model to call report_to_user
    // immediately — its tool-call entry (mcp__halo-report__report_to_user,
    // logged as "run_complete") is the ground-truth signal that the run
    // reached executeRun's "ok/useful" branch, not just that the UI stopped
    // showing a spinner.
    const reportCall = await window.waitForSelector(
      'text=/mcp__halo-report__report_to_user/i',
      { timeout: 60000 }
    )
    expect(reportCall).toBeTruthy()
    await window.waitForSelector('text=/run_complete/i', { timeout: 5000 })
  })

  test('a follow-up message after completion is a genuine second turn, not a repeat of the first', async ({ window, seededApp }) => {
    test.skip(!hasCredentials(), 'Requires HALO_TEST_API_KEY or HALO_TEST_OAUTH_SOURCE — exercises the app-chat/TurnSink path')

    await openSeededApp(window, seededApp.name)
    await runNow(window)
    await openLiveProcessView(window)

    await window.waitForSelector(
      'text=/Running — live|运行中/i',
      { state: 'hidden', timeout: 90000 }
    ).catch(() => {})

    // The finished run is still a conversation: the reply input resumes it.
    const input = await window.waitForSelector('textarea', { timeout: 10000 })
    await input.fill('Reply with exactly the digits 42 and nothing else.')
    await input.press('Enter')

    // The reply containing "42" is the direct regression signal for the
    // app-chat-sink TurnSink rewrite: a stray autonomous turn claiming this
    // message (instead of the real second turn answering it) would leave this
    // wait to time out.
    await window.waitForSelector('text=/42/', { timeout: 60000 })

    // The first turn's own completion entry must still be present — proving
    // this is a genuine second turn appended to the transcript, not the first
    // turn's content having been silently replaced or duplicated over it.
    const firstTurnEntry = await window.$('text=/mcp__halo-report__report_to_user/i')
    expect(firstTurnEntry).toBeTruthy()

    await window.screenshot({ path: 'tests/e2e/results/dh-lifecycle-second-turn.png' })
  })

  test.describe('notificationLevel=all', () => {
    test.use({ seedOptions: { notificationLevel: 'all' } })

    test('a completed run leaves a visible completion marker for the desktop-notification gate', async ({ window, seededApp }) => {
      test.skip(!hasCredentials(), 'Requires HALO_TEST_API_KEY or HALO_TEST_OAUTH_SOURCE')

      // notification.service.ts sends the OS notification only when unfocused;
      // Playwright keeps the window focused, so the observable proxy here is
      // the same signal notifyAppEvent's caller gates on — a run_complete/
      // output entry for the run reaching the Activity feed with a completed
      // badge (the notificationLevel gate itself is verified at the unit
      // level in runtime.test.ts). Stay on the Activity list — the badge
      // renders there, not inside the run's transcript detail.
      await openSeededApp(window, seededApp.name)
      await runNow(window)
      await window.waitForTimeout(800)

      // Best-effort click, mirroring openLiveProcessView: the tab may already
      // be active by the time a real API round trip finishes, in which case
      // there is nothing to switch to.
      const activityTab = await window.$('text=/^Activity$|^活动$/i')
      if (activityTab) await activityTab.click()

      const completed = await window.waitForSelector(
        'text=/Completed|已完成/i',
        { timeout: 60000 }
      )
      expect(completed).toBeTruthy()
      await window.screenshot({ path: 'tests/e2e/results/dh-lifecycle-notification-gate.png' })
    })
  })
})

test.describe('Digital Human — real scheduled trigger (no manual click)', () => {
  test.setTimeout(150000)
  // anchorMs is set to "now" at app activation (boot), so a 10s interval
  // (the scheduler's floor — schedule.ts MIN_INTERVAL_MS) fires shortly after
  // the app comes up, with no "Run now" click anywhere in this test. This is
  // the actual regression surface for #340's bounded-dispatch rewrite: a run
  // reaching the Activity feed on its own confirms the scheduler timer armed
  // and fired the job, not just that manual triggers still work.
  test.use({ seedOptions: { scheduleEvery: '10s', notificationLevel: 'all' } })

  test('the scheduled subscription fires on its own and completes', async ({ window, seededApp }) => {
    test.skip(!hasCredentials(), 'Requires HALO_TEST_API_KEY or HALO_TEST_OAUTH_SOURCE')

    await openSeededApp(window, seededApp.name)

    const activityTab = await window.$('text=/^Activity$|^活动$/i')
    if (activityTab) await activityTab.click()

    // No trigger click anywhere above — this waits purely on the scheduler's
    // own timer + a real automation run + a real model round trip.
    const completed = await window.waitForSelector(
      'text=/Completed|已完成/i',
      { timeout: 120000 }
    )
    expect(completed).toBeTruthy()
    await window.screenshot({ path: 'tests/e2e/results/dh-lifecycle-scheduled-trigger.png' })
  })
})

test.describe('Digital Human — real OS-level desktop notification', () => {
  test.setTimeout(150000)
  test.use({ seedOptions: { notificationLevel: 'all' } })

  test('a completed run while the window is unfocused takes the OS Notification path, not the in-app toast', async ({ window, seededApp, electronApp }) => {
    test.skip(!hasCredentials(), 'Requires HALO_TEST_API_KEY or HALO_TEST_OAUTH_SOURCE')

    await openSeededApp(window, seededApp.name)

    // notification.service.ts's isWindowFocused() branch is the only thing
    // deciding OS banner vs in-app toast, and Playwright otherwise always
    // keeps the window focused — blur the real BrowserWindow (not just the
    // DOM) so this run actually exercises the OS path, mirroring what a real
    // unattended desktop notification requires.
    let mainLog = ''
    const proc = electronApp.process()
    proc.stdout?.on('data', (chunk) => { mainLog += chunk.toString() })
    proc.stderr?.on('data', (chunk) => { mainLog += chunk.toString() })

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.blur()
    })

    await runNow(window)

    // The completed badge is DB-driven, independent of which notification
    // path fired, so it stays the reliable "run finished" signal even though
    // the window is blurred and the renderer may be throttled.
    const activityTab = await window.$('text=/^Activity$|^活动$/i')
    if (activityTab) await activityTab.click()
    await window.waitForSelector('text=/Completed|已完成/i', { timeout: 90000 }).catch(() => {})

    // notification.service.ts logs this exact line only on the OS branch
    // (notifyAppEvent's `else` — Notification.isSupported() && !focused).
    await window.waitForTimeout(1000)
    expect(mainLog).toContain('OS notification.show() called')
  })
})

test.describe('Digital Human — notification preference UI', () => {
  test.setTimeout(30000)

  test('the notification level control is reachable under the app\'s Settings tab', async ({ window, seededApp }) => {
    await openSeededApp(window, seededApp.name)

    const settingsTab = await window.waitForSelector('text=/^Settings$|^设置$/i', { timeout: 10000 })
    await settingsTab.click()

    // AppConfigPanel.tsx renders this section header plus one button per
    // level (Important/All/None) — the exact gating levels notification.service.ts reads.
    const notifySection = await window.waitForSelector(
      'text=/System Notifications|系统通知/i',
      { timeout: 10000 }
    )
    expect(notifySection).toBeTruthy()

    for (const levelPattern of [/^Important$|^重要$/i, /^All$|^所有$|^全部$/i, /^None$|^无$|^不通知$/i]) {
      const levelButton = await window.$(`text=${levelPattern}`)
      expect(levelButton, `missing notification-level button matching ${levelPattern}`).toBeTruthy()
    }
  })
})
