import { randomBytes } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { TerminalInfo } from '../../../src/shared/types/terminal'
import type { Thought } from '../../../src/shared/types/transcript'
import { test, expect, terminalAcceptance, openOwnedTerminal, startOwnedTerminalProgram, terminals, replay, terminalEvents, terminalTab, typeTerminalInput, type TerminalSessionApp } from '../fixtures/acceptance-terminal-sessions'
import { sendAcceptanceMessage, waitForAcceptanceIdle, readAcceptanceConversation } from '../fixtures/acceptance-app'
import { seedManagedSpace, type ManagedSpace } from '../fixtures/acceptance-management'
import { navigateToWorkspaces } from '../fixtures/helpers'
import type { AcceptanceModel, ModelRequest, ModelReply } from '../fixtures/acceptance-model'

test.setTimeout(150000)

type OpenedTerminal = Awaited<ReturnType<typeof openOwnedTerminal>>
const marker = (kind: string) => `${kind}_${randomBytes(4).toString('hex')}`

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

function assertProcess(terminal: OpenedTerminal, space: ManagedSpace) {
  const value = terminal.program.receipt()!
  expect(realpathSync(value.cwd)).toBe(realpathSync(space.workingDir!))
  expect(realpathSync(value.execPath)).toBe(realpathSync(process.execPath))
  expect(terminal.program.observation()).toMatchObject({ process: { state: 'running' }, shell: { state: 'running' } })
  return value
}

async function enableTerminal(page: Page) {
  await page.getByRole('button', { name: 'Add files, context and capabilities', exact: true }).click()
  const option = page.getByRole('menuitemcheckbox', { name: /^AI Terminal\b/ })
  await expect(option).toHaveCount(1)
  if (await option.getAttribute('aria-checked') !== 'true') await option.click()
  await expect(option).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
}

function call(request: ModelRequest, name: string, id: string, input: Record<string, unknown>, issues: string[]): ModelReply {
  const names = request.tools.filter(tool => tool === name || tool.endsWith(`__${name}`))
  if (names.length !== 1) { issues.push(`Expected one ${name}, observed ${names.length}`); return { text: 'The terminal capability was unavailable.' } }
  return { tools: [{ name: names[0], id, input }] }
}

async function assertTerminalTools(page: Page, turn: { spaceId: string; conversationId: string }) {
  const conversation = await readAcceptanceConversation(page, turn.spaceId, turn.conversationId)
  const assistant = conversation.messages.findLast(message => message.role === 'assistant')!
  const result = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.getMessageThoughts(input.spaceId, input.conversationId, input.messageId), { ...turn, messageId: assistant.id })
  expect(result.success).toBe(true)
  const tools = (result.data as Thought[]).filter(thought => thought.type === 'tool_use' && /__terminal_(read|write)$/.test(thought.toolName ?? ''))
  expect(tools.length).toBeGreaterThan(0)
  for (const tool of tools) expect(tool.toolResult?.isError).toBe(false)
}

async function touchWithAi(page: Page, model: AcceptanceModel, terminal: OpenedTerminal, control?: TerminalInfo) {
  await enableTerminal(page)
  const reads = [{ info: terminal.info, ready: terminal.program.ready }, ...(control ? [{ info: control, ready: undefined }] : [])]
    .map(target => ({ ...target, id: marker('terminal_read') }))
  const issues: string[] = []
  const received: boolean[] = []
  model.respond(request => {
    const missing = reads.find(read => !request.toolResults.some(result => result.id === read.id))
    if (missing) return call(request, 'terminal_read', missing.id, { session: missing.info.id, mode: 'screen' }, issues)
    received.push(reads.every(read => {
      const result = request.toolResults.find(result => result.id === read.id)!.text
      return read.ready ? result.includes(read.ready) : /^\[screen \d+x\d+, cursor \d+,\d+\]/.test(result)
    }))
    return { text: 'The existing terminal output is available to the AI.' }
  })
  const turn = await sendAcceptanceMessage(page, control
    ? 'Read both isolated terminals before I decide which one to retain or terminate.'
    : 'Read the existing isolated terminal before I decide whether to retain it.')
  await expect(page.locator('.message-assistant').last()).toContainText('The existing terminal output is available to the AI.')
  await waitForAcceptanceIdle(page, turn.conversationId)
  expect(issues).toEqual([])
  expect(received).toEqual([true])
  for (const read of reads) expect((await terminals(page)).find(session => session.id === read.info.id)).toMatchObject({ owner: 'user', aiTouched: true, state: 'running' })
  await assertTerminalTools(page, turn)
}

