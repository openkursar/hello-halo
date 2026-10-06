/**
 * Shared E2E Test Helpers
 *
 * Common navigation and interaction utilities for all E2E test specs.
 * Centralized to avoid duplication and ensure consistency.
 */

import { expect, type Page } from '@playwright/test'

/**
 * Wait for the app to finish loading and show its shell.
 *
 * The rail is the shell's persistent furniture on every view, so it is what a
 * loaded app can be recognised by.
 */
export async function waitForHomePage(window: Page) {
  await window.waitForSelector('#root', { timeout: 15000 })
  await window.waitForLoadState('domcontentloaded')
  const skip = window.getByRole('button', { name: 'Skip for now', exact: true })
  await skip.or(window.locator('nav button').first()).first().waitFor({ state: 'visible', timeout: 15000 })
  if (await skip.isVisible()) await skip.click()
  await window.waitForSelector('nav button', { timeout: 15000 })
}

/**
 * Navigate to the chat interface through the rail's Conversation entry.
 * Waits for the textarea input to appear, indicating the chat is ready.
 */
export async function navigateToChat(window: Page) {
  await waitForHomePage(window)

  await window.getByRole('button', { name: 'Conversation', exact: true }).first().click()

  // Wait for chat interface to load (textarea should appear)
  await window.waitForSelector('textarea', { timeout: 15000 })
}

/** Navigate through the persistent rail and wait for the settings content. */
export async function navigateToSettings(window: Page) {
  await waitForHomePage(window)
  await window.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await expect(window.locator('#ai-model').getByRole('heading', { name: 'AI Model', exact: true })).toBeVisible()
}

/** Workspace management is reached from the shared header selector. */
export async function navigateToWorkspaces(window: Page) {
  await waitForHomePage(window)
  await window.getByTitle('Manage workspaces', { exact: true }).click()
  await expect(window.getByRole('heading', { name: 'Workspace', exact: true, level: 1 })).toBeVisible()
}

/** Navigate to the Apps page through the rail's Digital Humans entry. */
export async function navigateToApps(window: Page) {
  await waitForHomePage(window)

  await window.getByRole('button', { name: 'Digital Humans', exact: true }).first().click()

  // Wait for Apps page tab bar to render
  await window.waitForSelector(
    'text=/My Digital Humans|我的数字人/i',
    { timeout: 10000 }
  )
}

/** The section sits inside Settings' scrollable main content. */
export async function navigateToRemoteSettings(window: Page) {
  await navigateToSettings(window)
  await window.locator('#remote').scrollIntoViewIfNeeded()
  await expect(window.locator('#remote').getByRole('heading', { name: 'Remote Access', exact: true })).toBeVisible()
}

/** Click the visible switch label and verify its asynchronous state change. */
export async function clickRemoteToggle(window: Page) {
  const checkbox = window.locator('#remote input[type="checkbox"]')
  const enabled = await checkbox.isChecked()
  await expect(checkbox).toBeEnabled()
  await window.locator('#remote label').filter({ has: window.locator('input[type="checkbox"]') }).click()
  await expect(checkbox).toBeChecked({ checked: !enabled })
}

/**
 * Send a message in the chat interface.
 * Assumes we're already on the SpacePage with textarea visible.
 */
export async function sendMessage(window: Page, message: string) {
  const chatInput = await window.waitForSelector('textarea', { timeout: 5000 })
  await chatInput.fill(message)

  const sendButton = await window.waitForSelector(
    '[data-onboarding="send-button"]',
    { timeout: 5000 }
  )
  await sendButton.click({ force: true })
}

/**
 * Wait for AI response to complete.
 * Waits for assistant message to appear and working indicator to disappear.
 */
export async function waitForAIResponse(window: Page, timeout = 45000) {
  // Wait for user message to appear
  await window.waitForSelector('.message-user', { timeout: 15000 })

  // Wait for AI response to start
  await window.waitForSelector('.message-assistant', { timeout: 30000 })

  // Wait for AI to finish working (supports both EN and CN)
  await window.waitForSelector(
    'text=/Halo 工作中|Halo is working/i',
    { state: 'hidden', timeout }
  ).catch(() => {
    // Indicator might have already disappeared
  })
}
