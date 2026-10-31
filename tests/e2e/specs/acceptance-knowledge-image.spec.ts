import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { Page } from '@playwright/test'
import { toHaloFileUrl } from '../../../src/shared/halo-file-url'
import {
  test, expect, knowledgeAcceptance, createKnowledgeBase, sourceFile, dropKnowledgeFiles,
  assertImportedCopy, waitForKnowledgeFiles, readKnowledgeFiles, readKnowledgeIndex,
  extractedDocument, knowledgeFileRow,
} from '../fixtures/acceptance-knowledge'
import { waitForHomePage } from '../fixtures/helpers'

test.setTimeout(120000)

function inspectOcrResources(resources: string, appPath: string) {
  const diskRoot = appPath.endsWith('.asar') ? `${appPath}.unpacked` : appPath
  const files = [
    join(resources, 'ocr/tessdata/eng.traineddata'),
    join(resources, 'ocr/tessdata/chi_sim.traineddata'),
    join(diskRoot, 'node_modules/tesseract.js/src/worker-script/node/index.js'),
    join(diskRoot, 'node_modules/tesseract.js/src/worker-script/node/getCore.js'),
    ...['tesseract-core-lstm', 'tesseract-core-simd-lstm'].flatMap(core => [
      join(diskRoot, `node_modules/tesseract.js-core/${core}.js`),
      join(diskRoot, `node_modules/tesseract.js-core/${core}.wasm`),
    ]),
  ]
  return files.map(file => {
    // Missing language data can make the dependency download a replacement; refuse it before OCR starts.
    const content = readFileSync(file)
    expect(content.length, `The packaged OCR resource must be readable and nonempty: ${relative(resources, file)}`).toBeGreaterThan(0)
    return { path: relative(resources, file), bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }
  })
}

async function sourceImage(page: Page): Promise<Buffer> {
  const data = await page.evaluate(async () => {
    await document.fonts.ready
    const canvas = document.createElement('canvas')
    canvas.width = 960
    canvas.height = 320
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The isolated renderer could not create the synthetic image')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#000000'
    context.font = 'bold 64px sans-serif'
    context.textBaseline = 'top'
    const lines = ['CEDAR REPORT', 'TOTAL 8642']
    for (const [index, line] of lines.entries()) {
      if (context.measureText(line).width > 840) throw new Error('Synthetic OCR text would be clipped')
      context.fillText(line, 60, 60 + index * 110)
    }
    return canvas.toDataURL('image/png')
  })
  expect(data).toMatch(/^data:image\/png;base64,/)
  return Buffer.from(data.slice(data.indexOf(',') + 1), 'base64')
}

function recognizedText(text: string) {
  const body = text.replace(/^<!-- source: [^\r\n]+ -->\r?\n\r?\n/, '')
  return body.trim().replace(/\s+/g, ' ').toUpperCase()
}

async function previewImage(page: Page, name: string, copyPath: string) {
  await knowledgeFileRow(page, name).click()
  await expect(page.locator('.canvas-tab.active')).toContainText(name)
  const image = page.getByRole('img', { name, exact: true })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => {
    const image = element as HTMLImageElement
    return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }
  })).toEqual({ complete: true, width: 960, height: 320 })
  expect((await image.getAttribute('src'))?.split('?')[0]).toBe(toHaloFileUrl(copyPath))
}

test('a dropped PNG is recognized by packaged local OCR and its text and preview survive restart', knowledgeAcceptance('knowledge.sources.import', 'none', { format: 'image' }), async ({ acceptanceApp, model, window }, info) => {
  const runtime = await acceptanceApp.app.evaluate(({ app }) => ({ packaged: app.isPackaged, resources: process.resourcesPath, appPath: app.getAppPath() }))
  expect(runtime.packaged, 'Image import requires the controlled packaged application').toBe(true)
  const resources = inspectOcrResources(runtime.resources, runtime.appPath)
  await info.attach('packaged-ocr-resources', { body: JSON.stringify(resources, null, 2), contentType: 'application/json' })
  const png = await sourceImage(window)
  const source = sourceFile(acceptanceApp.profile, 'source-image.png', png)
  await info.attach('ocr-source-image', { body: png, contentType: 'image/png' })
  const kb = await createKnowledgeBase(window, 'Image recognition knowledge')
  const drop = await dropKnowledgeFiles(window, [source])
  const copy = await assertImportedCopy(window, kb, source)
  await waitForKnowledgeFiles(window, kb.id, { [basename(source)]: 'learned' })
  const index = await readKnowledgeIndex(window, kb.id)
  const text = readFileSync(extractedDocument(index, basename(source)), 'utf8')
  await info.attach('actual-ocr-extraction', { body: JSON.stringify({ drop, files: await readKnowledgeFiles(window, kb.id), index, text }, null, 2), contentType: 'application/json' })
  expect(recognizedText(text)).toBe('CEDAR REPORT TOTAL 8642')
  await previewImage(window, basename(source), copy.openPath)
  const reopened = await acceptanceApp.restart()
  await waitForHomePage(reopened)
  await reopened.getByRole('button', { name: 'Knowledge Base', exact: true }).first().click()
  await reopened.getByText(kb.name, { exact: true }).click()
  await expect(reopened.getByRole('heading', { name: kb.name, exact: true })).toBeVisible()
  await waitForKnowledgeFiles(reopened, kb.id, { [basename(source)]: 'learned' })
  const restoredIndex = await readKnowledgeIndex(reopened, kb.id)
  const restoredText = readFileSync(extractedDocument(restoredIndex, basename(source)), 'utf8')
  expect(restoredText).toBe(text)
  expect(recognizedText(restoredText)).toBe('CEDAR REPORT TOTAL 8642')
  expect(readFileSync(copy.openPath)).toEqual(png)
  expect(readFileSync(source)).toEqual(png)
  await previewImage(reopened, basename(source), copy.openPath)
  expect(inspectOcrResources(runtime.resources, runtime.appPath)).toEqual(resources)
  expect(model.exchanges, 'Image learning must use local OCR without any model request').toEqual([])
})