async function closeChoice(page: Page, terminal: OpenedTerminal, choice: 'Keep running in background' | 'Close completely') {
  const info = (await terminals(page)).find(session => session.id === terminal.info.id)!
  const tab = terminalTab(page, info.title)
  await expect(tab).toHaveCount(1)
  await tab.hover()
  await tab.locator('.canvas-tab-close').click()
  const guard = page.getByText('This terminal has been used by AI', { exact: true }).locator('..').locator('..')
  await expect(guard).toBeVisible()
  await expect(guard).toContainText(info.title)
  await guard.getByRole('button', { name: choice, exact: true }).click()
  await expect(guard).toHaveCount(0)
  await expect(tab).toHaveCount(0)
  return info
}

function liveTrigger(page: Page, title: string) {
  return page.locator('[role="button"][aria-haspopup="dialog"]').filter({ has: page.getByText(title, { exact: true }) })
}

async function openAggregateTerminal(page: Page, selectedTitle: string, titles: string[]) {
  expect(new Set(titles).size).toBe(titles.length)
  await page.getByRole('button', { name: `${titles.length} sessions running`, exact: true }).click()
  const tray = page.getByRole('dialog').filter({ has: page.getByText('Active sessions', { exact: true }) })
  for (const title of titles) await expect(tray.getByRole('button').filter({ has: page.getByText(title, { exact: true }) })).toHaveCount(1)
  await tray.getByRole('button').filter({ has: page.getByText(selectedTitle, { exact: true }) }).click()
  await expect(terminalTab(page, selectedTitle)).toHaveClass(/\bactive\b/)
}

