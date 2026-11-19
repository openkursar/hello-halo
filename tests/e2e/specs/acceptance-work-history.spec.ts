/**
 * A reply's work, read the way a person reads it: the answer first, what the
 * AI said along the way one click away, the operations between on request,
 * each operation's existing result one more click away, and the task plan in
 * view whatever the operations switch says. The real application runs; only
 * the model endpoint is scripted.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { Thought } from '../../../src/shared/types/transcript'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { openManagedConversation, seedManagedConversation, seedManagedSpace } from '../fixtures/acceptance-management'
import { createModelGate, modelTool, type ModelReply, type ModelRequest } from '../fixtures/acceptance-model'
import { seedDigitalHumanChat, type SeededDigitalHumanChat } from '../fixtures/seed-digital-human-chat'
import { navigateToChat, openDigitalHumanConversation, setTheme } from '../fixtures/helpers'

test.setTimeout(120000)

const FIRST_WORDS = 'I will check the edges first.'
const SECOND_WORDS = 'The edges pass. Now the hand-off records.'
const ANSWER = 'Found a gap in the hand-off: step 4 is never read back.'
const PLAN = ['Check the edges', 'Read the hand-off records', 'Report the gap']

function plan(done: number) {
  return PLAN.map((content, index) => ({
    content,
    activeForm: `Working on: ${content}`,
    status: index < done ? 'completed' : index === done ? 'in_progress' : 'pending',
  }))
}

function done(request: ModelRequest, id: string): boolean {
  return request.toolResults.some(result => result.id === id)
}

/** The plan tool may be offered directly or only after a tool search; reach it either way. */
function writePlan(request: ModelRequest, id: string, todos: unknown): ModelReply {
  if (request.tools.some(tool => tool === 'TodoWrite' || tool.endsWith('__TodoWrite'))) return { tools: [modelTool(request, 'TodoWrite', { todos }, id)] }
  return { tools: [modelTool(request, 'ToolSearch', { query: 'select:TodoWrite', max_results: 1 }, `${id}-search`)] }
}

async function topOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Expected the element to be laid out')
  return box.y
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
}

