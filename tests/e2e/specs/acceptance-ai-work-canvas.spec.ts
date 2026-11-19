import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, terminalAcceptance, openOwnedTerminal, terminals, terminalTab, type TerminalSessionApp } from '../fixtures/acceptance-terminal-sessions'
import { seedManagedSpace, openWorkspaceMenu, type ManagedSpace } from '../fixtures/acceptance-management'
import { navigateToWorkspaces } from '../fixtures/helpers'
import { openFromHeaderMenu } from '../../perf/lib/open-artifact'
import { createModelGate } from '../fixtures/acceptance-model'
import {
  scriptedTurn, createdSession, expandHandle, collapseButton, closeCanvasButton, statusLine, aiTabs,
  operatingDot, tabTitled, expectHandleCount, setWindowSize, endAllTerminals,
} from '../fixtures/acceptance-ai-work'

test.setTimeout(240000)

async function workspace(app: TerminalSessionApp, name: string) {
  const directory = join(app.profile, `${name} working files`)
  mkdirSync(directory)
  return seedManagedSpace(app.window, name, directory)
}

async function enterWorkspace(page: Page, space: ManagedSpace) {
  await navigateToWorkspaces(page)
  await page.getByRole('heading', { name: space.name, level: 3, exact: true }).click()
  await expect(page.getByTitle(`Current workspace: ${space.name} — click to switch`, { exact: true })).toBeVisible()
}

async function switchWorkspace(page: Page, space: ManagedSpace) {
  const selector = page.getByTitle(/^Current workspace: .* — click to switch$/)
  await selector.click()
  const choice = selector.locator('..').locator('[role="button"]').filter({ has: page.getByText(space.name, { exact: true }) })
  await expect(choice).toHaveCount(1)
  await choice.click()
  await expect(selector).toHaveAttribute('title', `Current workspace: ${space.name} — click to switch`)
}

async function sessionTitle(page: Page, id: string): Promise<string> {
  const info = (await terminals(page)).find(session => session.id === id)
  if (!info) throw new Error(`No terminal ${id}`)
  return info.title
}

async function sessionState(page: Page, id: string) {
  return (await terminals(page)).find(session => session.id === id)?.state ?? 'gone'
}

/** Opens one of the user's own terminals from the header menu; returns its session id. */
async function openOwnTerminal(page: Page): Promise<string> {
  const before = new Set((await terminals(page)).map(session => session.id))
  await openFromHeaderMenu(page, 'Open terminal')
  await expect.poll(async () => (await terminals(page)).filter(session => !before.has(session.id)).length).toBe(1)
  return (await terminals(page)).find(session => !before.has(session.id))!.id
}

async function aiCreatesTerminals(page: Page, model: Parameters<typeof scriptedTurn>[1], titles: string[]) {
  const created = await scriptedTurn(page, model, `Open ${titles.length} terminal(s) for the work.`, titles.map(title => ({ name: 'terminal_create', input: { title } })))
  return created.results.map(createdSession)
}

test('the AI opening terminals adds tabs quietly, with only the goal above the composer', terminalAcceptance('files.ai-work.quiet-add'), async ({ terminalApp, model, window }, info) => {
  const space = await workspace(terminalApp, 'Quiet AI work')
  await enterWorkspace(window, space)
  const own = await openOwnedTerminal(terminalApp, 'own', space.id)
  const ownTitle = await sessionTitle(window, own.info.id)
  await collapseButton(window).click()
  await expectHandleCount(window, 1)

  await window.getByRole('button', { name: 'Add files, context and capabilities', exact: true }).click()
  await window.getByRole('menuitem', { name: /^Set a goal\b/ }).click()
  await expect(window.getByRole('button', { name: 'Exit goal mode', exact: true })).toBeVisible()
  const [first] = await aiCreatesTerminals(window, model, ['AI build'])

  await expect(window.getByRole('region', { name: 'Goal', exact: true })).toBeVisible()
  await expect(window.getByText(/sessions? running/)).toHaveCount(0)
  await expect(window.locator('.canvas-tab')).toHaveCount(0)
  await expectHandleCount(window, 2)
  await info.attach('quiet-add-collapsed', { body: await window.screenshot(), contentType: 'image/png' })

  await expandHandle(window).click()
  await expect(window.locator('.canvas-tab')).toHaveCount(2)
  await expect(terminalTab(window, ownTitle)).toHaveClass(/\bactive\b/)
  const firstTitle = await sessionTitle(window, first)
  await expect(window.locator('.canvas-tab').last()).toContainText(firstTitle)
  await expect(aiTabs(window)).toHaveCount(1)
  await expect(terminalTab(window, ownTitle).locator('.canvas-tab-ai-dot')).toHaveCount(0)

  const [second] = await aiCreatesTerminals(window, model, ['AI tests'])
  await expect(window.locator('.canvas-tab')).toHaveCount(3)
  await expect(terminalTab(window, ownTitle)).toHaveClass(/\bactive\b/)
  await expect(window.locator('.canvas-tab').last()).toContainText(await sessionTitle(window, second))
  await expect(aiTabs(window)).toHaveCount(2)
  await expect(window.getByText(/sessions? running/)).toHaveCount(0)
  await info.attach('quiet-add-expanded', { body: await window.screenshot(), contentType: 'image/png' })
  await endAllTerminals(window)
})