test('AI terminal tools and user keyboard input reach the same real interactive process in order', terminalAcceptance('terminal.sessions.interact'), async ({ terminalApp, model, window }, info) => {
  const space = await workspace(terminalApp, 'Shared terminal')
  await enterWorkspace(window, space)
  const terminal = await openOwnedTerminal(terminalApp, 'shared', space.id)
  const processBefore = assertProcess(terminal, space)
  await enableTerminal(window)
  const aiInput = marker('AI'), userInput = marker('USER')
  const secondQuestion = 'Read the terminal again after my keyboard response.'
  const observed = { initial: false, write: false, human: false }
  const issues: string[] = []
  model.respond(request => {
    if (request.lastUserText.includes(secondQuestion)) {
      const result = request.toolResults.find(result => result.id === 'terminal-read-human')
      if (!result) return call(request, 'terminal_read', 'terminal-read-human', { session: terminal.info.id, mode: 'screen' }, issues)
      const first = result.text.indexOf(terminal.program.ack(1, aiInput)), second = result.text.indexOf(terminal.program.ack(2, userInput))
      observed.human = first >= 0 && second > first
      return { text: 'The user response followed the AI input in the same terminal.' }
    }
    const written = request.toolResults.find(result => result.id === 'terminal-ai-input')
    if (written) { observed.write = written.text.includes(terminal.program.ack(1, aiInput)); return { text: 'The AI input reached the shared terminal.' } }
    const read = request.toolResults.find(result => result.id === 'terminal-read-initial')
    if (read) { observed.initial = read.text.includes(terminal.program.ready); return call(request, 'terminal_write', 'terminal-ai-input', { session: terminal.info.id, input: aiInput, timeout: 2 }, issues) }
    return call(request, 'terminal_read', 'terminal-read-initial', { session: terminal.info.id, mode: 'screen' }, issues)
  })
  const first = await sendAcceptanceMessage(window, 'Read the existing terminal and enter the supplied isolated marker.')
  await expect(window.locator('.message-assistant').last()).toContainText('The AI input reached the shared terminal.')
  await waitForAcceptanceIdle(window, first.conversationId)
  await assertTerminalTools(window, first)
  await expect(window.locator('.xterm-rows')).toContainText(terminal.program.ack(1, aiInput))
  await typeTerminalInput(window, terminal.program, userInput)
  const second = await sendAcceptanceMessage(window, secondQuestion)
  expect(second.conversationId).toBe(first.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText('The user response followed the AI input in the same terminal.')
  await waitForAcceptanceIdle(window, second.conversationId)
  await assertTerminalTools(window, second)
  expect(observed).toEqual({ initial: true, write: true, human: true })
  expect(issues).toEqual([])
  expect(terminal.program.inputs().map(receipt => receipt.input)).toEqual([aiInput, userInput])
  expect(assertProcess(terminal, space)).toEqual(processBefore)
  expect((await replay(window, terminal.info.id)).info).toMatchObject({ id: terminal.info.id, createdAt: terminal.info.createdAt, aiTouched: true, state: 'running' })
  expect(model.exchanges).toHaveLength(5)
  await info.attach('shared-terminal-input', { body: JSON.stringify({ observed, processBefore, inputs: terminal.program.inputs() }, null, 2), contentType: 'application/json' })
})

test('keeping an AI-touched terminal closes its tab and reopens the same live process from the workspace tray', terminalAcceptance('terminal.sessions.keep'), async ({ terminalApp, model, window }, info) => {
  const space = await workspace(terminalApp, 'Retained terminal')
  await enterWorkspace(window, space)
  const terminal = await openOwnedTerminal(terminalApp, 'retained', space.id)
  const processBefore = assertProcess(terminal, space)
  await touchWithAi(window, model, terminal)
  const retained = await closeChoice(window, terminal, 'Keep running in background')
  expect(assertProcess(terminal, space)).toEqual(processBefore)
  await expect(liveTrigger(window, retained.title)).toHaveCount(1)
  await liveTrigger(window, retained.title).click()
  const tray = window.getByRole('dialog').filter({ has: window.getByText('Active sessions', { exact: true }) })
  await expect(tray).toBeVisible()
  await tray.getByRole('button').filter({ has: window.getByText(retained.title, { exact: true }) }).click()
  await expect(terminalTab(window, retained.title)).toHaveClass(/\bactive\b/)
  await expect(window.locator('.xterm-rows')).toContainText(terminal.program.ready)
  await typeTerminalInput(window, terminal.program, marker('REOPENED'))
  expect(assertProcess(terminal, space)).toEqual(processBefore)
  expect((await replay(window, terminal.info.id)).info).toMatchObject({ id: terminal.info.id, createdAt: retained.createdAt, state: 'running', aiTouched: true })
  expect(await terminals(window)).toHaveLength(1)
  expect(model.exchanges).toHaveLength(2)
  await info.attach('retained-terminal-process', { body: JSON.stringify({ retained, processBefore, inputs: terminal.program.inputs() }, null, 2), contentType: 'application/json' })
})

test('terminating the retained target exits its actual program and shell while a separate terminal remains interactive', terminalAcceptance('terminal.sessions.terminate'), async ({ terminalApp, model, window }, info) => {
  const space = await workspace(terminalApp, 'Terminal termination')
  await enterWorkspace(window, space)
  const target = await openOwnedTerminal(terminalApp, 'target', space.id)
  const targetProcess = assertProcess(target, space)
  const controlTitle = `Control ${marker('PTY')}`
  const created = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.createTerminal(input), { spaceId: space.id, title: controlTitle })
  expect(created.success).toBe(true)
  const controlInfoBefore = created.data as TerminalInfo
  terminalApp.sessionIds.add(controlInfoBefore.id)
  expect(controlInfoBefore).toMatchObject({ title: controlTitle, spaceId: space.id, owner: 'user', aiTouched: false, state: 'running' })
  expect(controlInfoBefore.id).not.toBe(target.info.id)
  await touchWithAi(window, model, target, controlInfoBefore)
  await openAggregateTerminal(window, controlTitle, [target.info.title, controlTitle])
  const control = await startOwnedTerminalProgram(terminalApp, 'control', controlInfoBefore)
  const controlProcess = assertProcess(control, space)
  expect(targetProcess.pid).not.toBe(controlProcess.pid)
  expect(targetProcess.shellPid).not.toBe(controlProcess.shellPid)
  const targetInfo = await closeChoice(window, target, 'Keep running in background')
  await openAggregateTerminal(window, targetInfo.title, [targetInfo.title, controlTitle])
  await closeChoice(window, target, 'Close completely')
  await expect.poll(() => target.program.confirmedExited(), { timeout: 15000, message: 'Both the target program and its PTY shell must leave the OS process table' }).toBe(true)
  await expect.poll(async () => (await terminalEvents(window)).some(event => event.sessionId === target.info.id && event.type === 'exited' && event.info?.state === 'exited')).toBe(true)
  expect((await terminals(window)).some(session => session.id === target.info.id && session.state === 'running')).toBe(false)
  expect(target.program.observation().exit?.reason).not.toBe('watchdog')
  await expect(liveTrigger(window, targetInfo.title)).toHaveCount(0)
  expect(assertProcess(control, space)).toEqual(controlProcess)
  const controlInfo = (await terminals(window)).find(session => session.id === control.info.id)!
  await expect(liveTrigger(window, controlInfo.title)).toHaveCount(1)
  await liveTrigger(window, controlInfo.title).click()
  const remainingTray = window.getByRole('dialog').filter({ has: window.getByText('Active sessions', { exact: true }) })
  await expect(remainingTray.getByRole('button').filter({ has: window.getByText(targetInfo.title, { exact: true }) })).toHaveCount(0)
  const controlRow = remainingTray.getByRole('button').filter({ has: window.getByText(controlInfo.title, { exact: true }) })
  await expect(controlRow).toHaveCount(1)
  await controlRow.click()
  await expect(terminalTab(window, controlInfo.title)).toHaveClass(/\bactive\b/)
  await typeTerminalInput(window, control.program, marker('CONTROL_ALIVE'))
  expect(assertProcess(control, space)).toEqual(controlProcess)
  expect(controlInfo).toMatchObject({ state: 'running', owner: 'user', aiTouched: true })
  expect(model.exchanges).toHaveLength(3)
  await info.attach('terminal-termination', { body: JSON.stringify({ target: target.program.observation(), control: control.program.observation(), controlInputs: control.program.inputs() }, null, 2), contentType: 'application/json' })
})

