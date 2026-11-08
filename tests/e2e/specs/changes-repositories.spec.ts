import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ElectronApplication, Page } from '@playwright/test'
import type { RpcClient } from '../../../src/shared/rpc/define'
import type { gitRpc } from '../../../src/shared/rpc/contracts/git.contract'
import { test as base, expect, WINDOW_SIZE } from '../fixtures/electron-with-git-workspace'
import { getAppEntryPath, launchElectronApp } from '../fixtures/electron'
import { CONVERSATION_TITLE, SPACE_NAME, createGitWorkspace, type GitWorkspace } from '../fixtures/git-workspace'
import { navigateToWorkspaces } from '../fixtures/helpers'
import { diffCard, diffCardPaths, openChangesWithShortcut } from '../fixtures/changes-helpers'

const DEEP_PATH = 'packages/sdk/deep-repo'
const UNOPENED_PATH = 'packages/other/unopened-repo'
const DEEP_CONTENT = 'export const deepRepositoryMarker = "deep-only"\n'
const acceptance = {
  annotation: {
    type: 'acceptance',
    description: JSON.stringify({ caseId: 'changes.inspect.deep-repositories', evidence: 'app-e2e', mode: 'none', variant: {} }),
  },
}

interface RepositoryApplication {
  app: ElectronApplication
  restart(afterClose?: () => void): Promise<Page>
}

async function enterWorkspace(app: ElectronApplication): Promise<Page> {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }, size) => {
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
  return window
}

const test = base.extend<{ repositoryApp: RepositoryApplication }>({
  workspace: async ({}, use) => {
    const workspace = createGitWorkspace(1, () => `[Deep source](${DEEP_PATH}/deep.ts)`)
    try {
      fs.appendFileSync(path.join(workspace.repoRoot, '.gitignore'), '\npackages/\n')
      for (const relative of [DEEP_PATH, UNOPENED_PATH]) {
        const root = path.join(workspace.repoRoot, relative)
        fs.mkdirSync(root, { recursive: true })
        workspace.git('-C', root, 'init', '-q')
        fs.writeFileSync(path.join(root, 'deep.ts'), DEEP_CONTENT)
      }
      const outside = path.join(path.dirname(workspace.repoRoot), 'outside-repo')
      fs.mkdirSync(outside)
      workspace.git('-C', outside, 'init', '-q')
      fs.writeFileSync(path.join(outside, 'outside.ts'), 'export const outside = true\n')
      await use(workspace)
    } finally {
      workspace.cleanup()
    }
  },
  // Keep the seeded workspace and profile, but replace both Electron processes on restart.
  repositoryApp: async ({ workspace }, use, testInfo) => {
    const application: RepositoryApplication = {
      app: await launchElectronApp(getAppEntryPath(), workspace.testConfigDir),
      async restart(afterClose) {
        await this.app.close()
        afterClose?.()
        this.app = await launchElectronApp(getAppEntryPath(), workspace.testConfigDir)
        return enterWorkspace(this.app)
      },
    }
    try {
      await use(application)
    } finally {
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          const log = path.join(workspace.testConfigDir, '.halo/logs/main.log')
          if (fs.existsSync(log)) {
            await testInfo.attach('electron-main-log', { body: fs.readFileSync(log).subarray(-500000), contentType: 'text/plain' })
          }
        }
      } finally {
        await application.app.close()
      }
    }
  },
  electronApp: async ({ repositoryApp }, use) => {
    await use(repositoryApp.app)
  },
})

test.describe.configure({ timeout: 120000, retries: 0 })
test.use({ actionTimeout: 15000 })

const picker = (window: Page) => window.getByRole('button', { name: /^Repository: / })
const repositoryMenu = (window: Page) => window.getByRole('menu', { name: 'Repositories in this space', exact: true })
const repositoryGroup = (window: Page, root: string) => repositoryMenu(window).getByRole('group', { name: root, exact: true })

