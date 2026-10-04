/**
 * Driving the canvas changes view and the reference layer from a spec. Every
 * locator goes through roles, accessible names and the paths shown in
 * titles — the same handles a screen reader gets — rather than class names.
 */

import { expect, type Locator, type Page } from '@playwright/test'

export const FILTER_LABEL = 'Filter files (e.g. src/**)'
/** The reference layer's "add to chat" shortcut: ⌘L on macOS, Ctrl+L elsewhere. */
export const ADD_TO_CHAT_KEY = process.platform === 'darwin' ? 'Meta+L' : 'Control+L'

/** The file panel docked beside the diffs. */
export function filePanel(window: Page): Locator {
  return window.locator('aside').filter({ has: window.getByLabel(FILTER_LABEL) })
}

/** The compare-scope picker; its name says the scope in effect. */
export function scopeButton(window: Page): Locator {
  return window.getByRole('button', { name: /^Compare: / })
}

/**
 * Show the file panel: docked beside the diffs when the canvas is wide
 * enough, otherwise a modal drawer behind the "File list" toggle (which
 * covers the diffs until it closes).
 */
export async function ensureFilePanel(window: Page): Promise<void> {
  const panel = filePanel(window)
  if (await panel.isVisible().catch(() => false)) return
  await window.getByRole('button', { name: 'File list', exact: true }).click()
  await expect(panel).toBeVisible()
}

/** Open the changes view with Ctrl+Shift+G (the shortcut on every platform) and wait for it to load. */
export async function openChangesWithShortcut(window: Page): Promise<void> {
  await window.keyboard.press('Control+Shift+G')
  await expect(scopeButton(window)).toBeVisible({ timeout: 20000 })
}

/** Open the changes view from the header's "More" menu. */
export async function openChangesFromMenu(window: Page): Promise<void> {
  await window.getByRole('banner').getByRole('button', { name: 'More', exact: true }).click()
  await window.getByRole('button', { name: /Review, stage and commit Git changes/ }).click()
  await expect(scopeButton(window)).toBeVisible({ timeout: 20000 })
}

/** Pick a compare scope from the scope picker. */
export async function chooseScope(window: Page, label: 'Uncommitted changes' | 'Staged changes'): Promise<void> {
  await scopeButton(window).click()
  await window.getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click()
  await expect(window.getByRole('button', { name: `Compare: ${label}` })).toBeVisible()
}

/**
 * The panel's groups as `{ "Staged changes": ["M docs/guide.md", ...] }`, in
 * the order shown. A rename reads "R old → new", as its title does.
 */
export async function panelGroups(window: Page): Promise<Record<string, string[]>> {
  return filePanel(window).evaluate((aside) => {
    const groups: Record<string, string[]> = {}
    let current = ''
    for (const button of aside.querySelectorAll('button')) {
      const title = button.getAttribute('title')
      // Group headers fold and are named by their text; folder rows fold too, titled with the folder.
      if (button.hasAttribute('aria-expanded')) {
        const name = button.textContent?.trim()
        if (!title && name && !button.hasAttribute('aria-label')) {
          current = name
          groups[current] = []
        }
        continue
      }
      // File rows: the path as title, the state letter beside it (its full name is the letter's title).
      const letter = button.parentElement?.querySelector(':scope > span[title] > span[aria-hidden]')?.textContent?.trim()
      if (!title || !letter || !current) continue
      groups[current].push(`${letter} ${title}`)
    }
    return groups
  })
}

/** The panel row of a file (its title is the path, or "old → new" for a rename). */
export function fileRow(window: Page, title: string): Locator {
  return filePanel(window).locator(`button[title="${title}"]`).locator('..')
}

/**
 * Click a row action. Actions show on hover, and a row whose last operation is
 * still settling shows a spinner instead (or moves to another group), so hover
 * again until the action is there.
 */
export async function clickRowAction(window: Page, title: string, action: string): Promise<void> {
  const row = fileRow(window, title).first()
  const button = row.getByRole('button', { name: action, exact: true })
  await expect(async () => {
    await row.hover()
    await expect(button).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15000 })
  await button.click()
}

/** Paths of the diff cards rendered in the view's main area (the state letter's title is its name, not a path). */
export async function diffCardPaths(window: Page): Promise<string[]> {
  return window.locator('section[data-file-key] > header > span[title]:not(:has(> [aria-hidden]))').evaluateAll((spans) =>
    spans.map((span) => span.getAttribute('title') ?? ''),
  )
}

/** The diff card of one file. */
export function diffCard(window: Page, title: string): Locator {
  return window.locator('section[data-file-key]').filter({ has: window.locator(`header span[title="${title}"]`) })
}

/**
 * Double-click a word inside an element, as a person selects one. CodeMirror
 * keeps its own selection, so it has to come from the pointer, not the DOM API.
 */
export async function doubleClickWord(window: Page, container: Locator, word: string): Promise<void> {
  await container.scrollIntoViewIfNeeded()
  const point = await container.evaluate((element, target) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(target) ?? -1
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + target.length)
      const rect = range.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    return null
  }, word)
  if (!point) throw new Error(`"${word}" is not in the element`)
  await window.mouse.dblclick(point.x, point.y)
}

/** The floating bar the reference layer shows under a selection. */
export function selectionBar(window: Page): Locator {
  return window.getByRole('toolbar', { name: 'Selection actions' })
}

export type ReferenceKind = 'comments' | 'selections'

/**
 * The composer's pill for a kind of reference ("2 comments", "1 selection").
 * A sent message carries read-only pills of its own, so those are left out.
 */
export function composerPill(window: Page, kind: ReferenceKind): Locator {
  return window
    .locator('button[aria-haspopup="dialog"]:not([data-message-id] *)')
    .filter({ hasText: kind === 'comments' ? /^\d+ comments?$/ : /^\d+ selections?$/ })
}

/** The popover a pill opens, listing its references one row each. */
export function referencePopover(window: Page, kind: ReferenceKind): Locator {
  return window.getByRole('dialog', { name: kind === 'comments' ? 'Comments' : 'Selections' })
}

/** The inline comment card under the commented lines of a code or diff editor. */
export function commentCard(window: Page, name: string | RegExp): Locator {
  return window.getByRole('group', { name })
}

/**
 * Comment on a word of an editor line: select it, pick "Comment" on the
 * selection bar, and save the card that opens under the line.
 */
export async function commentOnWord(window: Page, line: Locator, word: string, note: string): Promise<void> {
  await doubleClickWord(window, line, word)
  await selectionBar(window).getByRole('button', { name: 'Comment' }).click()
  const box = window.getByRole('textbox', { name: 'Comment' })
  await expect(box).toBeFocused()
  await box.fill(note)
  await box.press('Enter')
  await expect(box).toHaveCount(0)
}