test('switching workspaces retains each real terminal process and routes new input only to its original workspace', terminalAcceptance('workspaces.context.keep-terminal', 'none'), async ({ terminalApp, model, window }, info) => {
  model.respond(() => ({ text: 'No model request belongs to this terminal navigation scenario.' }))
  const first = await workspace(terminalApp, 'Terminal workspace A'), second = await workspace(terminalApp, 'Terminal workspace B')
  await enterWorkspace(window, first)
  const a = await openOwnedTerminal(terminalApp, 'workspace-a', first.id)
  const aProcess = assertProcess(a, first)
  const aTitle = (await terminals(window)).find(session => session.id === a.info.id)!.title
  await switchWorkspace(window, second)
  await expect(terminalTab(window, aTitle)).toHaveCount(0)
  expect(assertProcess(a, first)).toEqual(aProcess)
  const b = await openOwnedTerminal(terminalApp, 'workspace-b', second.id)
  const bProcess = assertProcess(b, second)
  const bTitle = (await terminals(window)).find(session => session.id === b.info.id)!.title
  await switchWorkspace(window, first)
  await expect(terminalTab(window, aTitle)).toHaveClass(/\bactive\b/)
  await expect(window.locator('.canvas-tab')).toHaveCount(1)
  await expect(window.locator('.xterm-rows')).toBeVisible()
  await expect(window.locator('.xterm-rows')).toContainText(a.program.ready)
  await expect(window.locator('.xterm-rows')).not.toContainText(b.program.ready)
  await typeTerminalInput(window, a.program, marker('WORKSPACE_A'))
  expect(assertProcess(a, first)).toEqual(aProcess)
  expect(b.program.inputs()).toEqual([])
  await switchWorkspace(window, second)
  await expect(terminalTab(window, bTitle)).toHaveClass(/\bactive\b/)
  await expect(window.locator('.canvas-tab')).toHaveCount(1)
  await expect(window.locator('.xterm-rows')).toBeVisible()
  await expect(window.locator('.xterm-rows')).toContainText(b.program.ready)
  await expect(window.locator('.xterm-rows')).not.toContainText(a.program.ready)
  await typeTerminalInput(window, b.program, marker('WORKSPACE_B'))
  expect(assertProcess(b, second)).toEqual(bProcess)
  expect(a.program.inputs()).toHaveLength(1)
  const sessions = await terminals(window)
  expect(sessions).toHaveLength(2)
  expect(sessions.find(session => session.id === a.info.id)).toMatchObject({ spaceId: first.id, createdAt: a.info.createdAt, state: 'running' })
  expect(sessions.find(session => session.id === b.info.id)).toMatchObject({ spaceId: second.id, createdAt: b.info.createdAt, state: 'running' })
  expect(model.exchanges).toEqual([])
  await info.attach('workspace-terminal-retention', { body: JSON.stringify({ a: a.program.observation(), b: b.program.observation(), inputsA: a.program.inputs(), inputsB: b.program.inputs(), sessions }, null, 2), contentType: 'application/json' })
})