async function openPicker(window: Page): Promise<void> {
  await picker(window).click()
  await expect(repositoryMenu(window)).toBeVisible()
}

async function pickFolder(app: ElectronApplication, window: Page, root: string | null): Promise<void> {
  await openPicker(window)
  // Only the OS dialog result is substituted; preload, IPC, validation and persistence stay real.
  const observation = await app.evaluateHandle(({ dialog }, selected) => {
    const original = dialog.showOpenDialog
    const state = { calls: 0, properties: [] as string[], restore: () => { dialog.showOpenDialog = original } }
    dialog.showOpenDialog = async (...args: [Electron.OpenDialogOptions] | [Electron.BaseWindow, Electron.OpenDialogOptions]) => {
      const options = args.length === 2 ? args[1] : args[0]
      state.calls++
      state.properties = options.properties ?? []
      return { canceled: selected === null, filePaths: selected === null ? [] : [selected] }
    }
    return state
  }, root)
  try {
    await repositoryMenu(window).getByRole('menuitem', { name: 'Open repository…', exact: true }).click()
    await expect.poll(() => observation.evaluate(state => state.calls)).toBe(1)
    await expect(picker(window)).toBeEnabled()
    expect(await observation.evaluate(state => state.properties)).toContain('openDirectory')
    expect(await observation.evaluate(state => state.calls)).toBe(1)
  } finally {
    await observation.evaluate(state => state.restore())
    await observation.dispose()
  }
}

async function repositories(window: Page, workspace: GitWorkspace) {
  const response = await window.evaluate(spaceId => {
    const { halo } = globalThis as unknown as { halo: RpcClient<typeof gitRpc> }
    return halo.gitListRepositories(spaceId)
  }, workspace.spaceId)
  expect(response.success, JSON.stringify(response)).toBe(true)
  expect(response.data?.git.available).toBe(true)
  expect(response.data).toBeDefined()
  return response.data!
}

async function expectDeepDiff(window: Page, workspace: GitWorkspace): Promise<void> {
  await expect(picker(window)).toHaveAttribute('title', path.join(workspace.repoRoot, DEEP_PATH))
  await expect.poll(() => diffCardPaths(window)).toEqual(['deep.ts'])
  await expect(diffCard(window, 'deep.ts').locator('.cm-content').filter({ hasText: 'deepRepositoryMarker' })).toBeVisible()
  await expect(window.locator('[data-file-key="src/app.ts"]')).toHaveCount(0)
}

async function openDeepRepository(app: ElectronApplication, window: Page, workspace: GitWorkspace): Promise<void> {
  await openChangesWithShortcut(window)
  await expect(picker(window)).toHaveAttribute('title', workspace.repoRoot)
  await pickFolder(app, window, path.join(workspace.repoRoot, DEEP_PATH))
  await expect(repositoryMenu(window)).toHaveCount(0)
  await expectDeepDiff(window, workspace)
}

// Includes ignored files, untracked files and Git metadata, not just porcelain status.
function treeSnapshot(root: string): Record<string, { hash: string; mode: number; mtimeMs: number } | 'directory'> {
  const result: ReturnType<typeof treeSnapshot> = {}
  const visit = (relative: string) => {
    const absolute = path.join(root, relative)
    const stat = fs.lstatSync(absolute)
    if (stat.isDirectory()) {
      result[relative] = 'directory'
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name))
    } else {
      const content = stat.isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute)
      result[relative] = { hash: createHash('sha256').update(content).digest('hex'), mode: stat.mode, mtimeMs: stat.mtimeMs }
    }
  }
  visit('')
  return result
}

