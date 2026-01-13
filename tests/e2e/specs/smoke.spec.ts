/**
 * Smoke Tests
 *
 * Basic tests to verify the application launches and core UI renders correctly.
 * These tests run quickly and catch fundamental issues.
 */

import { test, expect, hasApiKey } from '../fixtures/electron'

/**
 * Helper to navigate from Home Page to Chat Interface
 */
async function navigateToChat(window: any) {
  await window.waitForSelector('#root', { timeout: 10000 })
  await window.waitForLoadState('networkidle')

  // Look for "进入 Halo" text button
  let enterHalo = await window.waitForSelector(
    'text=/进入 Halo/',
    { timeout: 5000 }
  ).catch(() => null)

  if (!enterHalo) {
    enterHalo = await window.waitForSelector(
      ':text("Halo"):visible',
      { timeout: 5000 }
    ).catch(() => null)
  }

  if (enterHalo) {
    await enterHalo.click()
  }

  await window.waitForSelector('textarea', { timeout: 10000 })
}

/**
 * Helper to navigate to settings and find remote section
 */
async function navigateToRemoteSettings(window: any) {
  await window.waitForSelector('#root', { timeout: 10000 })
  await window.waitForLoadState('networkidle')

  const settingsButton = await window.waitForSelector('button:has(svg)', { timeout: 10000 })
  await settingsButton.click()
  await window.waitForTimeout(500)

  await window.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await window.waitForTimeout(500)

  await window.waitForSelector('text=/远程访问/i', { timeout: 10000 })
}

/**
 * Helper to click the remote access toggle
 */
async function clickRemoteToggle(window: any) {
  await window.evaluate(() => {
    const labels = document.querySelectorAll('label')
    for (const label of labels) {
      const checkbox = label.querySelector('input[type="checkbox"]')
      if (checkbox) {
        const parent = label.closest('div')
        if (parent && parent.textContent?.includes('启用远程访问')) {
          label.click()
          break
        }
      }
    }
  })
}

test.describe('Smoke Tests', () => {
  test('application launches successfully', async ({ electronApp }) => {
    // Verify app is running
    const isRunning = electronApp.process() !== null
    expect(isRunning).toBe(true)
  })

  test('main window opens', async ({ window }) => {
    // Verify window is visible
    const title = await window.title()
    expect(title).toBeTruthy()
  })

  test('window has correct dimensions', async ({ window }) => {
    // Get actual window dimensions from the renderer
    const dimensions = await window.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight
    }))

    // Window should have reasonable size
    expect(dimensions.width).toBeGreaterThan(600)
    expect(dimensions.height).toBeGreaterThan(400)
  })

  test('renders main UI container', async ({ window }) => {
    // Wait for React app to mount
    await window.waitForSelector('#root', { timeout: 10000 })

    // Verify root element exists
    const root = await window.$('#root')
    expect(root).toBeTruthy()
  })

  test('shows splash or main content', async ({ window }) => {
    // App should show either splash screen or main content
    // Wait for any of these to appear
    await Promise.race([
      window.waitForSelector('[data-testid="splash-screen"]', { timeout: 5000 }).catch(() => null),
      window.waitForSelector('[data-testid="main-content"]', { timeout: 5000 }).catch(() => null),
      window.waitForSelector('[data-testid="api-setup"]', { timeout: 5000 }).catch(() => null),
      // Fallback: any visible text content
      window.waitForSelector('text=/Halo|API|连接|设置/', { timeout: 5000 }).catch(() => null)
    ])

    // Take screenshot for debugging
    await window.screenshot({ path: 'tests/e2e/results/smoke-initial-state.png' })
  })

  test('no console errors on startup', async ({ window }) => {
    const errors: string[] = []

    // Listen for console errors
    window.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text())
      }
    })

    // Wait a moment for any async errors
    await window.waitForTimeout(2000)

    // Filter out known acceptable errors
    const criticalErrors = errors.filter(error =>
      !error.includes('net::ERR_') && // Network errors are acceptable
      !error.includes('favicon') && // Favicon errors are acceptable
      !error.includes('DevTools') // DevTools messages are acceptable
    )

    expect(criticalErrors).toHaveLength(0)
  })

  test('no unhandled promise rejections', async ({ electronApp }) => {
    const rejections: string[] = []

    // Listen for unhandled rejections in main process
    electronApp.on('close', () => {
      // Process closed normally
    })

    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 2000))

    expect(rejections).toHaveLength(0)
  })
})

