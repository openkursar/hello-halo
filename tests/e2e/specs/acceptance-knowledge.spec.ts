import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { KBSource } from '../../../src/shared/types/tlon'
import {
  test, expect, knowledgeAcceptance, createKnowledgeBase, sourceFile, dropKnowledgeFiles,
  assertImportedCopy, waitForKnowledgeFiles, readKnowledgeFiles, readKnowledgeIndex,
  extractedDocument, knowledgeFileRow, blankPdf, sendAcceptanceMessage, waitForAcceptanceIdle,
} from '../fixtures/acceptance-knowledge'
import { contentText, modelTool } from '../fixtures/acceptance-model'
import { knowledgeDocument } from '../fixtures/acceptance-knowledge-formats'
import { navigateToChat, waitForHomePage } from '../fixtures/helpers'

test.setTimeout(120000)

async function reopenKnowledge(page: Page, name: string) {
  await waitForHomePage(page)
  await page.getByRole('button', { name: 'Knowledge Base', exact: true }).first().click()
  await page.getByText(name, { exact: true }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
}

for (const format of ['text', 'markdown'] as const) {
  test(`a dropped ${format} source is learned, readable and retained after restart`, knowledgeAcceptance('knowledge.sources.import', 'none', { format }), async ({ acceptanceApp, model, window }, info) => {
    expect(await acceptanceApp.app.evaluate(({ app }) => app.isPackaged), 'Import coverage requires the controlled packaged application').toBe(true)
    const marker = `Synthetic knowledge ${randomUUID()}`
    const content = format === 'markdown' ? `# Imported reference\n\n${marker}\n` : `${marker}\n`
    const source = sourceFile(acceptanceApp.profile, `imported-reference.${format === 'markdown' ? 'md' : 'txt'}`, content)
    const kb = await createKnowledgeBase(window, `Imported ${format}`)
    const drop = await dropKnowledgeFiles(window, [source])
    const copy = await assertImportedCopy(window, kb, source)
    await waitForKnowledgeFiles(window, kb.id, { [basename(source)]: 'learned' })
    const index = await readKnowledgeIndex(window, kb.id)
    const extracted = extractedDocument(index, basename(source))
    expect(readFileSync(extracted, 'utf8')).toContain(content.trim())
    await knowledgeFileRow(window, basename(source)).click()
    await expect(window.locator('.canvas-tab.active')).toContainText(basename(source))
    if (format === 'markdown') await expect(window.getByText(marker, { exact: true })).toBeVisible()
    else await expect(window.locator('.cm-content')).toContainText(marker)
    const reopened = await acceptanceApp.restart()
    await reopenKnowledge(reopened, kb.name)
    await waitForKnowledgeFiles(reopened, kb.id, { [basename(source)]: 'learned' })
    expect(readFileSync(copy.openPath, 'utf8')).toBe(content)
    expect(readFileSync(source, 'utf8')).toBe(content)
    expect(readFileSync(extractedDocument(await readKnowledgeIndex(reopened, kb.id), basename(source)), 'utf8')).toContain(marker)
    expect(model.exchanges, 'Learning these formats must not require a model request').toEqual([])
    await info.attach('knowledge-import', { body: JSON.stringify({ format, drop, copy, index }, null, 2), contentType: 'application/json' })
  })
}

for (const format of ['pdf', 'docx', 'xlsx', 'csv', 'html'] as const) {
  test(`a dropped ${format} document is learned with its source content retained after restart`, knowledgeAcceptance('knowledge.sources.import', 'none', { format }), async ({ acceptanceApp, model, window }, info) => {
    expect(await acceptanceApp.app.evaluate(({ app }) => app.isPackaged), 'Import coverage requires the controlled packaged application').toBe(true)
    const marker = `Synthetic knowledge ${randomUUID()}`
    const documents = format === 'xlsx'
      ? await Promise.all(['shared', 'cell'].map(strings => knowledgeDocument(format, `${marker}-${strings}`, strings as 'shared' | 'cell')))
      : [await knowledgeDocument(format, marker)]
    const inputs = documents.map(document => ({ document, source: sourceFile(acceptanceApp.profile, document.name, document.bytes) }))
    const kb = await createKnowledgeBase(window, `Imported ${format}`)
    const drop = await dropKnowledgeFiles(window, inputs.map(input => input.source))
    const inspect = async (page: Page) => {
      await expect.poll(async () => {
        const files = await readKnowledgeFiles(page, kb.id)
        return files.length === inputs.length && files.every(file => file.state !== 'pending')
      }, { timeout: 30000 }).toBe(true)
      const files = await readKnowledgeFiles(page, kb.id)
      const index = await readKnowledgeIndex(page, kb.id)
      const skipped = files.find(file => file.state === 'no-text')
      if (skipped && !await knowledgeFileRow(page, skipped.name).isVisible()) await page.getByRole('button', { name: /Skipped — no readable text/ }).click()
      const results = []
      for (const { document, source } of inputs) {
        const file = files.find(file => file.name === document.name)!
        expect(file).toMatchObject({ source: 'raw', name: document.name })
        expect(resolve(file.openPath)).toBe(resolve(kb.path, 'raw', document.name))
        expect(resolve(file.openPath)).not.toBe(resolve(source))
        expect(readFileSync(file.openPath)).toEqual(document.bytes)
        expect(readFileSync(source)).toEqual(document.bytes)
        await expect(knowledgeFileRow(page, document.name)).toBeVisible()
        const text = file.state === 'learned' ? readFileSync(extractedDocument(index, document.name), 'utf8') : ''
        results.push({ name: document.name, state: file.state, text, expectedText: document.expectedText })
      }
      return { files, index, results }
    }
    const before = await inspect(window)
    await info.attach('knowledge-format-extraction', { body: JSON.stringify({ format, drop, ...before }, null, 2), contentType: 'application/json' })
    for (const result of before.results) {
      expect.soft(result.state, `${result.name} must be learned`).toBe('learned')
      for (const expected of result.expectedText) expect.soft(result.text, `${result.name} extraction must retain ${expected}`).toContain(expected)
    }
    const reopened = await acceptanceApp.restart()
    await reopenKnowledge(reopened, kb.name)
    const after = await inspect(reopened)
    await info.attach('knowledge-format-restored', { body: JSON.stringify({ format, ...after }, null, 2), contentType: 'application/json' })
    expect(after.results).toEqual(before.results)
    for (const result of after.results) {
      expect.soft(result.state, `${result.name} must remain learned after restart`).toBe('learned')
      for (const expected of result.expectedText) expect.soft(result.text).toContain(expected)
    }
    expect(model.exchanges, 'Offline document learning must not require a model request').toEqual([])
  })
}

test('a conversation receives only the selected knowledge context and its real read produces an opening source citation', knowledgeAcceptance('knowledge.use.attach', 'scripted'), async ({ acceptanceApp, model, window }, info) => {
  const fact = `cedar-${randomUUID()}`
  const otherFact = `willow-${randomUUID()}`
  const selectedSource = sourceFile(acceptanceApp.profile, 'selected-reference.md', `# Cedar reference\n\nThis document describes the synthetic Cedar cabinet.\n\nThe Cedar cabinet access code is ${fact}.\n`)
  const otherSource = sourceFile(acceptanceApp.profile, 'unselected-reference.md', `# Willow reference\n\nThis document describes the synthetic Willow cabinet.\n\nThe Willow cabinet access code is ${otherFact}.\n`)
  const selected = await createKnowledgeBase(window, 'Selected knowledge')
  await dropKnowledgeFiles(window, [selectedSource])
  const copy = await assertImportedCopy(window, selected, selectedSource)
  await waitForKnowledgeFiles(window, selected.id, { [basename(selectedSource)]: 'learned' })
  const other = await createKnowledgeBase(window, 'Unselected knowledge')
  await dropKnowledgeFiles(window, [otherSource])
  await assertImportedCopy(window, other, otherSource)
  await waitForKnowledgeFiles(window, other.id, { [basename(otherSource)]: 'learned' })
  let step = 0
  let document = ''
  model.respond(request => {
    step++
    const prompt = [contentText(request.body.system), ...request.messages.filter(message => message.role === 'system').map(message => contentText(message.content))].join('\n')
    expect(prompt).toContain(`## ${selected.name}`)
    expect(prompt).not.toContain(`## ${other.name}`)
    expect(prompt).not.toContain(basename(otherSource))
    expect(prompt).not.toContain(otherFact)
    if (step === 1) {
      document = extractedDocument(prompt, basename(selectedSource))
      expect(dirname(realpathSync(document))).toBe(realpathSync(resolve(selected.path, 'text')))
      return { tools: [modelTool(request, 'Grep', { pattern: 'Cedar cabinet access code', path: document, output_mode: 'content' }, 'knowledge-search')] }
    }
    expect(request.toolResults.find(result => result.id === 'knowledge-search')).toMatchObject({ error: false, text: expect.stringContaining(fact) })
    if (step === 2) return { tools: [modelTool(request, 'Read', { file_path: document }, 'knowledge-read')] }
    expect(step).toBe(3)
    const read = request.toolResults.find(result => result.id === 'knowledge-read')
    expect(read).toMatchObject({ error: false, text: expect.stringContaining(fact) })
    const answer = read!.text.match(/The Cedar cabinet access code is (cedar-[a-f0-9-]+)\./)?.[1]
    expect(answer).toBe(fact)
    return { text: `The Cedar cabinet access code is ${answer}. Source: selected-reference.md.` }
  })
  await navigateToChat(window)
  await window.getByTitle('Load knowledge bases into this conversation', { exact: true }).click()
  await window.getByText(selected.name, { exact: true }).click()
  await window.keyboard.press('Escape')
  const turn = await sendAcceptanceMessage(window, 'Find the Cedar cabinet access code in the selected knowledge and cite the source.')
  await expect(window.locator('.message-assistant').last()).toContainText(fact)
  await waitForAcceptanceIdle(window, turn.conversationId)
  const stored = await window.evaluate(async target => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.getConversation(target.spaceId, target.conversationId)
    if (!result.success) throw new Error('Could not read the conversation knowledge selection and citations')
    return result.data as { knowledgeBaseIds: string[]; messages: Array<{ role: string; content: string; sources?: KBSource[] }> }
  }, turn)
  expect(stored.knowledgeBaseIds).toEqual([selected.id])
  expect(stored.messages.at(-1)?.sources).toEqual([{ name: basename(selectedSource), path: copy.openPath }])
  expect(stored.messages.at(-1)?.content).toContain(fact)
  await window.locator('.message-assistant').last().getByTitle('Open selected-reference.md', { exact: true }).click()
  await expect(window.locator('.canvas-tab.active')).toContainText('selected-reference.md')
  await expect(window.getByRole('heading', { name: 'Cedar reference', exact: true })).toBeVisible()
  await expect(window.getByText(`The Cedar cabinet access code is ${fact}.`, { exact: true })).toBeVisible()
  expect(step).toBe(3)
  await info.attach('knowledge-retrieval-and-citation', { body: JSON.stringify({ selected: selected.id, unselected: other.id, document, stored }, null, 2), contentType: 'application/json' })
})