for (const viewport of ['1280', '390'] as const) {
  test(`a finished reply reads answer first, then words, then operations (${viewport}px)`,
    acceptance('chat.work-history.finished', { viewport }), async ({ window, model }, info) => {
      const space = await seedManagedSpace(window, `Work history ${viewport}`)
      const records = Array.from({ length: 6 }, (_, index) => join(space.path, 'handoff', `step-${index + 1}.md`))
      const marker = randomUUID().slice(0, 8)
      mkdirSync(join(space.path, 'handoff'), { recursive: true })
      records.forEach((file, index) => writeFileSync(file, `Hand-off step ${index + 1} record ${marker}\n`))
      const conversation = await seedManagedConversation(window, space.id, 'Hand-off review', [])

      model.respond(request => {
        if (!request.tools.length) return { text: 'Hand-off review' }
        if (!done(request, 'wh-command')) {
          return { text: FIRST_WORDS, tools: [modelTool(request, 'Bash', { command: `printf 'edges-ok-${marker}'`, description: 'Check the edges' }, 'wh-command')] }
        }
        if (!done(request, 'wh-plan')) return writePlan(request, 'wh-plan', plan(1))
        if (!done(request, 'wh-read-1')) {
          return { text: SECOND_WORDS, tools: records.map((file, index) => modelTool(request, 'Read', { file_path: file }, `wh-read-${index + 1}`)) }
        }
        if (!done(request, 'wh-plan-done')) return writePlan(request, 'wh-plan-done', plan(3))
        return { text: ANSWER }
      })

      await openManagedConversation(window, conversation.title, space.id, { empty: true })
      const turn = await sendAcceptanceMessage(window, 'Review the hand-off records and tell me what is missing.')
      await waitForAcceptanceIdle(window, turn.conversationId, { timeout: 60000 })
      await window.setViewportSize({ width: Number(viewport), height: 844 })

      // Answer first: the work is one folded line above it.
      const reply = window.locator('[data-transcript-index]').filter({ hasText: ANSWER }).last()
      await expect(reply.locator('.message-assistant')).toContainText(ANSWER)
      const header = reply.getByRole('button', { name: /^Work process/ })
      await expect(header).toHaveAttribute('aria-expanded', 'false')
      await expect(reply.getByText(FIRST_WORDS, { exact: true })).toHaveCount(0)
      await expect(reply.getByText('Task plan', { exact: true })).toHaveCount(0)

      // One click: what was said, in order, with the work between as one line each; the plan follows.
      await header.click()
      const first = reply.getByText(FIRST_WORDS, { exact: true })
      const second = reply.getByText(SECOND_WORDS, { exact: true })
      await expect(first).toBeVisible()
      await expect(second).toBeVisible()
      await expect(reply.getByText(ANSWER, { exact: true })).toHaveCount(1)
      await expect(reply.getByRole('button', { name: /operation details/ })).toHaveCount(0)
      await expect(reply.getByText('Task plan', { exact: true })).toBeVisible()
      await expect(reply.getByText(PLAN[2], { exact: true })).toBeVisible()
      await expect(reply.getByRole('button', { name: /^TodoWrite/ })).toHaveCount(0)
      // A stretch with one operation is that operation's own line.
      const commandLine = reply.getByRole('button', { name: /^Command · printf/ })
      const reads = reply.getByRole('button', { name: 'Read 6 files', exact: true })
      await expect(commandLine).toBeVisible()
      await expect(reads).toBeVisible()
      expect(await topOf(first)).toBeLessThan(await topOf(commandLine))
      expect(await topOf(commandLine)).toBeLessThan(await topOf(second))
      expect(await topOf(second)).toBeLessThan(await topOf(reads))
      // Six reads are one line: none is drawn until it is opened.
      await expect(reply.getByRole('button', { name: /^Read · handoff/ })).toHaveCount(0)
      await info.attach(`timeline-${viewport}`, { body: await window.screenshot(), contentType: 'image/png' })

      // One click on an operation shows Halo's existing result for it; the line keeps its shape.
      const command = commandLine
      const closedBox = await command.boundingBox()
      await command.click()
      await expect(reply.getByText(`edges-ok-${marker}`).first()).toBeVisible()
      const openBox = await command.boundingBox()
      expect(Math.round(openBox!.height)).toBe(Math.round(closedBox!.height))
      await reads.click()
      await expect(reply.getByRole('group', { name: 'Read 6 files', exact: true })).toHaveCount(0)
      const readRows = reply.getByRole('button', { name: /^Read · handoff\/step-\d\.md$/ })
      await expect(readRows).toHaveCount(6)
      await readRows.nth(3).click()
      await expect(reply.getByText(`Hand-off step 4 record ${marker}`).first()).toBeVisible()
      await noSidewaysScroll(window)
      await info.attach(`operations-${viewport}`, { body: await window.screenshot(), contentType: 'image/png' })

      // Closing the stretch keeps the words and the plan.
      await reads.click()
      await expect(readRows).toHaveCount(0)
      await expect(second).toBeVisible()
      await expect(reply.getByText('Task plan', { exact: true })).toBeVisible()
    })
}

