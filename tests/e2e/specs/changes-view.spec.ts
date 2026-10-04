/**
 * The canvas changes view against a real repository (fixtures/git-workspace.ts):
 * how it opens, what it lists, the compare scopes, stage / unstage / commit,
 * discarding with a confirmation, the folder detail page, and a reply's edits
 * opened from "View changes". No network and no model: every action is git or
 * stored data.
 */

import { test, expect } from '../fixtures/electron-with-git-workspace'
import { BASELINE, EXPECTED_STATUS } from '../fixtures/git-workspace'
import {
  chooseScope,
  clickRowAction,
  diffCardPaths,
  ensureFilePanel,
  filePanel,
  fileRow,
  openChangesFromMenu,
  openChangesWithShortcut,
  panelGroups,
} from '../fixtures/changes-helpers'

const sorted = (items: string[]) => [...items].sort()
const entries = (files: Array<{ title: string; letter: string }>) => sorted(files.map((file) => `${file.letter} ${file.title}`))

async function sortedGroups(window: Parameters<typeof panelGroups>[0]): Promise<Record<string, string[]>> {
  const groups = await panelGroups(window)
  return Object.fromEntries(Object.entries(groups).map(([name, files]) => [name, sorted(files)]))
}

test.describe('changes view', () => {
  test('opens with Ctrl+Shift+G, lists every change with its state, and switches scopes', async ({ window }) => {
    await openChangesWithShortcut(window)
    await ensureFilePanel(window)

    await expect.poll(() => sortedGroups(window)).toEqual({
      'Staged changes': entries(EXPECTED_STATUS.staged),
      Changes: entries(EXPECTED_STATUS.unstaged),
    })
    // Generated files (.gitattributes, lockfile) are hidden by default and counted.
    await expect(filePanel(window).getByText(`${EXPECTED_STATUS.hiddenGenerated.length} generated files hidden`)).toBeVisible()

    await chooseScope(window, 'Staged changes')
    await expect.poll(() => diffCardPaths(window).then(sorted)).toEqual(sorted(EXPECTED_STATUS.staged.map((file) => file.title)))

    await chooseScope(window, 'Uncommitted changes')
    await expect.poll(() => diffCardPaths(window)).toContain('src/app.ts')
  })

  test('opens from the header menu too', async ({ window }) => {
    await openChangesFromMenu(window)
    await ensureFilePanel(window)
    await expect(fileRow(window, 'src/app.ts')).toBeVisible()
  })

  test('stages and unstages a file, discards one after confirming, and commits', async ({ window, workspace }) => {
    await openChangesWithShortcut(window)
    await ensureFilePanel(window)
    await expect(fileRow(window, 'src/app.ts')).toBeVisible()

    await clickRowAction(window, 'src/app.ts', 'Stage')
    await expect.poll(async () => (await panelGroups(window))['Staged changes']).toContain('M src/app.ts')

    await clickRowAction(window, 'src/app.ts', 'Unstage')
    await expect.poll(async () => (await panelGroups(window)).Changes).toContain('M src/app.ts')

    // Discarding asks first; confirming puts the committed text back.
    await clickRowAction(window, 'src/app.ts', 'Discard')
    await expect(window.getByText('Discard changes to app.ts?')).toBeVisible()
    await window.getByRole('alertdialog').getByRole('button', { name: 'Discard', exact: true }).click()
    await expect.poll(() => workspace.readFile('src/app.ts')).toBe(BASELINE['src/app.ts'])
    await expect(fileRow(window, 'src/app.ts')).toHaveCount(0)

    // Commit what is staged: the rename and the modification.
    await window.getByLabel('Commit message').fill('Rename the thinking budget converter')
    await window.getByRole('button', { name: /^Commit 2 staged files?$/ }).click()
    await expect.poll(() => workspace.git('log', '-1', '--format=%s').trim()).toBe('Rename the thinking budget converter')
    await expect.poll(async () => Object.keys(await panelGroups(window))).not.toContain('Staged changes')
    expect(workspace.git('diff', '--cached', '--name-only').trim()).toBe('')
  })

  test('walks into a folder from the overview and back out with Esc', async ({ window }) => {
    await openChangesWithShortcut(window)
    await window.getByRole('tab', { name: /Overview & review/ }).click()

    const folder = window.locator('button[data-dir]').first()
    await expect(folder).toBeVisible()
    const dir = await folder.getAttribute('data-dir')
    await folder.click()

    const position = window.getByText(/\d+ of \d+ · by lines changed/)
    await expect(position).toBeVisible()
    await expect(window.locator(`span[title="${dir || '/'}"]`).first()).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(position).toHaveCount(0)
    await expect(window.locator(`button[data-dir="${dir}"]`)).toBeVisible()
    // Esc stepped back inside the view; the canvas stayed open.
    await expect(window.getByRole('tab', { name: /Overview & review/ })).toBeVisible()
  })

  test("opens a reply's edits from View changes, read-only", async ({ window }) => {
    await window.getByRole('button', { name: /View changes/ }).click()

    await expect(window.getByText('2 files edited in this reply · Read-only')).toBeVisible({ timeout: 20000 })
    await ensureFilePanel(window)
    await expect(fileRow(window, 'src/app.ts')).toBeVisible()
    await expect(fileRow(window, 'notes/todo.md')).toBeVisible()
    // A reply's edits cannot be staged or committed from here.
    await expect(window.getByLabel('Commit message')).toHaveCount(0)
    await expect(window.getByRole('button', { name: 'Stage', exact: true })).toHaveCount(0)
  })
})
