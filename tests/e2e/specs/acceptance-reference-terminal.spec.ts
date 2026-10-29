import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { ContentReference } from '../../../src/shared/types/content-reference'
import type { TerminalInfo } from '../../../src/shared/types/terminal'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { ADD_TO_CHAT_KEY, composerPill, doubleClickWord, selectionBar } from '../fixtures/changes-helpers'
import { navigateToChat } from '../fixtures/helpers'
import { clickArtifactByName, openFromHeaderMenu } from '../../perf/lib/open-artifact'

test.setTimeout(90000)

async function dragTerminalPassage(window: Page, line: Locator, quote: string) {
  await expect(line).toBeVisible()
  // Read rendered glyph positions only; xterm must create the selection from the mouse gesture.
  const rect = await line.evaluate((element, text) => {
    const content = element.textContent ?? ''
    const start = content.indexOf(text)
    if (start < 0 || content.indexOf(text, start + text.length) >= 0) throw new Error('Terminal passage is not unique on its rendered line')
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let offset = 0
    let foundStart = false
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (!foundStart && start >= offset && start < offset + length) {
        range.setStart(node, start - offset)
        foundStart = true
      }
      if (foundStart && start + text.length <= offset + length) {
        range.setEnd(node, start + text.length - offset)
        const box = range.getBoundingClientRect()
        return { left: box.left, right: box.right, top: box.top, height: box.height }
      }
      offset += length
    }
    throw new Error('Terminal passage has no rendered character range')
  }, quote)
  expect(rect.right - rect.left).toBeGreaterThan(quote.length)
  expect(rect.height).toBeGreaterThan(0)
  const y = rect.top + rect.height / 2
  await window.mouse.move(rect.left + 1, y)
  await window.mouse.down()
  await window.mouse.move(rect.right - 1, y, { steps: 12 })
  await window.mouse.up()
  await expect(selectionBar(window)).toBeVisible()
  await selectionBar(window).getByRole('button', { name: 'Add to chat' }).click()
}

async function terminals(window: Page): Promise<TerminalInfo[]> {
  return window.evaluate(async () => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.listTerminals()
    if (!result.success || !Array.isArray(result.data)) throw new Error('Could not inspect actual terminal sessions')
    return result.data as TerminalInfo[]
  })
}

async function referencesOnMessage(window: Page, spaceId: string, conversationId: string) {
  return window.evaluate(async ({ spaceId, conversationId }) => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.getConversation(spaceId, conversationId)
    if (!result.success || !result.data) throw new Error('Could not read the conversation containing the terminal reference')
    return result.data as { messages: Array<{ id: string; role: string; content: string; metadata?: { references?: ContentReference[] } }> }
  }, { spaceId, conversationId })
}

