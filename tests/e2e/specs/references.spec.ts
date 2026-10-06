/**
 * Pointing at content from the canvas. A comment in a diff opens as a card
 * under the commented line and shows up in the composer as a "comments" pill;
 * a selection added from a code file with ⌘L / Ctrl+L shows up as a
 * "selections" pill. A pill's popover lists its references, removes one, and
 * goes back to a comment for editing; removing a whole group can be undone.
 * Test actions never send a model request.
 */

import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '../fixtures/electron-with-git-workspace'
import { EDITS, createGitWorkspace } from '../fixtures/git-workspace'
import {
  ADD_TO_CHAT_KEY,
  commentCard,
  commentOnWord,
  composerPill,
  diffCard,
  doubleClickWord,
  ensureFilePanel,
  filePanel,
  openChangesWithShortcut,
  referencePopover,
  selectionBar,
} from '../fixtures/changes-helpers'

const GREETING_NOTE = 'Keep the greeting in one shared constant'
const IMPORT_NOTE = 'Import formatTotal once'

test.describe('references', () => {
  let pageErrors: string[]
  test.beforeEach(async ({ window }) => {
    pageErrors = []
    window.on('pageerror', (error) => pageErrors.push(error.message))
  })
  test.afterEach(() => {
    expect(pageErrors).toEqual([])
  })

  test.describe('Markdown file links', () => {
    test.use({
      workspace: async ({}, use) => {
        const workspace = createGitWorkspace(1, root => [
          '[Relative report](.halo/tmp/report.final.md)',
          '[Absolute report](<' + path.join(root, '.halo/tmp/report.final.md') + '>)',
          '[Unicode report](docs/%E8%AF%84%E5%AE%A1%20(1).md)',
          '[Source line](src/app.ts:3)',
          '[Missing](notes/missing.md)',
          '[Outside](../outside.md)',
          '[Website](https://example.com/)',
          '[Unsafe](javascript:alert)',
        ].join('\n\n'))
        fs.mkdirSync(path.join(workspace.repoRoot, '.halo/tmp'), { recursive: true })
        fs.writeFileSync(path.join(workspace.repoRoot, '.halo/tmp/report.final.md'), '# Final link report\n')
        fs.writeFileSync(path.join(workspace.repoRoot, 'docs/评审 (1).md'), '# Unicode link report\n')
        try {
          await use(workspace)
        } finally {
          workspace.cleanup()
        }
      },
    })

    test('opens named relative and absolute files in Canvas, including keyboard and mobile activation', async ({ window, electronApp }) => {
      const reply = window.locator('.markdown-content').filter({ hasText: 'Relative report' })
      await expect(reply).toBeVisible()
      await expect(reply.getByText('Relative report', { exact: true })).not.toContainText('[blocked]')
      await expect(reply.locator('span[title^="Blocked URL:"]')).toHaveCount(1)
      await expect(reply.getByRole('link', { name: /report\.final\.md/ })).toHaveCount(2)
      await reply.getByText('Relative report', { exact: true }).click()
      await expect(window.locator('[title="report.final.md"]')).toBeVisible()
      await expect(window.getByRole('heading', { name: 'Final link report', exact: true })).toBeVisible()
      await reply.getByText('Absolute report', { exact: true }).focus()
      await window.keyboard.press('Enter')
      await expect(window.locator('[title="report.final.md"]')).toHaveCount(1)
      await reply.getByText('Source line', { exact: true }).click()
      await expect(window.locator('[title="app.ts"]')).toBeVisible()
      await expect(window.locator('.cm-line', { hasText: "const greeting = 'hello, world'" })).toBeVisible()
      expect(await reply.getByText('Missing', { exact: true }).getAttribute('role')).toBeNull()
      expect(await reply.getByText('Outside', { exact: true }).getAttribute('role')).toBeNull()
      await expect(reply.getByText('Website', { exact: true })).toHaveAttribute('href', 'https://example.com/')
      expect(await reply.getByText('Unsafe [blocked]', { exact: true }).getAttribute('href')).toBeNull()
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].setSize(390, 844)
      })
      await expect(reply.getByText('Unicode report', { exact: true })).toBeVisible()
      await reply.getByText('Unicode report', { exact: true }).click()
      await expect(window.getByRole('heading', { name: 'Unicode link report', exact: true })).toBeVisible()
      expect(await window.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true)
    })
  })

  test('returns to a comment after another file replaces its editors in a large diff', async ({ window, workspace }) => {
    const folder = path.join(workspace.repoRoot, 'src', 'bulk')
    fs.mkdirSync(folder, { recursive: true })
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(folder, `item-${i}.ts`), `export const item${i} = ${i}\n`)
    await openChangesWithShortcut(window)
    await ensureFilePanel(window)
    await expect(window.getByText('Large diff · Showing one file at a time')).toBeVisible()
    await filePanel(window).getByLabel('Filter files (e.g. src/**)').fill('src/app.ts')
    await filePanel(window).locator('button[title="src/app.ts"]').click()
    await filePanel(window).getByLabel('Filter files (e.g. src/**)').fill('')
    await expect(window.locator('section[data-file-key="src/app.ts"]')).toHaveCount(1)
    const after = diffCard(window, 'src/app.ts').locator('.cm-merge-b')
    await commentOnWord(window, after.locator('.cm-line', { hasText: EDITS.appAfter }).first(), 'world', GREETING_NOTE)
    // src/app.ts is the last file the list shows (folders come first), so step back.
    await window.getByRole('button', { name: 'Previous file', exact: true }).click()
    await expect(diffCard(window, 'src/app.ts')).toHaveCount(0)
    await composerPill(window, 'comments').click()
    await referencePopover(window, 'comments').getByRole('listitem').filter({ hasText: GREETING_NOTE }).getByRole('button').first().click()
    const comment = commentCard(window, 'Comment · line 3 · After')
    await expect(comment.getByRole('button', { name: 'Edit' })).toBeFocused()
    await expect(comment).toContainText(GREETING_NOTE)
    await expect(window.locator('section[data-file-key]')).toHaveCount(1)
    await expect(comment).toBeInViewport()
  })

  test('comments and a selection become pills; the popover lists, removes and goes back; removing a group can be undone', async ({ window }) => {
    await openChangesWithShortcut(window)
    await ensureFilePanel(window)
    await filePanel(window).locator('button[title="src/app.ts"]').click()
    const card = diffCard(window, 'src/app.ts')
    // The diff's after side: the right-hand editor of the side-by-side layout.
    const after = card.locator('.cm-merge-b')

    // A comment on the edited line: the card opens under it, then shows the note.
    await commentOnWord(window, after.locator('.cm-line', { hasText: EDITS.appAfter }).first(), 'world', GREETING_NOTE)
    const greeting = commentCard(window, 'Comment · line 3 · After')
    await expect(greeting).toContainText(GREETING_NOTE)
    await expect(greeting.getByRole('button', { name: 'Edit' })).toBeVisible()
    await expect(composerPill(window, 'comments')).toHaveText(/^1 comments?$/)

    // A second comment, on an unchanged line.
    await commentOnWord(window, after.locator('.cm-line', { hasText: "import { formatTotal } from './util'" }).first(), 'formatTotal', IMPORT_NOTE)
    await expect(commentCard(window, 'Comment · line 1 · After')).toContainText(IMPORT_NOTE)
    await expect(composerPill(window, 'comments')).toHaveText(/^2 comments?$/)

    // A selection from the same file opened as code, with the keyboard.
    await card.getByRole('button', { name: 'Open in editor' }).click()
    const importLine = window.locator('.cm-editor .cm-line', { hasText: "import { formatTotal } from './util'" }).first()
    await expect(importLine).toBeVisible()
    await doubleClickWord(window, importLine, 'formatTotal')
    await expect(selectionBar(window)).toBeVisible()
    await window.keyboard.press(ADD_TO_CHAT_KEY)
    await expect(composerPill(window, 'selections')).toHaveText(/^1 selections?$/)

    // The comments pill lists both; one is removed from the list.
    await composerPill(window, 'comments').click()
    const comments = referencePopover(window, 'comments')
    await expect(comments.getByRole('listitem')).toHaveCount(2)
    const importRow = comments.getByRole('listitem').filter({ hasText: IMPORT_NOTE })
    await importRow.hover()
    await importRow.getByRole('button', { name: 'Remove comment' }).click()
    await expect(comments.getByRole('listitem')).toHaveCount(1)
    await expect(composerPill(window, 'comments')).toHaveText(/^1 comments?$/)

    // A row goes back to its comment, ready to edit.
    await comments.getByRole('listitem').filter({ hasText: GREETING_NOTE }).getByRole('button').first().click()
    await expect(greeting.getByRole('button', { name: 'Edit' })).toBeFocused()

    // Removing the whole group asks nothing and can be undone.
    await composerPill(window, 'comments').hover()
    await window.getByRole('button', { name: 'Remove all comments' }).click()
    await expect(composerPill(window, 'comments')).toHaveCount(0)
    // The notice is shown and announced (the toast's live region).
    await expect(window.getByRole('status').filter({ hasText: /Removed 1 comments?/ })).toHaveCount(1)
    await window.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(composerPill(window, 'comments')).toHaveText(/^1 comments?$/)
    await expect(composerPill(window, 'selections')).toHaveText(/^1 selections?$/)
  })
})
