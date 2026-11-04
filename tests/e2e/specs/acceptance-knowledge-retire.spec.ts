import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { IngestHashesV1, KnowledgeBaseEntry } from '../../../src/shared/types/tlon'
import {
  test, expect, knowledgeAcceptance, createKnowledgeBase, sourceFile, dropKnowledgeFiles,
  assertImportedCopy, waitForKnowledgeFiles, readKnowledgeFiles, readKnowledgeIndex, knowledgeFileRow,
  sendAcceptanceMessage, waitForAcceptanceIdle,
} from '../fixtures/acceptance-knowledge'
import { contentText, modelTool, type AcceptanceModel } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'

test.setTimeout(180000)

type Change = 'removed' | 'deleted' | 'renamed' | 'protected'

/** Every generated or maintained text file the KB chat can Grep, with its content. */
function searchableCorpus(kb: KnowledgeBaseEntry): Array<{ file: string; text: string }> {
  const dir = join(kb.path, 'text')
  if (!existsSync(dir)) return []
  return readdirSync(dir).map(file => ({ file, text: readFileSync(join(dir, file), 'utf8') }))
}

function hashesPath(kb: KnowledgeBaseEntry) {
  return join(kb.path, '.ingest', 'hashes.json')
}

/**
 * Ask a KB-loaded conversation for the fact. The scripted model runs a real
 * Grep over the KB's searched text directory; the application's tool result
 * is what is asserted.
 */
async function askKnowledge(page: Page, model: AcceptanceModel, kb: KnowledgeBaseEntry, fact: string, expectHits: number, forbiddenName?: string) {
  let step = 0
  let grep = ''
  model.respond(request => {
    // Only this turn's requests are scripted; any other request (e.g. a title) gets a plain reply.
    if (!request.text.includes(fact)) return { text: 'OK' }
    step++
    // The knowledge section may arrive in the system prompt or as a context message.
    const prompt = [contentText(request.body.system), request.text].join('\n')
    expect(prompt).toContain(`## ${kb.name}`)
    const context = prompt.split(`## ${kb.name}`)[1] ?? ''
    expect(context.split('\n## ')[0]).not.toContain(fact)
    if (forbiddenName) expect(context.split('\n## ')[0]).not.toContain(forbiddenName)
    if (step === 1) return { tools: [modelTool(request, 'Grep', { pattern: fact, path: join(kb.path, 'text'), output_mode: 'files_with_matches' }, 'retire-search')] }
    const result = request.toolResults.find(entry => entry.id === 'retire-search')
    expect(result?.error).toBe(false)
    grep = result!.text
    return { text: expectHits === 0 ? 'The knowledge base has nothing about it.' : 'Found it.' }
  })
  await navigateToChat(page)
  await page.getByTitle('Load knowledge bases into this conversation', { exact: true }).click()
  await page.getByText(kb.name, { exact: true }).click()
  await page.keyboard.press('Escape')
  const turn = await sendAcceptanceMessage(page, `Search the knowledge base for ${fact}.`)
  await waitForAcceptanceIdle(page, turn.conversationId)
  expect(step).toBe(2)
  const hits = grep.split('\n').filter(line => line.trim().endsWith('.txt'))
  expect(hits, `Grep result: ${grep}`).toHaveLength(expectHits)
  return { grep, hits }
}

async function addWatchedFolder(page: Page, kb: KnowledgeBaseEntry, folder: string) {
  const result = await page.evaluate(async target => (globalThis as unknown as { halo: HaloAPI }).halo.tlonAddLinkedDir(target.id, { path: target.folder, label: 'Watched synthetic folder' }), { id: kb.id, folder })
  expect(result.success).toBe(true)
}

