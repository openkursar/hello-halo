import { readFileSync } from 'node:fs'
import { test, expect, knowledgeAcceptance, createKnowledgeBase, sourceFile, dropKnowledgeFiles, assertImportedCopy, waitForKnowledgeFiles, readKnowledgeIndex, extractedDocument } from '../fixtures/acceptance-knowledge'
import { assertPackagedWithoutNativeCanvas, distributionPdf, pdfDistributionText, validateDistributionPdf } from '../fixtures/acceptance-pdf-distribution'

test.setTimeout(120000)

test('packaged knowledge extraction retains Chinese and both PDF pages without native canvas', knowledgeAcceptance('knowledge.sources.pdf-distribution', 'none'), async ({ acceptanceApp, model, window }, info) => {
  const inventory = await assertPackagedWithoutNativeCanvas(acceptanceApp.app)
  const document = distributionPdf()
  await validateDistributionPdf(document.bytes)
  const source = sourceFile(acceptanceApp.profile, document.name, document.bytes)
  const kb = await createKnowledgeBase(window, 'PDF distribution knowledge')
  await dropKnowledgeFiles(window, [source])
  const copy = await assertImportedCopy(window, kb, source)
  await waitForKnowledgeFiles(window, kb.id, { [document.name]: 'learned' })
  const extracted = extractedDocument(await readKnowledgeIndex(window, kb.id), document.name)
  const text = readFileSync(extracted, 'utf8')
  for (const expected of pdfDistributionText) expect(text).toContain(expected)
  await acceptanceApp.restart()
  expect(readFileSync(extracted, 'utf8')).toBe(text)
  expect(readFileSync(source)).toEqual(document.bytes)
  expect(readFileSync(copy.openPath)).toEqual(document.bytes)
  expect(model.exchanges).toEqual([])
  await info.attach('pdf-knowledge-observations', { body: JSON.stringify({ inventory, text }, null, 2), contentType: 'application/json' })
})