test('removal can be cancelled and removes only the imported copy when confirmed', knowledgeAcceptance('knowledge.sources.remove', 'none'), async ({ acceptanceApp, model, window }, info) => {
  const content = `Keep this original source ${randomUUID()}\n`
  const source = sourceFile(acceptanceApp.profile, 'retained-original.txt', content)
  const kb = await createKnowledgeBase(window, 'Removal knowledge')
  await dropKnowledgeFiles(window, [source])
  const copy = await assertImportedCopy(window, kb, source)
  await waitForKnowledgeFiles(window, kb.id, { [basename(source)]: 'learned' })
  const row = knowledgeFileRow(window, basename(source))
  await row.hover()
  await row.getByTitle('Remove', { exact: true }).click()
  const dialog = window.getByRole('alertdialog', { name: 'Remove file', exact: true })
  await expect(dialog).toContainText(basename(source))
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(row).toBeVisible()
  expect(await readKnowledgeFiles(window, kb.id)).toHaveLength(1)
  expect(readFileSync(copy.openPath, 'utf8')).toBe(content)
  expect(readFileSync(source, 'utf8')).toBe(content)
  await row.hover()
  await row.getByTitle('Remove', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(row).toHaveCount(0)
  await expect.poll(() => readKnowledgeFiles(window, kb.id)).toEqual([])
  expect(existsSync(copy.openPath)).toBe(false)
  expect(readFileSync(source, 'utf8')).toBe(content)
  const reopened = await acceptanceApp.restart()
  await reopenKnowledge(reopened, kb.name)
  await expect(reopened.getByText('No files yet. Add some above to get started.', { exact: true })).toBeVisible()
  expect(await readKnowledgeFiles(reopened, kb.id)).toEqual([])
  expect(readFileSync(source, 'utf8')).toBe(content)
  expect(model.exchanges).toEqual([])
  await info.attach('knowledge-removal', { body: JSON.stringify({ source, removedCopy: copy.openPath, originalRetained: true }, null, 2), contentType: 'application/json' })
})

test('a corrupt document and textless PDF stay distinguishable while a valid source is learned', knowledgeAcceptance('knowledge.sources.failures', 'none'), async ({ acceptanceApp, model, window }, info) => {
  const marker = `Readable source ${randomUUID()}`
  const good = sourceFile(acceptanceApp.profile, 'readable-source.txt', `${marker}\n`)
  const broken = sourceFile(acceptanceApp.profile, 'broken-document.docx', 'This is not an OOXML archive.')
  const blank = sourceFile(acceptanceApp.profile, 'textless-document.pdf', blankPdf())
  const kb = await createKnowledgeBase(window, 'Mixed source states')
  await dropKnowledgeFiles(window, [good, broken, blank])
  for (const source of [good, broken]) await assertImportedCopy(window, kb, source)
  const expected = { [basename(good)]: 'learned', [basename(broken)]: 'failed', [basename(blank)]: 'no-text' } as const
  await waitForKnowledgeFiles(window, kb.id, expected)
  await expect(knowledgeFileRow(window, basename(broken))).toContainText("Couldn't read:")
  await window.getByRole('button', { name: /Skipped — no readable text/ }).click()
  await expect(knowledgeFileRow(window, basename(blank))).toContainText('No text layer — looks like a scan')
  await assertImportedCopy(window, kb, blank)
  const index = await readKnowledgeIndex(window, kb.id)
  expect(readFileSync(extractedDocument(index, basename(good)), 'utf8')).toContain(marker)
  expect(index).not.toContain(basename(broken))
  expect(index).not.toContain(basename(blank))
  const reopened = await acceptanceApp.restart()
  await reopenKnowledge(reopened, kb.name)
  await waitForKnowledgeFiles(reopened, kb.id, expected)
  await expect(knowledgeFileRow(reopened, basename(broken))).toContainText("Couldn't read:")
  await reopened.getByRole('button', { name: /Skipped — no readable text/ }).click()
  await expect(knowledgeFileRow(reopened, basename(blank))).toContainText('No text layer — looks like a scan')
  expect(model.exchanges).toEqual([])
  await info.attach('knowledge-source-states', { body: JSON.stringify({ files: await readKnowledgeFiles(reopened, kb.id), index }, null, 2), contentType: 'application/json' })
})
