import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import {
  test, expect, managementAcceptance, conversationRow, openManagedConversation, seedManagedSpace, type ManagedConversation,
} from '../fixtures/acceptance-management'
import { resizeFileWindow } from '../fixtures/acceptance-file-navigation'
import { navigateToChat } from '../fixtures/helpers'

test.setTimeout(240000)
test.use({ seedPersonChat: true })

const HOME = 'halo-temp'
const PREFS_KEY = 'halo-conversation-list-prefs'

type Halo = { halo: HaloAPI }

/** A conversation link as a reply writes it. */
const link = (label: string, id: string) => `[${label}](conv:${id})`

/** The conversation list; its resize edge sits directly inside it. */
const sidebar = (page: Page) => page.getByTitle('Drag to resize width', { exact: true }).locator('..')

/** The row or dot the list marks as the conversation on screen. */
const current = (page: Page) => sidebar(page).locator('[aria-current="true"]')

/** Scroll offset of the virtual list holding `row`. */
const scrollOffset = (row: Locator) => row.evaluate(element => element.closest('[data-virtuoso-scroller]')?.scrollTop ?? -1)

async function listWidth(page: Page): Promise<number> {
  const box = await sidebar(page).boundingBox()
  if (!box) throw new Error('The conversation list is not on screen')
  return Math.round(box.width)
}

/** The list's own saved fold choices for the home workspace. */
async function savedFolds(page: Page) {
  const stored = await page.evaluate(key => localStorage.getItem(key), PREFS_KEY)
  const state = stored ? JSON.parse(stored).state : {}
  return { sections: state.sectionOpen?.[HOME] ?? {}, groups: state.appGroupOpen?.[HOME] ?? {} }
}

/** A row of the list is drawn, in view and marked as the open conversation. */
async function expectRowShown(page: Page, title: string) {
  const row = conversationRow(page, title)
  await expect(row).toHaveAttribute('aria-current', 'true')
  await expect(row).toBeInViewport({ ratio: 0.9 })
  await expect(current(page)).toHaveCount(1)
  return row
}

async function expectOpened(page: Page, conversation: ManagedConversation) {
  await expect(page.getByRole('banner').getByText(conversation.title, { exact: true })).toBeVisible()
  await expect(page.locator(`[data-message-id="${conversation.messages.at(-1)!.id}"]`).first()).toBeVisible()
}

/** Follows a link written in the last reply on screen. */
async function follow(page: Page, label: string) {
  await page.locator('.message-assistant').last().getByText(label, { exact: true }).click()
}

/** Lets a frame or two pass, so a scroll the list should not make would have happened. */
async function settle(page: Page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForTimeout(250)
}

/** Evidence screenshot, taken once the rows' and messages' entrance animations have finished. */
async function snapshot(page: Page, path: string) {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
    .map(animation => animation.finished.catch(() => undefined))))
  await page.screenshot({ path })
}

/** Drags the list's edge to `width` from its left side, the way a person does. */
async function dragListTo(page: Page, width: number) {
  const edge = await page.getByTitle('Drag to resize width', { exact: true }).boundingBox()
  const list = await sidebar(page).boundingBox()
  if (!edge || !list) throw new Error('The conversation list edge is not on screen')
  const y = edge.y + edge.height / 2
  await page.mouse.move(edge.x + edge.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(list.x + width, y, { steps: 12 })
  await page.mouse.up()
}

/** Empty conversations, created up front so their replies can link to one another. */
function createConversations(page: Page, spaceId: string, count: number): Promise<string[]> {
  return page.evaluate(async ({ spaceId, count }) => {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const created = await (window as unknown as Halo).halo.createConversation(spaceId)
      if (!created.success || !created.data) throw new Error(`Could not create a conversation precondition: ${created.error}`)
      ids.push((created.data as { id: string }).id)
    }
    return ids
  }, { spaceId, count })
}

interface Fill { id: string; title: string; reply: string; pin?: boolean }

/**
 * Writes each conversation's exchange and title in the order given. Every write
 * makes a conversation the most recent, so the last one written lists first.
 */