for (const viewport of ['1280', '390'] as const) {
  test(`long tool groups scroll in place without taking over the reply (${viewport}px)`, {
    annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'chat.work-history.long-tool-group', evidence: 'ui', mode: 'none', variant: { viewport } }) },
  }, async ({ window }, info) => {
    const answer = 'The records are ready to review.'
    const space = await seedManagedSpace(window, `Long tool group ${viewport}`)
    const conversation = await seedManagedConversation(window, space.id, 'Long tool group', [
      { role: 'assistant', content: Array.from({ length: 35 }, (_, index) => `Earlier hand-off note ${index + 1}.`).join('\n\n') },
      { role: 'user', content: 'Review the hand-off records.' }, { role: 'assistant', content: answer },
    ])
    const thoughts: Thought[] = Array.from({ length: 60 }, (_, index) => {
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      return {
        id: `read-${index + 1}`, type: 'tool_use', content: '', toolName: 'Read',
        toolInput: { file_path: `record-${index + 1}.md` }, timestamp,
        toolResult: { output: `Evidence for record ${index + 1}`, isError: false, timestamp },
      }
    })
    const saved = await window.evaluate(({ spaceId, id, thoughts }) => (globalThis as unknown as { halo: HaloAPI }).halo
      .updateLastMessage(spaceId, id, { thoughts }), { spaceId: space.id, id: conversation.id, thoughts })
    expect(saved.success).toBe(true)
    expect(saved.data).toBeTruthy()
    await openManagedConversation(window, conversation.title, space.id)
    await window.setViewportSize({ width: Number(viewport), height: 844 })

    const reply = window.locator('[data-transcript-index]').filter({ hasText: answer }).last()
    await reply.getByRole('button', { name: /^Work process/ }).click()
    const heading = reply.getByRole('button', { name: 'Read 60 files', exact: true })
    await heading.click()
    const list = reply.getByRole('group', { name: 'Read 60 files', exact: true })
    await expect(list.getByRole('button', { name: /^Read · record-/ })).toHaveCount(50)
    await expect.poll(() => list.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1)
    const size = await list.evaluate(el => ({ height: el.clientHeight, total: el.scrollHeight, viewport: innerHeight }))
    expect(size.height).toBeLessThanOrEqual(size.viewport / 2)
    expect(size.total).toBeGreaterThan(size.height)
    await noSidewaysScroll(window)
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(window, theme)
      await list.scrollIntoViewIfNeeded()
      await info.attach(`long-tool-group-${viewport}-${theme}`, { body: await window.screenshot(), contentType: 'image/png' })
    }

    await list.getByRole('button', { name: 'Read · record-60.md', exact: true }).click()
    await expect(list.getByText('Evidence for record 60', { exact: true })).toBeVisible()
    await list.evaluate(el => { el.scrollTop = 0 })
    await list.getByRole('button', { name: 'Show 10 earlier steps', exact: true }).click()
    await expect(list.getByRole('button', { name: /^Read · record-/ })).toHaveCount(60)
    await expect(list.getByRole('button', { name: 'Read · record-60.md', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await list.evaluate(el => { el.scrollTop = 0 })
    const chat = window.getByTestId('transcript-scroller')
    await list.hover()
    const before = await chat.evaluate(el => el.scrollTop)
    expect(before).toBeGreaterThan(0)
    await window.mouse.wheel(0, -220)
    await expect.poll(() => chat.evaluate(el => el.scrollTop)).toBeLessThan(before)
    await heading.click()
    await expect(list).toHaveCount(0)
    await expect(reply.locator('.message-assistant')).toContainText(answer)
  })
}

