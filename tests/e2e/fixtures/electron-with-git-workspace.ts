/**
 * Electron fixture that boots into the seeded git workspace (git-workspace.ts):
 * a space on a real repository with every kind of change, and a stored
 * conversation whose reply edited files. Each test gets a fresh copy, so tests
 * may stage, commit and discard freely.
 *
 * The window is resized to a desktop size where the canvas docks its file
 * panel beside the diffs.
 */

import { test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { getAppEntryPath, launchElectronApp } from './electron'
import { navigateToWorkspaces } from './helpers'
import { CONVERSATION_TITLE, SPACE_NAME, createGitWorkspace, type GitWorkspace } from './git-workspace'

interface Fixtures {
  replyEditCount: number
  workspace: GitWorkspace
  electronApp: ElectronApplication
  window: Page
}

export const WINDOW_SIZE = { width: 1600, height: 1000 }

export const test = base.extend<Fixtures>({
  replyEditCount: [1, { option: true }],
  workspace: async ({ replyEditCount }, use) => {
    const workspace = createGitWorkspace(replyEditCount)
    await use(workspace)
    workspace.cleanup()
  },

  electronApp: async ({ workspace }, use) => {
    const app = await launchElectronApp(getAppEntryPath(), workspace.testConfigDir)
    await use(app)
    await app.close()
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await electronApp.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win.isMaximized()) win.unmaximize()
      win.setSize(size.width, size.height)
    }, WINDOW_SIZE)
    await navigateToWorkspaces(window)
    await window.locator('[role="button"]:not([aria-roledescription="sortable"])').filter({
      has: window.getByRole('heading', { name: SPACE_NAME, exact: true, level: 3 }),
    }).click()
    await expect(window.locator('textarea')).toBeVisible()
    await expect(window.getByRole('banner').getByText(CONVERSATION_TITLE, { exact: true })).toBeVisible()
    await use(window)
  },
})

export { expect } from '@playwright/test'