function writeConversations(page: Page, spaceId: string, fills: Fill[]): Promise<ManagedConversation[]> {
  return page.evaluate(async ({ spaceId, fills }) => {
    const api = (window as unknown as Halo).halo
    const written: ManagedConversation[] = []
    for (const fill of fills) {
      for (const message of [{ role: 'user', content: `Question in ${fill.title}` }, { role: 'assistant', content: fill.reply }]) {
        const added = await api.addMessage(spaceId, fill.id, message)
        if (!added.success) throw new Error(`Could not persist a conversation precondition: ${added.error}`)
      }
      const named = await api.updateConversation(spaceId, fill.id, { title: fill.title })
      if (!named.success) throw new Error(`Could not name a conversation precondition: ${named.error}`)
      if (fill.pin) {
        const pinned = await api.toggleStarConversation(spaceId, fill.id, true)
        if (!pinned.success) throw new Error(`Could not pin a conversation precondition: ${pinned.error}`)
      }
      const saved = await api.getConversation(spaceId, fill.id)
      if (!saved.success || !saved.data) throw new Error('A conversation precondition could not be read back')
      written.push(saved.data as ManagedConversation)
    }
    return written
  }, { spaceId, fills })
}

const numbered = (name: string, i: number, token: string) => `${name} ${String(i + 1).padStart(2, '0')} ${token}`