test('selected real terminal output and a file passage reach one model turn and remain on the sent message', acceptance('references.context.send-terminal'), async ({ acceptanceApp, model, window }, info) => {
  const token = randomUUID().replaceAll('-', '').slice(0, 12)
  const terminalQuote = `Selected${token}`
  const before = `Before${token}`
  const after = `After${token}`
  const output = `${before} ${terminalQuote} ${after}`
  const fileQuote = `File${randomUUID().replaceAll('-', '')}`
  const fileUnselected = `Unselected${randomUUID().replaceAll('-', '')}`
  const directory = join(acceptanceApp.profile, '.halo', 'temp', 'artifacts')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'terminal-companion.ts')
  const fileContent = `// ${fileUnselected}\nexport const ${fileQuote} = 41\n`
  writeFileSync(file, fileContent)
  const question = `Compare the terminal passage with the file selection ${randomUUID()}`
  const answer = 'The selected terminal passage and file passage arrived.'
  const submitted: string[] = []
  model.respond(request => {
    submitted.push(request.lastUserText)
    return { text: answer }
  })

  await window.setViewportSize({ width: 1600, height: 900 })
  await navigateToChat(window)
  expect(await terminals(window)).toEqual([])
  await openFromHeaderMenu(window, 'Open terminal')
  await expect(window.locator('.xterm')).toBeVisible()
  await expect.poll(async () => (await terminals(window)).length).toBe(1)
  const [terminal] = await terminals(window)
  expect(terminal).toMatchObject({ owner: 'user', state: 'running', aiTouched: false })
  const title = await window.locator('.canvas-tab.active .canvas-tab-title').innerText()
  const input = window.locator('.xterm-helper-textarea')
  await expect.poll(async () => (await window.locator('.xterm-rows').innerText()).trim()).not.toBe('')
  const command = process.platform === 'win32'
    ? `[Console]::Clear(); Write-Output ('{0} {1} {2}' -f '${before}','${terminalQuote}','${after}')`
    : `printf '\\033[2J\\033[H%s %s %s\\n' '${before}' '${terminalQuote}' '${after}'`
  await input.pressSequentially(command)
  await input.press('Enter')
  const line = window.locator('.xterm-rows > div').filter({ hasText: output })
  await expect(line).toHaveCount(1)
  const replay = await window.evaluate(async sessionId => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.getTerminalReplay({ sessionId })
    if (!result.success || !result.data) throw new Error('Could not read the actual PTY output')
    return result.data as { info: TerminalInfo; data: string }
  }, terminal.id)
  expect(replay.info.id).toBe(terminal.id)
  expect(replay.data).toContain(output)
  await dragTerminalPassage(window, line, terminalQuote)
  await expect(composerPill(window, 'selections')).toHaveText(/^1 selections?$/)

  await clickArtifactByName(window, basename(file))
  await expect(window.locator('.canvas-tab.active')).toContainText(basename(file))
  const fileLine = window.locator('.cm-editor .cm-line').filter({ hasText: fileQuote }).first()
  await doubleClickWord(window, fileLine, fileQuote)
  await expect(selectionBar(window)).toBeVisible()
  await window.keyboard.press(ADD_TO_CHAT_KEY)
  await expect(composerPill(window, 'selections')).toHaveText(/^2 selections?$/)

  const turn = await sendAcceptanceMessage(window, question)
  await expect(window.locator('.message-assistant').last()).toContainText(answer)
  await waitForAcceptanceIdle(window, turn.conversationId)
  const saved = await referencesOnMessage(window, turn.spaceId, turn.conversationId)
  const users = saved.messages.filter(message => message.role === 'user')
  expect(users).toHaveLength(1)
  expect(users[0].content).toBe(question)
  const references = users[0].metadata?.references
  expect(references).toHaveLength(2)
  expect(new Set(references!.map(reference => reference.id)).size).toBe(2)
  expect(references).toEqual([
    expect.objectContaining({ source: { kind: 'terminal', title, sessionId: terminal.id }, quote: terminalQuote }),
    expect.objectContaining({ source: expect.objectContaining({ kind: 'file', precision: 'lines' }), range: { startLine: 2, endLine: 2 }, quote: fileQuote }),
  ])
  expect(references![0].range).toBeUndefined()
  expect(references!.every(reference => reference.note === undefined)).toBe(true)
  const fileSource = references![1].source
  if (fileSource.kind !== 'file') throw new Error('The second saved reference is not the selected companion file')
  expect(realpathSync(fileSource.path)).toBe(realpathSync(file))
  await expect(composerPill(window, 'selections')).toHaveCount(0)
  const sent = window.locator(`[data-message-id="${users[0].id}"]`).first()
  await expect(sent.getByRole('button', { name: /^2 selections?$/ })).toBeVisible()

  await info.attach('terminal-reference-observations', { body: JSON.stringify({ terminal, title, output, replay, references, submitted }, null, 2), contentType: 'application/json' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain(question)
  const blocks = [...submitted[0].matchAll(/<halo_references>\n([\s\S]*?)\n<\/halo_references>/g)]
  expect(blocks).toHaveLength(1)
  const context = blocks[0][1]
  for (const quote of [terminalQuote, fileQuote]) expect(context.split(quote)).toHaveLength(2)
  expect(context).toContain(`Terminal output, tab "${title}" (terminal session ${terminal.id})`)
  expect(context).toContain(`${basename(file)}, line 2`)
  expect(context.indexOf(terminalQuote)).toBeLessThan(context.indexOf(fileQuote))
  for (const unselected of [before, after, fileUnselected]) expect(context).not.toContain(unselected)
  expect(readFileSync(file, 'utf8')).toBe(fileContent)

  const reopened = await acceptanceApp.restart()
  const restored = await referencesOnMessage(reopened, turn.spaceId, turn.conversationId)
  expect(restored.messages.filter(message => message.role === 'user')).toEqual(users)
  expect(model.exchanges).toHaveLength(1)
  expect(readFileSync(file, 'utf8')).toBe(fileContent)
})