test('the marks say the AI is operating during its call and for ten seconds after, then idle', terminalAcceptance('files.ai-work.operating'), async ({ terminalApp, model, window }, info) => {
  const space = await workspace(terminalApp, 'Operating marks')
  await enterWorkspace(window, space)
  let sessionId = ''
  const pending = scriptedTurn(window, model, 'Wait for a line that will not come.', [
    { name: 'terminal_create', input: { title: 'AI watcher' } },
    { name: 'terminal_wait_for', input: results => { sessionId = createdSession(results[0]); return { session: sessionId, text: 'never-printed-marker', timeout: 12 } } },
  ])
  await expectHandleCount(window, 1)
  await expect(operatingDot(window)).toBeVisible()
  await info.attach('operating-handle', { body: await window.screenshot(), contentType: 'image/png' })
  await expandHandle(window).click()
  await aiTabs(window).first().click()
  await expect(statusLine(window)).toContainText('AI is operating')
  await expect(aiTabs(window).first().locator('.canvas-tab-ai-dot')).toHaveAttribute('data-ai-operating', 'true')
  await info.attach('operating-tab', { body: await window.screenshot(), contentType: 'image/png' })

  const done = await pending
  const endedAt = done.resultAt[1]
  expect(Date.now() - endedAt).toBeLessThan(8000)
  await expect(statusLine(window)).toContainText('AI is operating')
  await expect(statusLine(window)).toContainText('AI is idle', { timeout: 20000 })
  const idleAfter = Date.now() - endedAt
  expect(idleAfter, 'Operating holds about ten seconds after the last call').toBeGreaterThanOrEqual(9000)
  expect(idleAfter).toBeLessThan(16000)
  await expect(aiTabs(window).first().locator('.canvas-tab-ai-dot')).toHaveAttribute('data-ai-operating', 'false')
  await collapseButton(window).click()
  await expectHandleCount(window, 1)
  await expect(operatingDot(window)).toHaveCount(0)
  await info.attach('operating-timeline', { body: JSON.stringify({ sessionId, endedAt, idleAfter }, null, 2), contentType: 'application/json' })
  await endAllTerminals(window)
})

