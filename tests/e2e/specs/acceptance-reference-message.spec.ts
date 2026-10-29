import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import type { ContentReference } from '../../../src/shared/types/content-reference'
import {
  test, expect, acceptance, readAcceptanceConversation, sendAcceptanceMessage, waitForAcceptanceIdle,
} from '../fixtures/acceptance-app'
import { ADD_TO_CHAT_KEY, composerPill, doubleClickWord, selectionBar } from '../fixtures/changes-helpers'
import { navigateToChat } from '../fixtures/helpers'
import { clickArtifactByName } from '../../perf/lib/open-artifact'

test.setTimeout(90000)

test('a selected reply passage and file excerpt reach the model with their distinct source identities', acceptance('references.context.send', { source: 'message' }), async ({ acceptanceApp, model, window }, info) => {
  const messageToken = `Message${randomUUID().replaceAll('-', '')}`
  const fileToken = `File${randomUUID().replaceAll('-', '')}`
  const unselected = `Unselected${randomUUID().replaceAll('-', '')}`
  const file = join(acceptanceApp.profile, '.halo', 'temp', 'artifacts', 'message-companion.ts')
  mkdirSync(join(acceptanceApp.profile, '.halo', 'temp', 'artifacts'), { recursive: true })
  writeFileSync(file, `// Companion source\nexport const ${fileToken} = 31\n`)
  const initial = `Show a passage I can select ${randomUUID()}`
  const question = `Discuss the selected reply and file ${randomUUID()}`
  const answer = 'The reply passage and file excerpt arrived together.'
  const submitted: string[] = []
  model.respond(request => {
    if (request.lastUserText.includes(question)) {
      submitted.push(request.lastUserText)
      return { text: answer }
    }
    if (request.lastUserText.includes(initial)) return { text: `Selected passage: ${messageToken}.\n\nA different passage: ${unselected}.` }
    throw new Error(`Unexpected reference setup request ${request.sequence}`)
  })
  await navigateToChat(window)
  const first = await sendAcceptanceMessage(window, initial)
  await expect(window.locator('.message-assistant').last()).toContainText(messageToken)
  await waitForAcceptanceIdle(window, first.conversationId)
  const history = await readAcceptanceConversation(window, first.spaceId, first.conversationId)
  const original = history.messages.find(message => message.role === 'assistant' && message.content.includes(messageToken))!
  expect(original).toBeTruthy()
  const reply = window.locator(`[data-message-id="${original.id}"] .markdown-content`).first()
  await doubleClickWord(window, reply, messageToken)
  await expect(selectionBar(window)).toBeVisible()
  await window.keyboard.press(ADD_TO_CHAT_KEY)
  await expect(composerPill(window, 'selections')).toHaveText(/^1 selections?$/)
  await clickArtifactByName(window, basename(file))
  await expect(window.locator('.canvas-tab.active')).toContainText(basename(file))
  await doubleClickWord(window, window.locator('.cm-editor .cm-line').filter({ hasText: fileToken }).first(), fileToken)
  await expect(selectionBar(window)).toBeVisible()
  await window.keyboard.press(ADD_TO_CHAT_KEY)
  await expect(composerPill(window, 'selections')).toHaveText(/^2 selections?$/)

  const sent = await sendAcceptanceMessage(window, question)
  expect(sent.conversationId).toBe(first.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText(answer)
  await waitForAcceptanceIdle(window, sent.conversationId)
  const stored = await window.evaluate(async ({ spaceId, conversationId }) => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.getConversation(spaceId, conversationId)
    if (!result.success || !result.data) throw new Error('The sent reference message was not stored')
    return result.data as { messages: Array<{ id: string; role: string; content: string; metadata?: { references?: ContentReference[] } }> }
  }, sent)
  const requests = stored.messages.filter(message => message.role === 'user' && message.content === question)
  expect(requests).toHaveLength(1)
  const references = requests[0].metadata?.references
  expect(references).toHaveLength(2)
  expect(new Set(references!.map(reference => reference.id)).size).toBe(2)
  expect(references![0]).toMatchObject({ source: { kind: 'message', conversationId: first.conversationId, messageId: original.id }, quote: messageToken })
  expect(references![0].source).not.toMatchObject({ whole: true })
  expect(references![1]).toMatchObject({ source: { kind: 'file', precision: 'lines' }, range: { startLine: 2, endLine: 2 }, quote: fileToken })
  const fileSource = references![1].source
  if (fileSource.kind !== 'file') throw new Error('The companion reference is not a file')
  expect(realpathSync(fileSource.path)).toBe(realpathSync(file))
  expect(stored.messages.find(message => message.id === original.id)?.content).toBe(original.content)
  await expect(composerPill(window, 'selections')).toHaveCount(0)
  await expect(window.locator(`[data-message-id="${requests[0].id}"]`).first().getByRole('button', { name: /^2 selections?$/ })).toBeVisible()
  await info.attach('message-and-file-reference-context', { body: JSON.stringify({ references, submitted }, null, 2), contentType: 'application/json' })
  expect(submitted).toHaveLength(1)
  const blocks = [...submitted[0].matchAll(/<halo_references>\n([\s\S]*?)\n<\/halo_references>/g)]
  expect(blocks).toHaveLength(1)
  const context = blocks[0][1]
  expect(context.split(messageToken)).toHaveLength(2)
  expect(context.split(fileToken)).toHaveLength(2)
  expect(context).toContain(`conversation ${first.conversationId}, message ${original.id}`)
  expect(context).toContain(`${basename(file)}, line 2`)
  expect(context.indexOf(messageToken)).toBeLessThan(context.indexOf(fileToken))
  expect(context).not.toContain(unselected)
})