test('discovers the nearest ignored repository from an opened file without mixing outer changes', acceptance, async ({ window, workspace }) => {
  await openChangesWithShortcut(window)
  await expect(picker(window)).toHaveAttribute('title', workspace.repoRoot)
  await expect.poll(() => diffCardPaths(window)).toContain('src/app.ts')
  const deepRoot = path.join(workspace.repoRoot, DEEP_PATH)
  expect((await repositories(window, workspace)).repositories.map(repo => repo.root)).not.toContain(deepRoot)

  await window.locator('.markdown-content').getByText('Deep source', { exact: true }).click()
  await expect(window.locator('[title="deep.ts"]')).toBeVisible()
  await openChangesWithShortcut(window)
  await openPicker(window)
  await repositoryGroup(window, deepRoot).getByRole('menuitemradio').click()
  await expectDeepDiff(window, workspace)
  expect((await repositories(window, workspace)).savedRepositories ?? []).toEqual([])
})

test('remembers an explicitly opened deep repository across restart and removes only its record', acceptance, async ({ window, workspace, repositoryApp }) => {
  const before = treeSnapshot(workspace.repoRoot)
  const deepRoot = path.join(workspace.repoRoot, DEEP_PATH)
  await openDeepRepository(repositoryApp.app, window, workspace)
  expect((await repositories(window, workspace)).savedRepositories).toEqual([{ root: deepRoot, available: true }])

  const reopened = await repositoryApp.restart()
  await openChangesWithShortcut(reopened)
  await openPicker(reopened)
  await expect(repositoryGroup(reopened, deepRoot)).toHaveCount(1)
  await expect(repositoryGroup(reopened, path.join(workspace.repoRoot, UNOPENED_PATH))).toHaveCount(0)
  await repositoryGroup(reopened, deepRoot).getByRole('menuitemradio').click()
  await expectDeepDiff(reopened, workspace)

  await openPicker(reopened)
  const group = repositoryGroup(reopened, deepRoot)
  await expect(group.getByText('No files will be deleted.', { exact: true })).toBeVisible()
  await group.getByRole('menuitem', { name: /^Remove from list/ }).click()
  await expect(group).toHaveCount(0)
  await expect(picker(reopened)).toHaveAttribute('title', workspace.repoRoot)
  await expect(repositoryMenu(reopened)).toHaveCount(0)
  await expect.poll(() => diffCardPaths(reopened)).toContain('src/app.ts')
  expect((await repositories(reopened, workspace)).savedRepositories ?? []).toEqual([])
  expect(treeSnapshot(workspace.repoRoot)).toEqual(before)

  const afterRemoval = await repositoryApp.restart()
  await openChangesWithShortcut(afterRemoval)
  await openPicker(afterRemoval)
  await expect(repositoryGroup(afterRemoval, deepRoot)).toHaveCount(0)
  expect((await repositories(afterRemoval, workspace)).savedRepositories ?? []).toEqual([])
  expect(treeSnapshot(workspace.repoRoot)).toEqual(before)
})

for (const selection of ['ordinary parent folder', 'outside repository'] as const) {
  test(`rejects an ${selection} without changing the selected repository`, acceptance, async ({ window, workspace, electronApp }) => {
    await openDeepRepository(electronApp, window, workspace)
    const selected = selection === 'ordinary parent folder'
      ? path.join(workspace.repoRoot, 'packages/sdk')
      : path.join(path.dirname(workspace.repoRoot), 'outside-repo')
    const before = treeSnapshot(workspace.repoRoot)
    const rejectedBefore = treeSnapshot(selected)
    const listedBefore = await repositories(window, workspace)

    await pickFolder(electronApp, window, selected)
    await expect(repositoryMenu(window).getByRole('alert')).toHaveText('Choose a Git repository folder inside this space. Parent folders and folders outside the space cannot be opened.')
    await expect(picker(window)).toHaveAttribute('title', path.join(workspace.repoRoot, DEEP_PATH))
    await expect(repositoryGroup(window, path.join(workspace.repoRoot, DEEP_PATH)).getByRole('menuitemradio')).toHaveAttribute('aria-checked', 'true')
    await window.keyboard.press('Escape')
    await expect(repositoryMenu(window)).toHaveCount(0)
    await expectDeepDiff(window, workspace)
    expect(await repositories(window, workspace)).toEqual(listedBefore)
    expect(treeSnapshot(selected)).toEqual(rejectedBefore)
    expect(treeSnapshot(workspace.repoRoot)).toEqual(before)
  })
}