test('closing the canvas keeps the AI terminals unasked, and asks once before ending them when only they are left', terminalAcceptance('files.ai-work.close-canvas'), async ({ terminalApp, model, window }, info) => {
  const space = await workspace(terminalApp, 'Close canvas')
  await enterWorkspace(window, space)
  const own = [await openOwnTerminal(window), await openOwnTerminal(window), await openOwnTerminal(window)]
  const ai = await aiCreatesTerminals(window, model, ['AI server', 'AI watcher'])
  await expect(window.locator('.canvas-tab')).toHaveCount(5)

  await window.getByRole('button', { name: 'Close canvas (keeps tabs the AI is using)', exact: true }).click()
  await expect(window.locator('.canvas-tab')).toHaveCount(0)
  await expect(window.getByRole('alertdialog')).toHaveCount(0)
  await expectHandleCount(window, 2)
  for (const id of own) await expect.poll(() => sessionState(window, id)).not.toBe('running')
  for (const id of ai) expect(await sessionState(window, id)).toBe('running')

  await expandHandle(window).click()
  await expect(aiTabs(window)).toHaveCount(2)
  await closeCanvasButton(window).click()
  const question = window.getByRole('alertdialog', { name: 'End the 2 tabs the AI is still using?', exact: true })
  await expect(question).toBeVisible()
  for (const id of ai) await expect(question).toContainText(await sessionTitle(window, id))
  await expect(question.getByRole('button')).toHaveText(['Cancel', 'End all'])
  await expect(question.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await info.attach('end-all-question', { body: await window.screenshot(), contentType: 'image/png' })
  await window.keyboard.press('Enter')
  await expect(question).toHaveCount(0)
  await expect(aiTabs(window)).toHaveCount(2)
  for (const id of ai) expect(await sessionState(window, id)).toBe('running')

  await closeCanvasButton(window).click()
  await question.getByRole('button', { name: 'End all', exact: true }).click()
  await expect(question).toHaveCount(0)
  await expect(expandHandle(window)).toHaveCount(0)
  for (const id of ai) await expect.poll(() => sessionState(window, id)).not.toBe('running')
})

test('no running AI terminal is left without a tab after close others, a space switch, or deleting the space', terminalAcceptance('files.ai-work.no-orphans'), async ({ terminalApp, model, window }) => {
  const first = await workspace(terminalApp, 'Orphan check A')
  const second = await workspace(terminalApp, 'Orphan check B')
  await enterWorkspace(window, first)
  const ownId = await openOwnTerminal(window)
  const ownTitle = await sessionTitle(window, ownId)
  const otherOwnId = await openOwnTerminal(window)
  const ai = await aiCreatesTerminals(window, model, ['AI one', 'AI two'])
  const aiTitles = await Promise.all(ai.map(id => sessionTitle(window, id)))

  const runningAiWithoutTab = async () => {
    const shown = new Set(await window.locator('.canvas-tab-title').allInnerTexts())
    return (await terminals(window)).filter(session => session.spaceId === first.id && session.aiTouched && session.state === 'running' && !shown.has(session.title)).map(session => session.id)
  }

  // The context menu's "Close others" arrives as the tab action the native menu sends.
  await terminalApp.app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('canvas:show-tab-context-menu')
    ipcMain.handle('canvas:show-tab-context-menu', (event, options: { tabId: string }) => {
      BrowserWindow.fromWebContents(event.sender)!.webContents.send('canvas:tab-action', { action: 'closeOthers', tabId: options.tabId })
      return { success: true }
    })
  })
  // Closing the others closes the user's other terminal and keeps the AI's, asking nothing.
  await terminalTab(window, ownTitle).first().click({ button: 'right' })
  await expect(window.locator('.canvas-tab-title')).toHaveText([ownTitle, ...aiTitles])
  await expect(window.getByRole('alertdialog')).toHaveCount(0)
  await expect.poll(() => sessionState(window, otherOwnId)).not.toBe('running')
  expect(await runningAiWithoutTab()).toEqual([])

  await switchWorkspace(window, second)
  await expect(aiTabs(window)).toHaveCount(0)
  await switchWorkspace(window, first)
  if (await expandHandle(window).isVisible()) await expandHandle(window).click()
  await expect(aiTabs(window)).toHaveCount(2)
  expect(await runningAiWithoutTab()).toEqual([])

  await navigateToWorkspaces(window)
  await openWorkspaceMenu(window, first.name, 'Delete')
  await window.getByRole('alertdialog', { name: 'Delete this workspace?', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
  for (const id of [...ai, ownId]) await expect.poll(() => sessionState(window, id), { timeout: 15000 }).not.toBe('running')
})

test('at phone width the same handle brings the AI terminal back', terminalAcceptance('files.ai-work.narrow'), async ({ terminalApp, model, window }, info) => {
  const space = await workspace(terminalApp, 'Narrow handle')
  await enterWorkspace(window, space)
  await setWindowSize(window, 390, 844)
  const [id] = await aiCreatesTerminals(window, model, ['AI on the phone'])
  await expectHandleCount(window, 1)
  await info.attach('narrow-handle', { body: await window.screenshot(), contentType: 'image/png' })
  await expandHandle(window).click()
  await expect(window.locator('.canvas-tab.active')).toContainText(await sessionTitle(window, id))
  await expect(statusLine(window)).toBeVisible()
  await expect(window.locator('.xterm-rows')).toBeVisible()
  await info.attach('narrow-canvas', { body: await window.screenshot(), contentType: 'image/png' })
  await endAllTerminals(window)
})

test('the AI\'s next terminal result says a person typed there, once, without what was typed', terminalAcceptance('files.ai-work.told'), async ({ terminalApp, model, window }) => {
  const space = await workspace(terminalApp, 'Person typed')
  await enterWorkspace(window, space)
  const [id] = await aiCreatesTerminals(window, model, ['AI shell'])
  await expandHandle(window).click()
  await aiTabs(window).first().click()
  const secret = `hunter2-${Date.now()}`
  await expect(window.locator('.xterm-rows')).toBeVisible()
  await window.locator('.xterm-helper-textarea').pressSequentially(secret)
  await window.locator('.xterm-helper-textarea').press('Enter')
  await expect(window.locator('.xterm-rows')).toContainText(secret)

  const NOTE = 'Note: the user typed in this terminal since your last action here. Read it with mode "screen" before you continue.'
  const afterTyping = await scriptedTurn(window, model, 'Look at the terminal again.', [
    { name: 'terminal_read', input: { session: id, mode: 'new' } },
    { name: 'terminal_write', input: { session: id, input: 'echo checked', timeout: 3 } },
  ])
  expect(afterTyping.results[0].split('\n')[0]).toBe(NOTE)
  expect(afterTyping.results[1]).not.toContain(NOTE)
  for (const result of afterTyping.results) {
    const noteLines = result.split('\n').filter(line => line.includes('the user typed'))
    for (const line of noteLines) expect(line).not.toContain(secret)
  }
  const untouched = await scriptedTurn(window, model, 'Run one more command.', [
    { name: 'terminal_write', input: { session: id, input: 'echo again', timeout: 3 } },
  ])
  expect(untouched.results[0]).not.toContain('the user typed')
  await endAllTerminals(window)
})

test('the AI brings a terminal forward once, never while I type, and another conversation only adds a tab', terminalAcceptance('files.ai-work.show-terminal'), async ({ terminalApp, model, window }, info) => {
  const space = await workspace(terminalApp, 'Bring forward')
  writeFileSync(join(space.workingDir!, 'notes.md'), '# Notes for the user\n')
  await enterWorkspace(window, space)

  let sessionId = ''
  const shown = await scriptedTurn(window, model, 'Show me the terminal you work in.', [
    { name: 'terminal_create', input: { title: 'AI shown' } },
    { name: 'canvas_show', input: results => { sessionId = createdSession(results[0]); return { target: 'terminal', session: sessionId } } },
    { name: 'canvas_show', input: () => ({ target: 'terminal', session: sessionId }) },
  ])
  expect(shown.results[1]).toMatch(/^Shown: the user now sees the terminal/)
  expect(shown.results[2]).toMatch(/^Already brought forward earlier in this reply/)
  await expect(window.locator('.canvas-tab.active')).toContainText(await sessionTitle(window, sessionId))
  await expect(statusLine(window)).toBeVisible()
  await info.attach('shown-terminal', { body: await window.screenshot(), contentType: 'image/png' })

  await collapseButton(window).click()
  const typing = createModelGate()
  const reached = createModelGate()
  const draft = 'A sentence I am still writing'
  const whileTyping = scriptedTurn(window, model, 'Show the terminal again.', [
    { name: 'canvas_show', input: { target: 'terminal', session: sessionId }, hold: typing.promise, onCall: reached.release },
  ])
  await reached.promise
  const composer = window.locator('textarea').first()
  await composer.fill(draft)
  await composer.focus()
  typing.release()
  const typed = await whileTyping
  expect(typed.results[0]).toMatch(/^Added, not switched/)
  await expect(window.locator('.canvas-tab')).toHaveCount(0)
  await expectHandleCount(window, 1)
  await expect(composer).toHaveValue(draft)
  await expect(composer).toBeFocused()
  await composer.fill('')

  const switching = createModelGate()
  const sent = createModelGate()
  const elsewhere = scriptedTurn(window, model, 'Put the notes in front of me.', [
    { name: 'canvas_show', input: { target: 'file', path: 'notes.md' }, hold: switching.promise, onCall: sent.release },
  ], { leavesScreen: true })
  await sent.promise
  await window.getByRole('button', { name: 'New', exact: true }).click()
  await expect(window.locator('.message-user')).toHaveCount(0)
  switching.release()
  const result = await elsewhere
  expect(result.results[0]).toMatch(/^Added, not switched/)
  await expect(window.locator('.canvas-tab')).toHaveCount(0)
  await expectHandleCount(window, 2)
  await expandHandle(window).click()
  await expect(tabTitled(window, 'notes.md')).toHaveCount(1)
  await expect(tabTitled(window, 'notes.md').locator('.canvas-tab-ai-dot')).toHaveCount(0)
  await endAllTerminals(window)
})