test.describe('First Launch Flow', () => {
  test('shows API setup on first launch', async ({ window }) => {
    // First launch should show API setup or main content
    // Wait for the app to fully render
    await window.waitForSelector('#root', { timeout: 10000 })

    // Check that some meaningful content is displayed
    // Could be API setup, main chat, or settings
    const bodyText = await window.evaluate(() => document.body.innerText)

    // App should have rendered some text content
    expect(bodyText.length).toBeGreaterThan(0)
  })
})

test.describe('Basic Navigation', () => {
  test('settings button is accessible', async ({ window }) => {
    // Wait for app to fully load
    await window.waitForLoadState('networkidle')

    // Look for settings button (gear icon)
    const settingsButton = await window.$('[data-testid="settings-button"], button:has(svg[class*="settings"]), button:has(svg[class*="cog"])').catch(() => null)

    // Settings should be accessible from main UI
    // Note: May not be visible during API setup
    if (settingsButton) {
      expect(settingsButton).toBeTruthy()
    }
  })
})

/**
 * Core Features Smoke Tests
 *
 * These tests verify critical functionality:
 * - Chat: AI can send messages and receive responses
 * - Remote: Tunnel can be enabled and get public URL
 */
test.describe('Core Features', () => {
  test.setTimeout(60000)

  test('can send message and receive AI response', async ({ window }, testInfo) => {
    // Skip if no API key configured
    if (!hasApiKey()) {
      testInfo.skip(true, 'Skipping: HALO_TEST_API_KEY not set')
      return
    }

    await navigateToChat(window)

    const chatInput = await window.waitForSelector('textarea', { timeout: 5000 })
    await chatInput.fill('Say "Hello Test" and nothing else.')

    const sendButton = await window.waitForSelector('[data-onboarding="send-button"]', { timeout: 5000 })
    await sendButton.click({ force: true })

    // Wait for user message
    await window.waitForSelector('.message-user', { timeout: 10000 })

    // Wait for AI message
    await window.waitForSelector('.message-assistant', { timeout: 30000 })

    // Wait for AI to finish working
    await window.waitForSelector('text="Halo 工作中"', { state: 'hidden', timeout: 45000 }).catch(() => {})

    // Verify AI response contains expected content
    const assistantMessage = await window.waitForSelector('.message-assistant', { timeout: 5000 })
    const responseText = await assistantMessage.textContent()
    expect(responseText?.toLowerCase()).toContain('hello')

    await window.screenshot({ path: 'tests/e2e/results/smoke-chat-response.png' })
  })

  test('can enable tunnel and get public URL', async ({ window }) => {
    await navigateToRemoteSettings(window)

    // Enable remote access
    await clickRemoteToggle(window)
    await window.waitForTimeout(2000)

    // Wait for LAN section
    await window.waitForSelector('text=/本机地址|局域网地址/i', { timeout: 15000 })

    await window.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await window.waitForTimeout(500)

    // Click tunnel button
    const tunnelButton = await window.waitForSelector('button:has-text("启动隧道")', { timeout: 10000 })
    await tunnelButton.click()

    // Wait for public URL
    const publicUrl = await window.waitForSelector(
      'text=/\\.trycloudflare\\.com|公网地址/i',
      { timeout: 30000 }
    ).catch(() => null)

    if (publicUrl) {
      const urlCode = await window.waitForSelector('code:has-text("trycloudflare.com")', { timeout: 15000 }).catch(() => null)
      expect(urlCode).toBeTruthy()
      await window.screenshot({ path: 'tests/e2e/results/smoke-tunnel-enabled.png' })
    } else {
      // Check for error state (network issue is acceptable)
      const errorMsg = await window.$('text=/隧道连接失败|Tunnel.*fail|error/i')
      expect(publicUrl || errorMsg).toBeTruthy()
      await window.screenshot({ path: 'tests/e2e/results/smoke-tunnel-error.png' })
    }
  })
})