test('a running reply keeps its latest words in view and shows them once when opened',
  acceptance('chat.work-history.running'), async ({ window, model }, info) => {
    const LATEST = 'Now verifying the hand-off timing.'
    const gate = createModelGate()
    const space = await seedManagedSpace(window, 'Work history live')
    const conversation = await seedManagedConversation(window, space.id, 'Live hand-off review', [])
    model.respond(request => {
      if (!request.tools.length) return { text: 'Live hand-off review' }
      if (!done(request, 'live-command')) {
        return { text: FIRST_WORDS, tools: [modelTool(request, 'Bash', { command: "printf 'edges-ok'", description: 'Check the edges' }, 'live-command')] }
      }
      if (!done(request, 'live-plan')) return writePlan(request, 'live-plan', plan(1))
      return { text: LATEST, hold: gate.promise }
    })

    await openManagedConversation(window, conversation.title, space.id, { empty: true })
    const turn = await sendAcceptanceMessage(window, 'Check the hand-off timing.')

    // Folded: what it is doing, the plan's progress, and the latest words.
    const header = window.getByRole('button', { name: /Working on: Read the hand-off records/ })
    await expect(header).toBeVisible({ timeout: 30000 })
    await expect(header).toContainText('Tasks 1/3')
    await expect(window.getByText(LATEST, { exact: true })).toHaveCount(1)
    await expect(window.getByText(FIRST_WORDS, { exact: true })).toHaveCount(0)

    // Opened: what was said and done, in order; the latest words stay in the reply's own bubble, once; the plan in view.
    await header.click()
    await expect(window.getByText(FIRST_WORDS, { exact: true })).toBeVisible()
    await expect(window.getByText(LATEST, { exact: true })).toHaveCount(1)
    await expect(window.locator('.message-working')).toContainText(LATEST)
    expect(await topOf(window.getByText(FIRST_WORDS, { exact: true }))).toBeLessThan(await topOf(window.getByText(LATEST, { exact: true })))
    await expect(window.getByText('Task plan', { exact: true })).toBeVisible()
    await expect(header).not.toContainText('Tasks 1/3')
    await info.attach('running-open', { body: await window.screenshot(), contentType: 'image/png' })

    // Folded again: the latest words stay in view.
    await header.click()
    await expect(window.getByText(LATEST, { exact: true })).toBeVisible()
    await expect(window.getByText(FIRST_WORDS, { exact: true })).toHaveCount(0)

    // Left open when the reply finishes, the work stays open as the saved reply.
    await header.click()
    await expect(window.getByText(FIRST_WORDS, { exact: true })).toBeVisible()
    gate.release()
    await waitForAcceptanceIdle(window, turn.conversationId, { timeout: 60000 })
    const reply = window.locator('[data-transcript-index]').filter({ hasText: LATEST }).last()
    await expect(reply.locator('.message-assistant')).toContainText(LATEST)
    await expect(reply.getByRole('button', { name: /^Work process/ })).toHaveAttribute('aria-expanded', 'true')
    await expect(reply.getByText(FIRST_WORDS, { exact: true })).toBeVisible()
  })

test('a digital human stopped mid-sentence keeps the words it had shown after the app restarts',
  acceptance('chat.work-history.person-stopped'), async ({ acceptanceApp, model }, info) => {
    const SHOWN = 'Half of the rollout plan is'
    const gate = createModelGate()
    let seeded!: SeededDigitalHumanChat
    let page = await acceptanceApp.restart(profile => { seeded = seedDigitalHumanChat(profile, { name: 'Rollout planner', turnCount: 1 }) })
    const openChat = async () => {
      await navigateToChat(page)
      await openDigitalHumanConversation(page, seeded.name, seeded.turns[0].reply.slice(0, 20))
      await expect(page.locator('.message-user').first()).toContainText(seeded.turns[0].user)
    }
    model.respond(() => ({ text: SHOWN, hold: gate.promise }))
    await openChat()
    const turn = await sendAcceptanceMessage(page, 'Draft the rollout plan.')
    expect(turn.conversationId).toBe(seeded.conversationId)
    await expect(page.getByText(SHOWN, { exact: true })).toBeVisible({ timeout: 30000 })
    await page.getByTitle('Stop generation (Esc)', { exact: true }).click()
    const interruption = { type: 'error', errorType: 'interrupted', error: 'Stopped by user.', conversationId: turn.conversationId, spaceId: turn.spaceId }
    await waitForAcceptanceIdle(page, turn.conversationId, { timeout: 60000, expectedErrors: [interruption] })
    gate.release()

    page = await acceptanceApp.restart()
    await openChat()
    const reply = page.locator('[data-transcript-index]').filter({ hasText: SHOWN }).last()
    await expect(reply.locator('.message-assistant')).toContainText(SHOWN)
    await expect(reply.getByText('Stopped.', { exact: true })).toBeVisible()
    await expect(page.locator('.message-assistant').filter({ hasText: seeded.turns[0].reply })).toHaveCount(1)
    await info.attach('person-stopped-after-restart', { body: await page.screenshot(), contentType: 'image/png' })
  })

