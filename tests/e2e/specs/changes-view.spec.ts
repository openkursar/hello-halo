/**
 * The canvas changes view against a real repository (fixtures/git-workspace.ts):
 * how it opens, what it lists, the compare scopes, stage / unstage / commit,
 * discarding with a confirmation, the folder detail page, and a reply's edits
 * opened from "View changes". Test actions use git or stored data, never a model.
 */

import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '../fixtures/electron-with-git-workspace'
import { BASELINE, EXPECTED_STATUS } from '../fixtures/git-workspace'
import {
  chooseScope,
  clickRowAction,
  diffCard,
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
  let pageErrors: string[]
  test.beforeEach(async ({ window }) => {
    pageErrors = []
    window.on('pageerror', (error) => {
      pageErrors.push(error.message)
      console.error('[Changes E2E]', error)
    })
    window.on('console', (message) => {
      if (message.type() === 'error') console.error('[Changes E2E]', message.text())
    })
  })
  test.afterEach(() => {
    expect(pageErrors).toEqual([])
  })

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

  test('keeps small diff editors mounted while scrolling', async ({ window }) => {
    await openChangesWithShortcut(window)
    await expect(window.locator('section[data-file-key]')).toHaveCount(8)
    await expect(window.locator('[data-diff-scroll] .cm-editor').first()).toBeVisible()
    await expect(window.locator('[data-diff-scroll] [aria-busy="true"]')).toHaveCount(0)
    await window.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-diff-scroll]')!
      const state = window as unknown as { diffEditors: Element[] }
      state.diffEditors = Array.from(scroller.querySelectorAll('.cm-editor'))
      scroller.scrollTop = scroller.scrollHeight
    })
    await window.locator('[data-diff-scroll]').hover()
    await window.mouse.wheel(0, -1000)
    expect(await window.evaluate(() => (window as unknown as { diffEditors: Element[] }).diffEditors.every((editor) => editor.isConnected))).toBe(true)
    await expect(window.locator('[data-diff-scroll] .diff-skeleton')).toHaveCount(0)
    await expect(window.getByText('Large diff · Showing one file at a time')).toHaveCount(0)
    await ensureFilePanel(window)
    await filePanel(window).getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(filePanel(window).getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
    expect(await window.evaluate(() => (window as unknown as { diffEditors: Element[] }).diffEditors.every((editor) => editor.isConnected))).toBe(true)
    await fileRow(window, 'src/prompts/system-prompt.ts').getByRole('button').first().click()
    await expect.poll(() => window.locator('[data-file-key="src/prompts/system-prompt.ts"]').evaluate((card) => {
      const scroller = card.closest('[data-diff-scroll]')!
      return Math.abs(card.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
    })).toBeLessThan(2)
    await window.locator('[data-diff-scroll]').hover()
    await window.mouse.wheel(0, 80)
    await expect.poll(() => window.locator('[data-file-key="src/prompts/system-prompt.ts"]').evaluate((card) => {
      const scroller = card.closest('[data-diff-scroll]')!
      return scroller.getBoundingClientRect().top - card.getBoundingClientRect().top
    })).toBeGreaterThan(40)
    const offset = await window.locator('[data-file-key="src/prompts/system-prompt.ts"]').evaluate((card) => card.closest('[data-diff-scroll]')!.getBoundingClientRect().top - card.getBoundingClientRect().top)
    await window.getByRole('tab', { name: /Overview & review/ }).click()
    await window.getByRole('tab', { name: 'Changes', exact: true }).click()
    await expect.poll(() => window.locator('[data-file-key="src/prompts/system-prompt.ts"]').evaluate((card, saved) => Math.abs(card.closest('[data-diff-scroll]')!.getBoundingClientRect().top - card.getBoundingClientRect().top - saved), offset)).toBeLessThan(3)
  })

  test('navigates changed chunks across mounted files without replacing editors', async ({ window }) => {
    await openChangesWithShortcut(window)
    await ensureFilePanel(window)
    // Folders come before files in the tree, so src/app.ts follows src/router/.
    await fileRow(window, 'src/router/provider-adapters.ts').getByRole('button').first().click()
    await expect(window.locator('[data-file-key="src/router/provider-adapters.ts"] .cm-editor').first()).toBeVisible()
    await window.getByRole('button', { name: 'Next change (F7)', exact: true }).click()
    await expect(window.locator('[data-file-key="src/router/provider-adapters.ts"] .cm-changesFocus').first()).toBeInViewport()
    await window.keyboard.press('F7')
    await expect(window.locator('[data-file-key="src/app.ts"] .cm-changesFocus')).toBeInViewport()
    await window.keyboard.press('Shift+F7')
    await expect(window.locator('[data-file-key="src/router/provider-adapters.ts"] .cm-changesFocus').first()).toBeInViewport()
    await expect(window.locator('section[data-file-key]')).toHaveCount(8)
  })

  test('lays the diffs out in the order the file list shows them, Tree or List', async ({ window, workspace }) => {
    await openChangesWithShortcut(window)
    await ensureFilePanel(window)
    // Card paths against the panel's file rows (a file in two groups listed once), both read afresh on every poll.
    const orders = async () => {
      const [cards, groups] = await Promise.all([diffCardPaths(window), panelGroups(window)])
      return { cards, rows: [...new Set(Object.values(groups).flat().map((entry) => entry.slice(2)))] }
    }
    await expect(window.locator('section[data-file-key]')).toHaveCount(8)
    await expect.poll(async () => { const { cards, rows } = await orders(); return cards.length === 8 && cards.join('\n') === rows.join('\n') }).toBe(true)
    await filePanel(window).getByRole('radio', { name: 'List', exact: true }).click()
    await expect.poll(async () => { const { cards, rows } = await orders(); return rows.length === 8 && cards.join('\n') === rows.join('\n') }).toBe(true)

    // One file at a time: Next file walks names naturally, as the list does (item-2 before item-10).
    const folder = path.join(workspace.repoRoot, 'src', 'bulk')
    fs.mkdirSync(folder, { recursive: true })
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(folder, `item-${i}.ts`), `export const item${i} = ${i}\n`)
    await filePanel(window).getByRole('button', { name: 'Refresh', exact: true }).click()
    await filePanel(window).getByLabel('Filter files (e.g. src/**)').fill('src/bulk/**')
    await expect(window.getByText('Large diff · Showing one file at a time')).toBeVisible()
    await fileRow(window, 'src/bulk/item-1.ts').getByRole('button').first().click()
    await expect.poll(() => diffCardPaths(window)).toEqual(['src/bulk/item-1.ts'])
    await window.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect.poll(() => diffCardPaths(window)).toEqual(['src/bulk/item-2.ts'])
    await expect(window.getByText('3 of 12', { exact: true })).toBeVisible()
  })

  test('decides all files or one again for another compare scope', async ({ window, workspace }) => {
    // Small in the index, huge in the working tree: only the uncommitted scope is over the text budget.
    workspace.git('add', 'src/router/provider-adapters.ts')
    fs.appendFileSync(path.join(workspace.repoRoot, 'src', 'router', 'provider-adapters.ts'), `// ${'context '.repeat(40000)}\n`)
    await openChangesWithShortcut(window)
    await expect(window.getByText('Large diff · Showing one file at a time')).toBeVisible()
    // Leave the huge file, so the next scope does not read it again on its own.
    await expect.poll(() => diffCardPaths(window)).toEqual(['src/router/provider-adapters.ts'])
    await window.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect.poll(() => diffCardPaths(window)).toEqual(['src/router/reasoning-effort.ts'])
    await chooseScope(window, 'Staged changes')
    const staged = [...EXPECTED_STATUS.staged.map((file) => file.title), 'src/router/provider-adapters.ts']
    await expect.poll(() => diffCardPaths(window).then(sorted)).toEqual(sorted(staged))
    await expect(window.getByText('Large diff · Showing one file at a time')).toHaveCount(0)
    await chooseScope(window, 'Uncommitted changes')
    await expect(window.getByText('Large diff · Showing one file at a time')).toBeVisible()
  })

  test('shows the file whose Load diff tipped the text budget', async ({ window, workspace }) => {
    // Only the untracked note and a lockfile with one huge line are left.
    workspace.git('reset', '-q', '--hard')
    fs.appendFileSync(path.join(workspace.repoRoot, 'package-lock.json'), `${'lockfile '.repeat(35000)}\n`)
    await openChangesWithShortcut(window)
    await ensureFilePanel(window)
    await filePanel(window).getByRole('button', { name: 'Hide generated', exact: true }).click()
    await expect.poll(() => diffCardPaths(window)).toEqual(['notes/todo.md', 'package-lock.json'])
    await diffCard(window, 'package-lock.json').getByRole('button', { name: 'Load diff', exact: true }).click()
    await expect(window.getByText('Large diff · Showing one file at a time')).toBeVisible()
    await expect.poll(() => diffCardPaths(window)).toEqual(['package-lock.json'])
    await expect(diffCard(window, 'package-lock.json').locator('.cm-editor').first()).toBeVisible()
  })

  test('keeps deep file names readable and clickable at the narrowest file list', async ({ window, workspace }) => {
    // Every folder holds a file and a subfolder, so no folder chain is compacted.
    const levels = Array.from({ length: 10 }, (_, level) => `level${level}`)
    for (let depth = 1; depth <= levels.length; depth++) {
      const folder = path.join(workspace.repoRoot, 'deep', ...levels.slice(0, depth))
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(path.join(folder, `file${depth - 1}.ts`), `export const depth = ${depth}\n`)
    }
    const deepest = `deep/${levels.join('/')}/file9.ts`
    await openChangesWithShortcut(window)
    await ensureFilePanel(window)
    const panel = filePanel(window)
    await panel.getByRole('separator').focus()
    await window.keyboard.press('Home')
    await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(220)
    const button = panel.locator(`button[title="${deepest}"]`)
    await expect(button).toBeVisible()
    const widths = await button.evaluate((element) => ({
      button: element.getBoundingClientRect().width,
      name: element.lastElementChild!.getBoundingClientRect().width,
      text: element.lastElementChild!.textContent,
    }))
    expect(widths.text).toBe('file9.ts')
    expect(widths.button).toBeGreaterThanOrEqual(60)
    expect(widths.name).toBeGreaterThanOrEqual(40)
    await button.click()
    await expect.poll(() => diffCardPaths(window)).toEqual([deepest])
  })

  test('browses large changes one file at a time and restores the selection', async ({ window, workspace }) => {
    const folder = path.join(workspace.repoRoot, 'src', 'bulk')
    fs.mkdirSync(folder, { recursive: true })
    for (let i = 0; i < 24; i++) fs.writeFileSync(path.join(folder, `item-${String(i).padStart(2, '0')}.ts`), `export const item${i} = ${i}\n`)
    await openChangesWithShortcut(window)
    await expect(window.getByText('Large diff · Showing one file at a time')).toBeVisible()
    await expect(window.locator('section[data-file-key]')).toHaveCount(1)
    await expect(window.getByRole('button', { name: 'Previous file', exact: true })).toBeDisabled()
    await window.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(window.locator('section[data-file-key]')).toHaveCount(1)
    await ensureFilePanel(window)
    await filePanel(window).getByLabel('Filter files (e.g. src/**)').fill('src/bulk/**')
    await expect(window.locator('section[data-file-key]')).toHaveCount(1)
    await fileRow(window, 'src/bulk/item-04.ts').getByRole('button').first().click()
    await expect.poll(() => diffCardPaths(window)).toEqual(['src/bulk/item-04.ts'])
    await window.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect.poll(() => diffCardPaths(window)).toEqual(['src/bulk/item-05.ts'])
    await window.getByRole('tab', { name: /Overview & review/ }).click()
    await window.getByRole('tab', { name: 'Changes', exact: true }).click()
    await expect.poll(() => diffCardPaths(window)).toEqual(['src/bulk/item-05.ts'])
    await expect(window.locator('section[data-file-key]')).toHaveCount(1)
  })

  test('hands focus to a different large-diff file selected from the narrow drawer', async ({ window, workspace }) => {
    const folder = path.join(workspace.repoRoot, 'src', 'bulk')
    fs.mkdirSync(folder, { recursive: true })
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(folder, `item-${i}.ts`), `export const item${i} = ${i}\n`)
    await openChangesWithShortcut(window)
    await expect(window.getByText('Large diff · Showing one file at a time')).toBeVisible()
    await window.setViewportSize({ width: 390, height: 844 })
    await window.getByRole('button', { name: 'File list', exact: true }).click()
    const drawer = window.getByRole('dialog', { name: 'File list', exact: true })
    await expect(drawer).toBeVisible()
    await drawer.locator('button[title="notes/todo.md"]').click()
    await expect(drawer).toHaveCount(0)
    await expect.poll(() => diffCardPaths(window)).toEqual(['notes/todo.md'])
    await expect(window.getByText('Large diff · Showing one file at a time')).toBeVisible()
    await expect(diffCard(window, 'notes/todo.md').getByRole('button', { name: 'Collapse file', exact: true })).toBeFocused()
    await expect(diffCard(window, 'notes/todo.md').locator('.cm-editor')).toHaveCount(1)
  })

  test('keeps a large file at the reading position when its list is filtered or refreshed', async ({ window, workspace }) => {
    const folder = path.join(workspace.repoRoot, 'src', 'bulk')
    fs.mkdirSync(folder, { recursive: true })
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(folder, `item-${i}.ts`), `export const item${i} = ${i}\n`)
    await openChangesWithShortcut(window)
    await ensureFilePanel(window)
    const filter = filePanel(window).getByLabel('Filter files (e.g. src/**)')
    await filter.fill('src/prompts/**')
    await fileRow(window, 'src/prompts/system-prompt.ts').getByRole('button').first().click()
    await filter.fill('src/**')
    await expect(window.getByText('Large diff · Showing one file at a time')).toBeVisible()
    await expect.poll(() => diffCardPaths(window)).toEqual(['src/prompts/system-prompt.ts'])
    const scroller = window.locator('[data-diff-scroll]')
    await expect(scroller.locator('.cm-editor').first()).toBeVisible()
    await scroller.hover()
    await window.mouse.wheel(0, 160)
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
    const offset = await scroller.evaluate((element) => element.scrollTop)
    await window.evaluate(() => { (window as unknown as { keptEditors: Element[] }).keptEditors = Array.from(document.querySelectorAll('[data-diff-scroll] .cm-editor')) })
    await filter.fill('src/')
    await expect(window.getByText('Large diff · Showing one file at a time')).toBeVisible()
    await expect.poll(() => scroller.evaluate((element, saved) => Math.abs(element.scrollTop - saved), offset)).toBeLessThan(3)
    await filePanel(window).getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(filePanel(window).getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
    await expect.poll(() => scroller.evaluate((element, saved) => Math.abs(element.scrollTop - saved), offset)).toBeLessThan(3)
    expect(await window.evaluate(() => (window as unknown as { keptEditors: Element[] }).keptEditors.every((editor) => editor.isConnected))).toBe(true)
  })

  test('budgets unchanged context and long lines without prefetching the repository', async ({ window, workspace }) => {
    const file = path.join(workspace.repoRoot, 'src', 'router', 'provider-adapters.ts')
    fs.appendFileSync(file, `// ${'context '.repeat(40000)}\n`)
    await openChangesWithShortcut(window)
    await expect(window.getByText('Large diff · Showing one file at a time')).toBeVisible()
    await expect(window.locator('section[data-file-key]')).toHaveCount(1)
    await ensureFilePanel(window)
    await fileRow(window, 'src/router/provider-adapters.ts').getByRole('button').first().click()
    await expect.poll(() => diffCardPaths(window)).toEqual(['src/router/provider-adapters.ts'])
    await expect(window.locator('[data-diff-scroll] .cm-editor').first()).toBeVisible()
    await expect(window.locator('section[data-file-key]')).toHaveCount(1)
    await filePanel(window).getByLabel('Filter files (e.g. src/**)').fill('src/prompts/**')
    await expect(window.getByText('Large diff · Showing one file at a time')).toHaveCount(0)
    await expect(window.locator('section[data-file-key]')).toHaveCount(1)
  })

  test('nests sibling folders under one parent and collapses descendants together', async ({ window }) => {
    await openChangesWithShortcut(window)
    await ensureFilePanel(window)
    const panel = filePanel(window)
    const src = panel.locator('button[title="src"][aria-expanded]')
    await expect(src).toHaveCount(1)
    await expect(panel.locator('button[title="src/prompts"]')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'router', exact: true })).toBeVisible()
    const depths = await panel.evaluate((aside) => ['src', 'src/router', 'src/router/provider-adapters.ts'].map((title) => {
      const button = Array.from(aside.querySelectorAll<HTMLElement>(`button[title="${title}"]`)).at(-1)!
      return Number.parseFloat(getComputedStyle(title.endsWith('.ts') ? button.parentElement! : button).paddingLeft)
    }))
    expect(depths[1]).toBeGreaterThan(depths[0])
    expect(depths[2]).toBeGreaterThan(depths[1])
    await src.click()
    await expect(fileRow(window, 'src/app.ts')).toHaveCount(0)
    await expect(panel.locator('button[title="src/prompts"]')).toHaveCount(0)
    await src.click()
    await expect(fileRow(window, 'src/app.ts')).toBeVisible()
    await src.click()
    await panel.getByLabel('Filter files (e.g. src/**)').fill('src/router/provider-adapters.ts')
    await expect(src).toHaveAttribute('aria-expanded', 'false')
    await src.focus()
    await window.keyboard.press('Enter')
    const compact = panel.locator('button[title="src/router"][aria-expanded]')
    await expect(compact).toBeFocused()
    await expect(fileRow(window, 'src/router/provider-adapters.ts')).toBeVisible()
    await window.keyboard.press('Enter')
    await expect(compact).toBeFocused()
    await expect(fileRow(window, 'src/router/provider-adapters.ts')).toHaveCount(0)
  })

  test('resizes the file list without rebuilding editors until release', async ({ window }) => {
    await openChangesWithShortcut(window)
    await ensureFilePanel(window)
    const panel = filePanel(window)
    const separator = panel.getByRole('separator')
    await expect(separator).toBeVisible()
    const before = (await panel.boundingBox())!.width
    await window.evaluate(() => { (window as unknown as { editors: Element[] }).editors = Array.from(document.querySelectorAll('[data-diff-scroll] .cm-editor')) })
    const box = (await separator.boundingBox())!
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await window.mouse.down()
    await window.mouse.move(box.x - 80, box.y + box.height / 2, { steps: 12 })
    expect((await panel.boundingBox())!.width).toBeGreaterThan(before + 50)
    expect(await window.evaluate(() => (window as unknown as { editors: Element[] }).editors.every((editor) => editor.isConnected))).toBe(true)
    await window.mouse.up()
    const resized = (await panel.boundingBox())!.width
    await separator.focus()
    await window.keyboard.press('ArrowRight')
    expect((await panel.boundingBox())!.width).toBeLessThan(resized)
    await window.getByRole('tab', { name: /Overview & review/ }).click()
    await window.getByRole('tab', { name: 'Changes', exact: true }).click()
    expect((await panel.boundingBox())!.width).toBeLessThan(resized)
    const stored = () => window.evaluate(() => JSON.parse(localStorage.getItem('halo-changes-view-prefs')!).state.panelWidth as number | undefined)
    const saved = await stored()
    const start = (await separator.boundingBox())!
    await window.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
    await window.mouse.down()
    await window.mouse.move(start.x - 40, start.y + start.height / 2)
    expect(await stored()).toBe(saved)
    await window.keyboard.press('Escape')
    await window.mouse.up()
    expect((await panel.boundingBox())!.width).toBeCloseTo(saved!, 0)
    expect(await stored()).toBe(saved)
    await separator.dblclick()
    expect(await stored()).toBeUndefined()
    expect((await panel.boundingBox())!.width).toBeCloseTo(before, 0)
    await separator.focus()
    await window.keyboard.press('End')
    const preferred = await stored()
    await window.setViewportSize({ width: 1350, height: 1000 })
    await expect(separator).toBeVisible()
    await expect.poll(() => panel.evaluate((element) => {
      const parent = element.parentElement!
      return parent.getBoundingClientRect().width - element.getBoundingClientRect().width
    })).toBeGreaterThanOrEqual(479)
    expect(await stored()).toBe(preferred)
    await window.setViewportSize({ width: 1600, height: 1000 })
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeCloseTo(preferred!, 0)
  })

  test('keeps split and inline diffs readable in both themes and opens the narrow file drawer', async ({ window }, testInfo) => {
    await window.setViewportSize({ width: 1920, height: 1080 })
    await openChangesWithShortcut(window)
    await ensureFilePanel(window)
    await fileRow(window, 'src/prompts/system-prompt.ts').getByRole('button').first().click()
    const scroller = window.locator('[data-diff-scroll]')
    const card = diffCard(window, 'src/prompts/system-prompt.ts')
    const split = window.getByRole('button', { name: 'Side by side', exact: true })
    await expect(split).toHaveAttribute('aria-pressed', 'true')
    for (const layout of ['split', 'inline']) {
      if (layout === 'inline') await split.click()
      await expect(card.locator('.cm-editor')).toHaveCount(layout === 'split' ? 2 : 1)
      await expect(card.locator(layout === 'split' ? '.cm-merge-a .cm-changedText' : '.cm-deletedChunk').first()).toBeVisible()
      for (const theme of ['light', 'dark']) {
        await window.evaluate((mode) => document.documentElement.classList.toggle('light', mode === 'light'), theme)
        await scroller.screenshot({ path: testInfo.outputPath(`diff-${layout}-${theme}.png`) })
        expect(await scroller.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
        // Check the browser's cascade, including syntax spans and stacked line/word tints.
        const contrast = await card.evaluate((element) => {
          const rgba = (value: string) => {
            const [r, g, b, a = 1] = value.match(/[\d.]+/g)!.map(Number)
            return [r / 255, g / 255, b / 255, a]
          }
          const blend = (fg: number[], bg: number[]) => fg.slice(0, 3).map((channel, i) => channel * fg[3] + bg[i] * (1 - fg[3]))
          const luminance = (rgb: number[]) => rgb.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
            .reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0)
          const ratios: number[] = []
          for (const span of element.querySelectorAll<HTMLElement>('.cm-line span, .cm-deletedChunk span')) {
            if (!span.textContent?.trim() || span.getBoundingClientRect().height === 0) continue
            const backgrounds: number[][] = []
            for (let node: HTMLElement | null = span; node; node = node.parentElement) {
              backgrounds.push(rgba(getComputedStyle(node).backgroundColor))
              if (node.classList.contains('cm-editor')) break
            }
            const background = backgrounds.reverse().reduce((bg, fg) => blend(fg, bg), [1, 1, 1])
            const foreground = blend(rgba(getComputedStyle(span).color), background)
            const [darker, lighter] = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
            ratios.push((lighter + 0.05) / (darker + 0.05))
          }
          return { count: ratios.length, minimum: Math.min(...ratios) }
        })
        expect(contrast.count).toBeGreaterThan(20)
        expect(contrast.minimum).toBeGreaterThanOrEqual(4.5)
        expect(await card.locator('.cm-changedText, .cm-deletedText').evaluateAll((spans) => spans.every((span) => {
          const style = getComputedStyle(span)
          return style.backgroundImage === 'none' && style.textDecorationLine === 'none'
        }))).toBe(true)
      }
    }
    await fileRow(window, 'src/router/provider-adapters.ts').getByRole('button').first().click()
    const collapsed = diffCard(window, 'src/router/provider-adapters.ts').locator('.cm-collapsedLines').first()
    await expect(collapsed).toBeVisible()
    expect(await collapsed.evaluate((element) => getComputedStyle(element).backgroundImage)).toBe('none')
    await collapsed.click()
    await expect(diffCard(window, 'src/router/provider-adapters.ts').locator('.cm-line', { hasText: 'provider-adapters.ts' }).first()).toBeVisible()
    await window.setViewportSize({ width: 390, height: 844 })
    await window.getByRole('button', { name: 'File list', exact: true }).click()
    const drawer = window.getByRole('dialog').filter({ has: window.getByLabel('Filter files (e.g. src/**)') })
    await expect(drawer).toBeVisible()
    await drawer.getByLabel('Filter files (e.g. src/**)').fill('src/app.ts')
    await drawer.locator('button[title="src/app.ts"]').click()
    await expect(drawer).toHaveCount(0)
    await expect.poll(() => diffCardPaths(window)).toEqual(['src/app.ts'])
    await expect(diffCard(window, 'src/app.ts').locator('.cm-editor')).toHaveCount(1)
    await expect(diffCard(window, 'src/app.ts').locator('.cm-deletedChunk').first()).toBeVisible()
    await window.screenshot({ path: testInfo.outputPath('diff-mobile.png') })
    expect(await scroller.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return element.scrollWidth <= element.clientWidth + 1 && rect.left >= 0 && rect.right <= innerWidth + 1
    })).toBe(true)
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

  test.describe('many reply edits', () => {
    test.use({ replyEditCount: 25 })

    test('pages fragments, navigates across them and restores the page after switching tabs', async ({ window }) => {
      await window.getByRole('button', { name: /View changes/ }).click()
      await expect(window.getByText('Large diff · Showing one file at a time')).toBeVisible()
      // The file list puts notes/ before src/, and so do the diffs.
      await expect.poll(() => diffCardPaths(window)).toEqual(['notes/todo.md'])
      await window.getByRole('button', { name: 'Next file', exact: true }).click()
      await expect(window.getByText('Edits 1–12 of 25', { exact: true })).toBeVisible()
      await expect(window.locator('[data-diff-scroll] .cm-editor')).toHaveCount(24)
      await window.getByRole('button', { name: 'Next edits', exact: true }).click()
      await expect(window.getByText('Edits 13–24 of 25', { exact: true })).toBeVisible()
      await window.getByRole('button', { name: 'Next edits', exact: true }).click()
      await expect(window.getByText('Edits 25–25 of 25', { exact: true })).toBeVisible()
      await expect(window.locator('[data-diff-scroll] .cm-editor')).toHaveCount(2)
      await window.getByRole('button', { name: 'Next change (F7)', exact: true }).click()
      await expect(window.locator('[data-diff-scroll] .cm-changesFocus').first()).toBeInViewport()
      await window.keyboard.press('Shift+F7')
      await expect(window.getByText('Edits 13–24 of 25', { exact: true })).toBeVisible()
      await expect(window.locator('[data-diff-scroll] .cm-changesFocus').first()).toBeInViewport()
      await window.keyboard.press('F7')
      await expect(window.getByText('Edits 25–25 of 25', { exact: true })).toBeVisible()
      await expect(window.locator('[data-diff-scroll] .cm-changesFocus').first()).toBeInViewport()
      // Before the first edit, Shift+F7 goes back into the previous file; F7 comes in again on the first page.
      await window.getByRole('button', { name: 'Previous edits', exact: true }).click()
      await window.getByRole('button', { name: 'Previous edits', exact: true }).click()
      await expect(window.getByText('Edits 1–12 of 25', { exact: true })).toBeVisible()
      await window.keyboard.press('Shift+F7')
      await expect.poll(() => diffCardPaths(window)).toEqual(['notes/todo.md'])
      await window.keyboard.press('F7')
      await expect(window.getByText('Edits 1–12 of 25', { exact: true })).toBeVisible()
      await expect(window.locator('[data-diff-scroll] .cm-changesFocus').first()).toBeInViewport()
      await window.getByRole('button', { name: 'Next edits', exact: true }).click()
      await expect(window.getByText('Edits 13–24 of 25', { exact: true })).toBeVisible()
      const replyTab = window.locator('.canvas-tab-title').filter({ hasText: /^Changes ·/ }).first()
      const title = await replyTab.getAttribute('title')
      await window.getByRole('button', { name: 'Previous file', exact: true }).click()
      await window.getByRole('button', { name: 'Next file', exact: true }).click()
      await expect(window.getByText('Edits 13–24 of 25', { exact: true })).toBeVisible()
      const scroller = window.locator('[data-diff-scroll]')
      await scroller.hover()
      await window.mouse.wheel(0, 100)
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(50)
      const offset = await scroller.evaluate((element) => element.scrollTop)
      await diffCard(window, 'src/app.ts').getByRole('button', { name: 'Open in editor' }).click()
      await window.locator('.canvas-tab-title').filter({ hasText: title! }).click()
      await expect(window.getByText('Edits 13–24 of 25', { exact: true })).toBeVisible()
      await expect.poll(() => scroller.evaluate((element, saved) => Math.abs(element.scrollTop - saved), offset)).toBeLessThan(3)
      await window.setViewportSize({ width: 390, height: 844 })
      await window.getByRole('button', { name: 'File list', exact: true }).click()
      const drawer = window.getByRole('dialog', { name: 'File list', exact: true })
      await expect(drawer).toBeVisible()
      await drawer.locator('button[title="notes/todo.md"]').click()
      await expect(drawer).toHaveCount(0)
      await expect.poll(() => diffCardPaths(window)).toEqual(['notes/todo.md'])
      await expect(diffCard(window, 'notes/todo.md').getByRole('button', { name: 'Collapse file', exact: true })).toBeFocused()
      await window.getByRole('button', { name: 'File list', exact: true }).click()
      await expect(drawer).toBeVisible()
      await drawer.locator('button[title="src/app.ts"]').click()
      await expect(drawer).toHaveCount(0)
      await expect(diffCard(window, 'src/app.ts').getByRole('button', { name: 'Collapse file', exact: true })).toBeFocused()
      await expect(window.getByText('Edits 13–24 of 25', { exact: true })).toBeVisible()
      await expect(window.getByText('Large diff · Showing one file at a time')).toBeVisible()
    })
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