test('after a conversation link opens a conversation, the list shows it highlighted wherever it sits', managementAcceptance('references.conversation.sidebar'), async ({ managementApp, window }, info) => {
  const recorder = managementApp.personChat
  if (!recorder) throw new Error('The digital-human chat precondition was not seeded')
  const token = randomUUID().slice(0, 8)
  const observations: Array<Record<string, unknown>> = []

  const other = await seedManagedSpace(window, `Linked elsewhere ${token}`)
  const elsewhereIds = await createConversations(window, other.id, 30)
  // Oldest first: the hub is written last, so it lists first.
  const [hubId, ...archiveIds] = await createConversations(window, HOME, 41)
  const pinIds = await createConversations(window, HOME, 8)
  const back = link('Back to the hub', hubId)

  const elsewhere = await writeConversations(window, other.id, elsewhereIds.map((id, i) => ({
    id, title: numbered('Elsewhere', i, token), reply: i === 0 ? `The oldest one over there. ${back}` : `Filler ${i + 1}.`,
  })))
  const archive = await writeConversations(window, HOME, archiveIds.map((id, i) => ({
    id,
    title: numbered('Archive', i, token),
    reply: i === 0 ? `${link('Two rows up', archiveIds[2])} · ${back}` : i === 2 ? `Two rows above the oldest. ${back}` : `Filler ${i + 1}.`,
  })))
  // Pinned in order, so the first is the oldest pin and sits last in its section.
  const pinned = await writeConversations(window, HOME, pinIds.map((id, i) => ({
    id, title: numbered('Pinned', i, token), reply: i === 0 ? `The first pin. ${back}` : `Pinned filler ${i + 1}.`, pin: true,
  })))
  const [oldest, , neighbour] = archive
  const [hub] = await writeConversations(window, HOME, [{
    id: hubId,
    title: `Link hub ${token}`,
    reply: [
      link('The oldest archive', oldest.id),
      link('The first pin', pinned[0].id),
      link('Over in the other workspace', elsewhere[0].id),
      link('Ask the recorder', recorder.conversationId),
    ].join('\n\n'),
  }])

  await window.reload({ waitUntil: 'domcontentloaded' })
  try {
    await resizeFileWindow(managementApp.app, window, 1280, 800)
    await navigateToChat(window)
    await openManagedConversation(window, hub.title)

    // The user folds the pinned section; that choice is theirs to keep.
    const pinnedHeader = sidebar(window).getByRole('button', { name: 'Pinned', exact: true })
    await pinnedHeader.click()
    await expect(pinnedHeader).toHaveAttribute('aria-expanded', 'false')
    expect((await savedFolds(window)).sections.pinned).toBe(false)

    // Far down the list: the list moves to it.
    await follow(window, 'The oldest archive')
    await expectOpened(window, oldest)
    const oldestRow = await expectRowShown(window, oldest.title)
    const reached = await scrollOffset(oldestRow)
    expect(reached, 'Reaching the oldest conversation must scroll the list').toBeGreaterThan(0)
    observations.push({ step: 'oldest', scrollTop: reached })
    await snapshot(window, info.outputPath('sidebar-desktop.png'))

    // Already in view: the list stays where it is.
    await follow(window, 'Two rows up')
    await expectOpened(window, neighbour)
    const neighbourRow = await expectRowShown(window, neighbour.title)
    await settle(window)
    expect(await scrollOffset(neighbourRow), 'A conversation already in view must not move the list').toBe(reached)
    observations.push({ step: 'neighbour', scrollTop: await scrollOffset(neighbourRow) })

    await follow(window, 'Back to the hub')
    await expectOpened(window, hub)
    await expectRowShown(window, hub.title)

    // Among the pinned, in a section the user folded: opened for now, their choice kept.
    await follow(window, 'The first pin')
    await expectOpened(window, pinned[0])
    await expect(pinnedHeader).toHaveAttribute('aria-expanded', 'true')
    const pinRow = await expectRowShown(window, pinned[0].title)
    expect(await scrollOffset(pinRow), 'The first pin sits below the pinned section\'s visible rows').toBeGreaterThan(0)
    expect((await savedFolds(window)).sections.pinned).toBe(false)
    observations.push({ step: 'pinned', scrollTop: await scrollOffset(pinRow) })
    await snapshot(window, info.outputPath('sidebar-pinned.png'))

    await follow(window, 'Back to the hub')
    await expectOpened(window, hub)

    // In another workspace: shown there after the switch.
    await follow(window, 'Over in the other workspace')
    await expect(window.getByTitle(/^Current workspace: .* — click to switch$/)).toHaveAttribute('title', `Current workspace: ${other.name} — click to switch`)
    await expectOpened(window, elsewhere[0])
    const elsewhereRow = await expectRowShown(window, elsewhere[0].title)
    expect(await scrollOffset(elsewhereRow), 'The oldest conversation over there sits below the first screen').toBeGreaterThan(0)
    observations.push({ step: 'elsewhere', scrollTop: await scrollOffset(elsewhereRow) })

    await follow(window, 'Back to the hub')
    await expect(window.getByTitle(/^Current workspace: .* — click to switch$/)).toHaveAttribute('title', 'Current workspace: Halo Workspace — click to switch')
    await expectOpened(window, hub)
    await expectRowShown(window, hub.title)

    // A digital human's chat in its folded section and group: opened for now, saved folds untouched.
    const foldsBefore = await savedFolds(window)
    await follow(window, 'Ask the recorder')
    await expect(window.getByText(recorder.turns.at(-1)!.reply, { exact: true }).first()).toBeVisible()
    const humansHeader = window.getByTitle('Conversations with digital humans available in this workspace', { exact: true })
    await expect(humansHeader).toHaveAttribute('aria-expanded', 'true')
    await expect(current(window)).toHaveCount(1)
    await expect(current(window)).toBeInViewport({ ratio: 0.9 })
    expect(await savedFolds(window)).toEqual(foldsBefore)
    expect(foldsBefore.sections['digital-humans']).toBeUndefined()
    expect(foldsBefore.groups[recorder.appId]).toBeUndefined()

    await openManagedConversation(window, hub.title)

    // Folded to its dots: the dot comes into view and the list stays folded.
    await dragListTo(window, 40)
    await expect.poll(() => listWidth(window), { message: 'The conversation list should be folded to its icon strip' }).toBeLessThan(100)
    await follow(window, 'The oldest archive')
    await expectOpened(window, oldest)
    const dot = current(window)
    await expect(dot).toHaveCount(1)
    await expect(dot).toBeInViewport({ ratio: 0.9 })
    const dotOffset = await dot.evaluate(element => element.parentElement?.scrollTop ?? -1)
    expect(dotOffset, 'Reaching the oldest dot must scroll the strip').toBeGreaterThan(0)
    expect(await listWidth(window)).toBeLessThan(100)
    observations.push({ step: 'strip', scrollTop: dotOffset })
    await snapshot(window, info.outputPath('sidebar-strip.png'))

    // Phone width has no sidebar; the conversation is still on screen.
    await resizeFileWindow(managementApp.app, window, 390, 800)
    await expect(sidebar(window)).toHaveCount(0)
    await expect(window.locator(`[data-message-id="${oldest.messages.at(-1)!.id}"]`).first()).toBeVisible()
    await snapshot(window, info.outputPath('sidebar-390.png'))
  } finally {
    await info.attach('conversation-link-sidebar', { body: JSON.stringify({ hub: hubId, oldest: oldest.id, pin: pinned[0].id, elsewhere: elsewhere[0].id, recorder: recorder.conversationId, observations }, null, 2), contentType: 'application/json' })
  }
})