for (const change of ['removed', 'deleted', 'renamed', 'protected'] as const satisfies readonly Change[]) {
  test(`a ${change} source leaves knowledge-base search and stays out after restart`, knowledgeAcceptance('knowledge.sources.retire-removed', 'scripted', { change }), async ({ acceptanceApp, model, window }, info) => {
    const fact = `retired-${randomUUID()}`
    const keptFact = `kept-${randomUUID()}`
    const kb = await createKnowledgeBase(window, `Retire ${change}`)
    const kept = sourceFile(acceptanceApp.profile, `kept-${change}.md`, `# Kept\n\n${keptFact}\n`)
    let removedName: string
    let renamedTo: string | undefined
    let originalOnDisk: string | undefined
    let retainedFile: string | undefined

    if (change === 'removed' || change === 'protected') {
      const source = sourceFile(acceptanceApp.profile, `${change}-source.md`, `# Source\n\nThe answer is ${fact}.\n`)
      originalOnDisk = source
      await dropKnowledgeFiles(window, [source, kept])
      const copy = await assertImportedCopy(window, kb, source)
      await waitForKnowledgeFiles(window, kb.id, { [basename(source)]: 'learned', [basename(kept)]: 'learned' })
      removedName = basename(source)
      if (change === 'removed') {
        const row = knowledgeFileRow(window, removedName)
        await row.hover()
        await row.getByTitle('Remove', { exact: true }).click()
        await window.getByRole('alertdialog', { name: 'Remove file', exact: true }).getByRole('button', { name: 'Remove', exact: true }).click()
        await expect(row).toHaveCount(0)
      } else {
        // Owner-maintained text, then the source is deleted while the app is closed.
        const page = await acceptanceApp.restart(() => {
          const hashes = JSON.parse(readFileSync(hashesPath(kb), 'utf8')) as IngestHashesV1
          const record = hashes.files[copy.path]
          appendFileSync(join(kb.path, 'text', record.textPath!), `\nOwner note about ${fact}.\n`)
          hashes.files[copy.path] = { ...record, protection: { revision: 1, sourceHash: record.hash, textPath: record.textPath!, scope: 'path', reason: 'Owner-maintained text.' } }
          writeFileSync(hashesPath(kb), JSON.stringify(hashes, null, 2))
          retainedFile = record.textPath
          rmSync(copy.openPath)
        })
        await expect.poll(() => existsSync(join(kb.path, '.ingest', 'retained', retainedFile!)), { timeout: 30000 }).toBe(true)
        window = page
      }
    } else {
      const folder = join(acceptanceApp.profile, `Watched ${change} ${randomUUID()}`)
      const file = sourceFile(folder, `${change}-watched.md`, `# Watched\n\nThe answer is ${fact}.\n`)
      sourceFile(folder, basename(kept), readFileSync(kept))
      await addWatchedFolder(window, kb, join(folder, 'Synthetic knowledge sources'))
      await expect.poll(async () => Object.fromEntries((await readKnowledgeFiles(window, kb.id)).map(f => [f.name, f.state])), { timeout: 30000 })
        .toEqual({ [basename(file)]: 'learned', [basename(kept)]: 'learned' })
      removedName = basename(file)
      if (change === 'deleted') rmSync(file)
      else {
        renamedTo = join(file, '..', `${change}-watched-new-name.md`)
        renameSync(file, renamedTo)
      }
      await expect.poll(async () => (await readKnowledgeFiles(window, kb.id)).map(f => f.name).sort(), { timeout: 30000 })
        .toEqual([basename(kept), ...(renamedTo ? [basename(renamedTo)] : [])].sort())
      if (renamedTo) await expect.poll(async () => (await readKnowledgeFiles(window, kb.id)).find(f => f.name === basename(renamedTo!))?.state, { timeout: 30000 }).toBe('learned')
    }

    const expectHits = renamedTo ? 1 : 0
    const assertRetired = async (page: Page) => {
      await expect.poll(() => searchableCorpus(kb).filter(entry => entry.text.includes(fact)).length, { timeout: 30000 }).toBe(expectHits)
      for (const entry of searchableCorpus(kb).filter(e => e.text.includes(fact))) {
        expect(entry.text.split('\n')[0]).toBe(`<!-- source: ${renamedTo} -->`)
      }
      expect(await readKnowledgeIndex(page, kb.id)).not.toContain(removedName)
      expect(searchableCorpus(kb).some(entry => entry.text.includes(keptFact))).toBe(true)
      const hashes = JSON.parse(readFileSync(hashesPath(kb), 'utf8')) as IngestHashesV1
      expect(Object.keys(hashes.files).some(key => basename(key) === removedName)).toBe(false)
      return askKnowledge(page, model, kb, fact, expectHits, removedName)
    }

    const before = await assertRetired(window)
    const reopened = await acceptanceApp.restart()
    const after = await assertRetired(reopened)
    if (originalOnDisk) expect(readFileSync(originalOnDisk, 'utf8')).toContain(fact)
    if (retainedFile) expect(readFileSync(join(kb.path, '.ingest', 'retained', retainedFile), 'utf8')).toContain(`Owner note about ${fact}.`)
    await info.attach('knowledge-retire-removed', {
      body: JSON.stringify({ change, kb: kb.id, removedName, renamedTo, retainedFile, grepBefore: before.grep, grepAfterRestart: after.grep }, null, 2),
      contentType: 'application/json',
    })
  })
}
