import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  test, expect, managementAcceptance, openManagedConversation, seedManagedConversation, seedManagedSpace,
} from '../fixtures/acceptance-management'
import { resizeFileWindow } from '../fixtures/acceptance-file-navigation'
import { navigateToApps, navigateToChat } from '../fixtures/helpers'
import { clickArtifactByName } from '../../perf/lib/open-artifact'

test.setTimeout(150000)

const FILE = 'list-layout-notes.txt'

function seedFile(profile: string) {
  const directory = join(profile, '.halo', 'temp', 'artifacts')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, FILE), Array.from({ length: 40 }, (_, index) => `Layout note ${index + 1}`).join('\n') + '\n')
}

/** The conversation list's resize edge; its parent is the list itself. */
const listEdge = (page: Page) => page.getByTitle('Drag to resize width', { exact: true })

/** The list's drawn width: its icon strip is about 56px, the open list at least 140px. */
async function listWidth(page: Page): Promise<number> {
  const box = await listEdge(page).locator('..').boundingBox()
  if (!box) throw new Error('The conversation list is not on screen')
  return Math.round(box.width)
}

async function expectFolded(page: Page) {
  await expect.poll(() => listWidth(page), { message: 'The conversation list should be folded to its icon strip' }).toBeLessThan(100)
}

async function expectOpenAt(page: Page, width: number) {
  await expect.poll(async () => Math.abs(await listWidth(page) - width), { message: `The conversation list should be open at ${width}px` }).toBeLessThanOrEqual(2)
}