test('a stopped reply still reads as progress, not an answer, after the app restarts',
  acceptance('chat.work-history.stopped'), async ({ acceptanceApp, window, model }, info) => {
    const LATEST = 'Now verifying the hand-off timing.'
    const gate = createModelGate()
    const space = await seedManagedSpace(window, 'Work history stopped')
    const conversation = await seedManagedConversation(window, space.id, 'Stopped hand-off review', [])
    model.respond(request => {
      if (!request.tools.length) return { text: 'Stopped hand-off review' }
      if (!done(request, 'stop-command')) {
        return { text: FIRST_WORDS, tools: [modelTool(request, 'Bash', { command: "printf 'edges-ok'", description: 'Check the edges' }, 'stop-command')] }
      }
      if (!done(request, 'stop-plan')) return writePlan(request, 'stop-plan', plan(1))
      return { text: LATEST, hold: gate.promise }
    })

    await openManagedConversation(window, conversation.title, space.id, { empty: true })
    const turn = await sendAcceptanceMessage(window, 'Check the hand-off timing, then stop when I say.')
    await expect(window.getByText(LATEST, { exact: true })).toBeVisible({ timeout: 30000 })
    // The person is reading the command's result when they stop the reply.
    await window.getByRole('button', { name: /Working on: Read the hand-off records/ }).click()
    await window.getByRole('button', { name: /^Command · printf/ }).click()
    await expect(window.getByText('edges-ok', { exact: true })).toBeVisible()
    await window.getByTitle('Stop generation (Esc)', { exact: true }).click()
    const interruption = {
      type: 'error', errorType: 'interrupted', error: 'Stopped by user.',
      conversationId: turn.conversationId, spaceId: turn.spaceId,
    }
    await waitForAcceptanceIdle(window, turn.conversationId, { timeout: 60000, expectedErrors: [interruption] })
    gate.release()

    // Right after the stop, the chat's own notice (with Continue) speaks for the reply.
    await expect(window.getByText('Stopped by user.', { exact: true })).toBeVisible()
    const reply = () => window.locator('[data-transcript-index]').filter({ hasText: LATEST }).last()
    await expect(reply().getByText('Stopped.', { exact: true })).toHaveCount(0)
    // What they were reading stays open in the saved reply, read from its record.
    await expect(reply().getByRole('button', { name: /^Work process/ })).toHaveAttribute('aria-expanded', 'true')
    await expect(reply().getByRole('button', { name: /^Command · printf/ })).toHaveAttribute('aria-expanded', 'true')
    await expect(reply().getByText('edges-ok', { exact: true })).toBeVisible()

    // After a restart that notice is gone; the reply itself still says how it ended.
    const page = await acceptanceApp.restart()
    await openManagedConversation(page, conversation.title, space.id)
    const saved = page.locator('[data-transcript-index]').filter({ hasText: LATEST }).last()
    await expect(saved.locator('.message-assistant')).toContainText(LATEST)
    await expect(saved.getByText('Stopped.', { exact: true })).toBeVisible()
    await expect(saved.getByText('Above is the progress so far.', { exact: true })).toBeVisible()
    await expect(page.getByText('Stopped by user.', { exact: true })).toHaveCount(0)

    // Its work keeps the earlier words and the same command result, and the plan shows the step it was on as not finished.
    await saved.getByRole('button', { name: /^Work process/ }).click()
    await expect(saved.getByText(FIRST_WORDS, { exact: true })).toBeVisible()
    await saved.getByRole('button', { name: /^Command · printf/ }).click()
    await expect(saved.getByText('edges-ok', { exact: true })).toBeVisible()
    await expect(saved.getByText(LATEST, { exact: true })).toHaveCount(1)
    await expect(saved.getByText('Task plan', { exact: true })).toBeVisible()
    await info.attach('stopped-after-restart', { body: await page.screenshot(), contentType: 'image/png' })
  })