test('keeps an unavailable saved repository removable after restart', acceptance, async ({ window, workspace, repositoryApp }) => {
  await openDeepRepository(repositoryApp.app, window, workspace)
  const deepRoot = path.join(workspace.repoRoot, DEEP_PATH)
  const movedRoot = path.join(path.dirname(workspace.repoRoot), 'moved-deep-repo')
  const deepBefore = treeSnapshot(deepRoot)
  const reopened = await repositoryApp.restart(() => fs.renameSync(deepRoot, movedRoot))
  const beforeRemoval = treeSnapshot(workspace.repoRoot)
  await openChangesWithShortcut(reopened)
  await expect(picker(reopened)).toHaveAttribute('title', workspace.repoRoot)
  await openPicker(reopened)
  const group = repositoryGroup(reopened, deepRoot)
  await expect(group.getByRole('menuitem', { name: /^Unavailable/ })).toBeDisabled()
  expect((await repositories(reopened, workspace)).savedRepositories).toEqual([{ root: deepRoot, available: false }])
  await group.getByRole('menuitem', { name: /^Remove from list/ }).click()
  await expect(group).toHaveCount(0)
  await expect(picker(reopened)).toHaveAttribute('title', workspace.repoRoot)
  await expect(repositoryMenu(reopened)).toHaveCount(0)
  await expect.poll(() => diffCardPaths(reopened)).toContain('src/app.ts')
  expect((await repositories(reopened, workspace)).savedRepositories ?? []).toEqual([])
  expect(treeSnapshot(workspace.repoRoot)).toEqual(beforeRemoval)
  expect(treeSnapshot(movedRoot)).toEqual(deepBefore)
  expect(fs.existsSync(deepRoot)).toBe(false)

  const afterRemoval = await repositoryApp.restart()
  await openChangesWithShortcut(afterRemoval)
  await openPicker(afterRemoval)
  await expect(repositoryGroup(afterRemoval, deepRoot)).toHaveCount(0)
  expect((await repositories(afterRemoval, workspace)).savedRepositories ?? []).toEqual([])
})

test('opening and canceling repository pickers preserves selection, records and project files', acceptance, async ({ window, workspace, electronApp }) => {
  await openDeepRepository(electronApp, window, workspace)
  const before = treeSnapshot(workspace.repoRoot)
  const listedBefore = await repositories(window, workspace)
  const unopenedRoot = path.join(workspace.repoRoot, UNOPENED_PATH)
  // An undiscovered root checks results, not whether filesystem traversal occurred.
  expect(listedBefore.repositories.map(repo => repo.root)).not.toContain(unopenedRoot)

  await openPicker(window)
  await expect(repositoryGroup(window, unopenedRoot)).toHaveCount(0)
  await window.keyboard.press('Escape')
  await expect(repositoryMenu(window)).toHaveCount(0)
  await expect(picker(window)).toBeFocused()
  await expectDeepDiff(window, workspace)

  await pickFolder(electronApp, window, null)
  await expect(repositoryMenu(window)).toBeVisible()
  await expect(repositoryMenu(window).getByRole('alert')).toHaveCount(0)
  await expect(repositoryGroup(window, unopenedRoot)).toHaveCount(0)
  await expect(repositoryGroup(window, path.join(workspace.repoRoot, DEEP_PATH)).getByRole('menuitemradio')).toHaveAttribute('aria-checked', 'true')
  await window.keyboard.press('Escape')
  await expectDeepDiff(window, workspace)
  expect(await repositories(window, workspace)).toEqual(listedBefore)
  expect(treeSnapshot(workspace.repoRoot)).toEqual(before)
})