/** Drags the list's edge to `width` from the list's left side, the way a person does. */
async function dragListTo(page: Page, width: number) {
  const edge = await listEdge(page).boundingBox()
  const list = await listEdge(page).locator('..').boundingBox()
  if (!edge || !list) throw new Error('The conversation list edge is not on screen')
  const y = edge.y + edge.height / 2
  await page.mouse.move(edge.x + edge.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(list.x + width, y, { steps: 12 })
  await page.mouse.up()
}

async function openFile(page: Page) {
  await clickArtifactByName(page, FILE)
  await expect(page.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(FILE)
}

/** Switches workspace from the header selector, as a person does. */
async function switchWorkspace(page: Page, name: string) {
  const selector = page.getByTitle(/^Current workspace: .* — click to switch$/)
  await selector.click()
  await selector.locator('..').locator('[role="button"]').filter({ has: page.getByText(name, { exact: true }) }).click()
  await expect(selector).toHaveAttribute('title', `Current workspace: ${name} — click to switch`)
}

async function visitDigitalHumansAndReturn(page: Page) {
  await navigateToApps(page)
  await expect(listEdge(page)).toHaveCount(0)
  await navigateToChat(page)
}

test('a list dragged open beside files stays open through navigation, fullscreen, workspace switches and restart', managementAcceptance('conversations.list-layout.beside-files'), async ({ managementApp, window }, info) => {
  const observations: Array<{ phase: string; width: number }> = []
  const observe = async (page: Page, phase: string) => { observations.push({ phase, width: await listWidth(page) }) }
  seedFile(managementApp.profile)
  const home = await seedManagedConversation(window, 'halo-temp', 'List layout discussion', [
    { role: 'user', content: 'Keep this discussion beside the notes.' },
    { role: 'assistant', content: 'The notes stay open beside this discussion.' },
  ])
  const other = await seedManagedSpace(window, 'List layout elsewhere')
  await seedManagedConversation(window, other.id, 'Elsewhere discussion', [
    { role: 'user', content: 'A discussion in the other workspace.' },
    { role: 'assistant', content: 'It has no files open.' },
  ])
  await window.reload({ waitUntil: 'domcontentloaded' })
  try {
    await resizeFileWindow(managementApp.app, window, 1280, 800)
    await openManagedConversation(window, home.title)
    expect(await listWidth(window)).toBeGreaterThanOrEqual(140)
    await observe(window, 'without-files')

    await openFile(window)
    await expectFolded(window)
    await observe(window, 'file-opened')
    await dragListTo(window, 280)
    await expectOpenAt(window, 280)

    await visitDigitalHumansAndReturn(window)
    await expect(window.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(FILE)
    await expectOpenAt(window, 280)
    await observe(window, 'returned-from-digital-humans')

    await window.getByTitle('Enter fullscreen', { exact: true }).click()
    await expect(listEdge(window)).toHaveCount(0)
    await window.getByRole('button', { name: 'Exit fullscreen and return to chat', exact: true }).click()
    await expectOpenAt(window, 280)
    await observe(window, 'left-fullscreen')

    await switchWorkspace(window, other.name)
    await expect(window.locator('.canvas-tab')).toHaveCount(0)
    await expectOpenAt(window, 280)
    await switchWorkspace(window, 'Halo Workspace')
    await expect(window.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(FILE)
    await expectOpenAt(window, 280)
    await observe(window, 'returned-from-other-workspace')

    await window.getByRole('button', { name: 'Collapse canvas', exact: true }).click()
    await expectOpenAt(window, 280)
    await window.getByRole('button', { name: 'Expand canvas', exact: true }).click()
    await expect(window.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(FILE)
    await expectOpenAt(window, 280)
    await observe(window, 'canvas-expanded')

    const reopened = await managementApp.restart()
    await resizeFileWindow(managementApp.app, reopened, 1280, 800)
    await openManagedConversation(reopened, home.title)
    await openFile(reopened)
    await expectOpenAt(reopened, 280)
    await observe(reopened, 'file-opened-after-restart')

    await dragListTo(reopened, 40)
    await expectFolded(reopened)
    await visitDigitalHumansAndReturn(reopened)
    await expect(reopened.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(FILE)
    await expectFolded(reopened)
    await observe(reopened, 'folded-beside-file')
    await reopened.getByRole('button', { name: 'Collapse canvas', exact: true }).click()
    await expectOpenAt(reopened, 280)
    await observe(reopened, 'canvas-collapsed')
  } finally {
    await info.attach('conversation-list-widths', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' })
  }
})

test('a list folded with the canvas closed stays folded through navigation and restart, and still folds beside a file', managementAcceptance('conversations.list-layout.without-files'), async ({ managementApp, window }, info) => {
  const observations: Array<{ phase: string; width: number }> = []
  const observe = async (page: Page, phase: string) => { observations.push({ phase, width: await listWidth(page) }) }
  seedFile(managementApp.profile)
  const home = await seedManagedConversation(window, 'halo-temp', 'Folded list discussion', [
    { role: 'user', content: 'Keep the list out of the way.' },
    { role: 'assistant', content: 'The list stays folded.' },
  ])
  await window.reload({ waitUntil: 'domcontentloaded' })
  try {
    await resizeFileWindow(managementApp.app, window, 1280, 800)
    await openManagedConversation(window, home.title)
    expect(await listWidth(window)).toBeGreaterThanOrEqual(140)
    await observe(window, 'without-files')

    await dragListTo(window, 40)
    await expectFolded(window)
    await visitDigitalHumansAndReturn(window)
    await expectFolded(window)
    await observe(window, 'returned-from-digital-humans')

    const reopened = await managementApp.restart()
    await resizeFileWindow(managementApp.app, reopened, 1280, 800)
    await navigateToChat(reopened)
    await expectFolded(reopened)
    await observe(reopened, 'after-restart')

    await dragListTo(reopened, 300)
    await expectOpenAt(reopened, 300)
    await openFile(reopened)
    await expectFolded(reopened)
    await observe(reopened, 'file-opened')
    await reopened.getByRole('button', { name: 'Collapse canvas', exact: true }).click()
    await expectOpenAt(reopened, 300)
    await observe(reopened, 'canvas-collapsed')
  } finally {
    await info.attach('conversation-list-widths', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' })
  }
})
