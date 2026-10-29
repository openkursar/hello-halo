import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import type { ContentReference } from '../../../src/shared/types/content-reference'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { ADD_TO_CHAT_KEY, commentOnWord, composerPill, doubleClickWord, selectionBar } from '../fixtures/changes-helpers'
import { navigateToChat } from '../fixtures/helpers'
import { clickArtifactByName } from '../../perf/lib/open-artifact'

test.setTimeout(90000)

test('selected file passages and their comment reach one real model turn and remain on the sent message', acceptance('references.context.send', { source: 'file' }), async ({ acceptanceApp, model, window }, info) => {
  const directory = join(acceptanceApp.profile, '.halo', 'temp', 'artifacts')
  mkdirSync(directory, { recursive: true })
  const alpha = `Alpha${randomUUID().replaceAll('-', '')}`
  const beta = `Beta${randomUUID().replaceAll('-', '')}`
  const unrelated = `Unrelated${randomUUID().replaceAll('-', '')}`
  const first = join(directory, 'first-reference.ts')
  const second = join(directory, 'second-reference.ts')
  const control = join(directory, 'unselected-reference.ts')
  const files = new Map([
    [first, `// First source\nexport const ${alpha} = 17\n`],
    [second, `// Second source\nexport const ${beta} = 29\n`],
    [control, `export const ${unrelated} = 83\n`],
  ])
  for (const [file, content] of files) writeFileSync(file, content)
  const note = `Explain this selected declaration ${randomUUID()}`
  const question = `Compare the two places I selected ${randomUUID()}`
  const answer = 'Both selected passages and the comment arrived.'
  const submitted: string[] = []
  model.respond(request => {
    submitted.push(request.lastUserText)
    return { text: answer }
  })

  await navigateToChat(window)
  await clickArtifactByName(window, basename(first))
  await expect(window.locator('.canvas-tab.active')).toContainText(basename(first))
  const firstLine = window.locator('.cm-editor .cm-line').filter({ hasText: alpha }).first()
  await doubleClickWord(window, firstLine, alpha)
  await expect(selectionBar(window)).toBeVisible()
  await window.keyboard.press(ADD_TO_CHAT_KEY)
  await expect(composerPill(window, 'selections')).toHaveText(/^1 selections?$/)

  await clickArtifactByName(window, basename(second))
  await expect(window.locator('.canvas-tab.active')).toContainText(basename(second))
  const secondLine = window.locator('.cm-editor .cm-line').filter({ hasText: beta }).first()
  await commentOnWord(window, secondLine, beta, note)
  await expect(composerPill(window, 'comments')).toHaveText(/^1 comments?$/)
  await expect(composerPill(window, 'selections')).toHaveText(/^1 selections?$/)

  const turn = await sendAcceptanceMessage(window, question)
  await expect(window.locator('.message-assistant').last()).toContainText(answer)
  await waitForAcceptanceIdle(window, turn.conversationId)
  const saved = await window.evaluate(async ({ spaceId, conversationId }) => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.getConversation(spaceId, conversationId)
    if (!result.success || !result.data) throw new Error('Could not read the conversation that received the selected passages')
    return result.data as { messages: Array<{ id: string; role: string; content: string; metadata?: { references?: ContentReference[] } }> }
  }, turn)
  const users = saved.messages.filter(message => message.role === 'user')
  expect(users).toHaveLength(1)
  expect(users[0].content).toBe(question)
  const references = users[0].metadata?.references
  expect(references).toHaveLength(2)
  expect(new Set(references!.map(reference => reference.id)).size).toBe(2)
  expect(references).toEqual([
    expect.objectContaining({ source: expect.objectContaining({ kind: 'file', precision: 'lines' }), range: { startLine: 2, endLine: 2 }, quote: alpha }),
    expect.objectContaining({ source: expect.objectContaining({ kind: 'file', precision: 'lines' }), range: { startLine: 2, endLine: 2 }, quote: beta, note }),
  ])
  for (const [index, file] of [first, second].entries()) {
    const source = references![index].source
    if (source.kind !== 'file') throw new Error('The saved reference is not a selected file passage')
    expect(realpathSync(source.path)).toBe(realpathSync(file))
  }
  expect(references![0].note).toBeUndefined()
  await expect(composerPill(window, 'selections')).toHaveCount(0)
  await expect(composerPill(window, 'comments')).toHaveCount(0)
  const sent = window.locator(`[data-message-id="${users[0].id}"]`).first()
  await expect(sent.getByRole('button', { name: /^1 selections?$/ })).toBeVisible()
  await expect(sent.getByRole('button', { name: /^1 comments?$/ })).toBeVisible()

  await info.attach('submitted-reference-observations', { body: JSON.stringify({ references, submitted }, null, 2), contentType: 'application/json' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain(question)
  const blocks = [...submitted[0].matchAll(/<halo_references>\n([\s\S]*?)\n<\/halo_references>/g)]
  expect(blocks).toHaveLength(1)
  const context = blocks[0][1]
  for (const excerpt of [alpha, beta, note]) expect(context.split(excerpt)).toHaveLength(2)
  expect(context).toContain(`${basename(first)}, line 2`)
  expect(context).toContain(`${basename(second)}, line 2`)
  expect(context.indexOf(alpha)).toBeLessThan(context.indexOf(beta))
  expect(submitted[0]).not.toContain(unrelated)
  for (const [file, content] of files) expect(readFileSync(file, 'utf8')).toBe(content)
})
