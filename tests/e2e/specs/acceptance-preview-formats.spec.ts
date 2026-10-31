import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from '@playwright/test'
import { toHaloFileUrl } from '../../../src/shared/halo-file-url'
import { test, expect, managementAcceptance } from '../fixtures/acceptance-management'
import { cropPreviewFrame, decodePreviewPattern, previewDocument, previewImageSamples, previewQuantity, type DomPreviewFormat } from '../fixtures/acceptance-preview-formats'
import { previewPdf, previewPresentation } from '../fixtures/acceptance-preview-documents'
import { guestIdentity } from '../fixtures/browser-site'
import { navigateToChat } from '../fixtures/helpers'
import { clickArtifactByName } from '../../perf/lib/open-artifact'

test.setTimeout(90000)

function seedPreview(profile: string, document: { name: string; bytes: Buffer }) {
  const directory = join(profile, '.halo', 'temp', 'artifacts')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, document.name)
  const control = join(directory, 'unopened-preview-control.txt')
  const controlBytes = Buffer.from('Keep the unrelated preview control unchanged.\n')
  writeFileSync(file, document.bytes)
  writeFileSync(control, controlBytes)
  return {
    file,
    assertUnchanged() {
      expect(readFileSync(file).equals(document.bytes)).toBe(true)
      expect(readFileSync(control).equals(controlBytes)).toBe(true)
    },
  }
}

async function checkDomPreview(window: Page, format: DomPreviewFormat, marker: string, file: string, source: Buffer) {
  if (format === 'markdown') {
    const preview = window.locator('.prose').filter({ has: window.getByRole('heading', { name: 'Preview report', exact: true }) })
    await expect(preview.getByRole('heading', { name: 'Preview report', exact: true })).toBeVisible()
    await expect(preview.locator('[data-streamdown="strong"]')).toBeVisible()
    await expect(preview.locator('[data-streamdown="strong"]')).toHaveText(marker)
    await expect(preview.getByRole('listitem')).toHaveText([`Quantity: ${previewQuantity}`, 'Status: ready'])
    return
  }
  if (format === 'code' || format === 'json') {
    const editor = window.locator('.cm-editor')
    await expect(editor).toHaveCount(1)
    await expect(editor.locator('.cm-line')).toHaveText(source.toString('utf8').split('\n'))
    await expect(window.locator('.font-mono').filter({ hasText: format === 'json' ? /^json$/ : /^typescript$/ })).toBeVisible()
    await expect(window.getByTitle('Edit file', { exact: true })).toBeVisible()
    if (format === 'json') expect(JSON.parse((await editor.locator('.cm-line').allTextContents()).join('\n'))).toEqual({ reference: marker, quantity: Number(previewQuantity), ready: true })
    return
  }
  if (format === 'html') {
    const iframe = window.locator('iframe[title="preview-reference.html"]')
    await expect(iframe).toBeVisible()
    const preview = window.frameLocator('iframe[title="preview-reference.html"]')
    await expect(preview.getByRole('heading', { name: 'Offline knowledge reference', exact: true })).toBeVisible()
    await expect(preview.locator('p')).toHaveText(marker)
    await expect(preview.locator('dd')).toHaveText(previewQuantity)
    const src = await iframe.getAttribute('src')
    expect(src).toMatch(/^halo-preview:/)
    expect(decodeURIComponent(new URL(src!).pathname.slice(1))).toBe('preview-reference.html')
    return
  }
  if (format === 'image') {
    const image = window.getByRole('img', { name: 'preview-reference.png', exact: true })
    await expect(image).toBeVisible()
    await expect(image).toHaveCSS('opacity', '1')
    await expect.poll(() => image.evaluate(element => {
      const image = element as HTMLImageElement
      return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }
    })).toEqual({ complete: true, width: 320, height: 192 })
    expect((await image.getAttribute('src'))?.split('?')[0]).toBe(toHaloFileUrl(file))
    const samples = previewImageSamples(await image.screenshot())
    const expected = [[224, 24, 48, 255], [16, 144, 80, 255], [24, 96, 224, 255], [0, 0, 0, 255], [255, 255, 255, 255]]
    for (let index = 0; index < expected.length; index++) for (let channel = 0; channel < 4; channel++) expect(Math.abs(samples[index][channel] - expected[index][channel])).toBeLessThanOrEqual(2)
    return
  }
  if (format === 'docx') {
    const pages = window.locator('.docx-wrapper > section.docx')
    await expect(pages.first()).toBeVisible()
    await expect(pages.getByText(marker, { exact: true })).toBeVisible()
    await expect(pages.getByText(`Quantity: ${previewQuantity}`, { exact: true })).toBeVisible()
    await expect(pages.getByText('Review: Alpha & Beta < Gamma', { exact: true })).toBeVisible()
    return
  }
  await expect(window.locator('.font-mono').filter({ hasText: format === 'csv' ? /^CSV$/ : /^XLSX$/ })).toBeVisible()
  const table = window.getByRole('table')
  await expect(table).toHaveCount(1)
  await expect(table.getByRole('row').filter({ hasText: marker }).getByRole('cell').last()).toBeVisible()
  await expect(table.getByRole('row').filter({ hasText: marker }).getByRole('cell').last()).toHaveText(marker)
  await expect(table.getByRole('row').filter({ hasText: 'Quantity' }).getByRole('cell').last()).toBeVisible()
  await expect(table.getByRole('row').filter({ hasText: 'Quantity' }).getByRole('cell').last()).toHaveText(previewQuantity)
  if (format === 'csv') {
    await expect(table.getByRole('columnheader')).toContainText(['#', 'Field', 'Value'])
    await expect(window.getByTitle('Table view', { exact: true })).toBeVisible()
  } else {
    await expect(table.getByRole('columnheader')).toHaveText(['#', 'A', 'B'])
    await expect(table.getByRole('row').filter({ hasText: 'Field' }).getByRole('cell')).toHaveText(['1', 'Field', 'Value'])
  }
}

for (const format of ['markdown', 'code', 'html', 'image', 'json', 'csv', 'docx', 'xlsx'] as const) {
  test(`a ${format} file opens in its actual viewer with recognizable content and unchanged source bytes`, managementAcceptance('files.preview.formats', { format }), async ({ managementApp, window }, info) => {
    const marker = `Preview-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const document = await previewDocument(format, marker)
    const seeded = seedPreview(managementApp.profile, document)
    await window.setViewportSize({ width: 1600, height: 1000 })
    await navigateToChat(window)
    await clickArtifactByName(window, document.name)
    await expect(window.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(document.name)
    await checkDomPreview(window, format, marker, seeded.file, document.bytes)
    seeded.assertUnchanged()
    await info.attach('preview-input', { body: document.bytes, contentType: format === 'image' ? 'image/png' : 'application/octet-stream' })
    await info.attach('preview-content', { body: await window.screenshot(), contentType: 'image/png' })
  })
}

test('a PDF opened from the rail paints its complete encoded fixture pattern in the native PDF guest', managementAcceptance('files.preview.formats', { format: 'pdf' }), async ({ managementApp, window }, info) => {
  const document = previewPdf(randomUUID().replaceAll('-', ''))
  const seeded = seedPreview(managementApp.profile, document)
  const { getDocumentProxy, extractText } = await import('unpdf')
  const parsed = await getDocumentProxy(new Uint8Array(readFileSync(seeded.file)))
  try {
    expect(parsed.numPages).toBe(1)
    const extracted = await extractText(parsed, { mergePages: true })
    expect(extracted.text).toContain(document.marker)
    expect(extracted.text).toContain(previewQuantity)
  } finally { await parsed.destroy() }
  await info.attach('preview-input', { body: document.bytes, contentType: 'application/pdf' })
  await window.setViewportSize({ width: 1600, height: 1000 })
  await navigateToChat(window)
  await clickArtifactByName(window, document.name)
  await expect(window.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(document.name)
  const url = pathToFileURL(seeded.file).href
  await expect.poll(() => guestIdentity(managementApp.app, url)).toBeGreaterThan(0)
  const id = await guestIdentity(managementApp.app, url)
  const readVisibleGuest = async () => {
    const views = await window.locator('webview').evaluateAll((elements, id) => elements.flatMap(element => {
      const guest = element as HTMLElement & { getWebContentsId: () => number }
      if (guest.getWebContentsId() !== id) return []
      return [{ connected: guest.isConnected, pageId: guest.dataset.browserPageId, bounds: guest.getBoundingClientRect().toJSON() }]
    }), id)
    expect(views).toHaveLength(1)
    expect(views[0].connected).toBe(true)
    expect(views[0].pageId).toBeTruthy()
    const view = window.locator(`webview[data-browser-page-id="${views[0].pageId}"]`)
    await expect(view).toBeVisible()
    await expect(view).toHaveAttribute('aria-hidden', 'false')
    await expect(view).toHaveCSS('opacity', '1')
    await expect(view).toBeInViewport()
    const bounds = await view.boundingBox()
    expect(bounds).not.toBeNull()
    const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(bounds!.width).toBeGreaterThan(100)
    expect(bounds!.height).toBeGreaterThan(100)
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1)
    return { ...views[0], bounds: bounds!, viewport }
  }
  const initialView = await readVisibleGuest()
  let lastImage: Buffer | undefined
  let visibleFrame: Buffer | undefined
  let visibleImage: Buffer | undefined
  let visibleCrop: Omit<ReturnType<typeof cropPreviewFrame>, 'bytes'> | undefined
  let decoded: ReturnType<typeof decodePreviewPattern> = null
  let visibleDecoded: ReturnType<typeof decodePreviewPattern> = null
  try {
    await expect.poll(async () => {
      const data = await managementApp.app.evaluate(async ({ webContents }, { id, url }) => {
        const guest = webContents.fromId(id)
        const canonical = (value: string) => value.replace(/^file:\/\/\/private\/var\//, 'file:///var/')
        if (!guest || guest.getType() !== 'webview' || canonical(guest.getURL()) !== canonical(url)) throw new Error('The PDF capture no longer belongs to the selected local file')
        return (await guest.capturePage()).toPNG().toString('base64')
      }, { id, url })
      lastImage = Buffer.from(data, 'base64')
      decoded = decodePreviewPattern(lastImage, document.palette)
      return decoded?.pattern ?? null
    }, { timeout: 20000, intervals: [250, 500, 1000] }).toEqual(document.pattern)
    await expect.poll(async () => {
      const view = await readVisibleGuest()
      expect(view.pageId).toBe(initialView.pageId)
      // CDP clip origins shift under Electron viewport scaling; crop the full frame's actual pixels.
      visibleFrame = await window.screenshot()
      const { bytes, ...crop } = cropPreviewFrame(visibleFrame, view.viewport, view.bounds)
      visibleImage = bytes
      visibleCrop = crop
      visibleDecoded = decodePreviewPattern(visibleImage, document.palette)
      return visibleDecoded?.pattern ?? null
    }, { timeout: 10000, intervals: [250, 500, 1000] }).toEqual(document.pattern)
    seeded.assertUnchanged()
  } finally {
    if (lastImage) await info.attach('native-pdf-content', { body: lastImage, contentType: 'image/png' })
    if (visibleFrame) await info.attach('visible-pdf-window', { body: visibleFrame, contentType: 'image/png' })
    if (visibleImage) await info.attach('visible-pdf-content', { body: visibleImage, contentType: 'image/png' })
    await info.attach('pdf-pattern-observation', { body: JSON.stringify({ marker: document.marker, expected: document.pattern, decoded, visibleDecoded, visibleCrop, initialView, guestId: id, file: seeded.file }, null, 2), contentType: 'application/json' })
  }
})

test('a presentation clearly reports the unsupported preview and offers actions without changing the file', managementAcceptance('files.preview.unsupported-presentation'), async ({ managementApp, window }, info) => {
  const document = await previewPresentation(randomUUID().replaceAll('-', ''))
  const seeded = seedPreview(managementApp.profile, document)
  await navigateToChat(window)
  await clickArtifactByName(window, document.name)
  await expect(window.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(document.name)
  await expect(window.getByText('Presentation preview is not supported yet', { exact: true })).toBeVisible()
  await expect(window.getByText('You can open this file in an external application.', { exact: true })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Open in external application', exact: true })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Open in external application', exact: true })).toBeEnabled()
  await expect(window.getByRole('button', { name: 'Download', exact: true })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Download', exact: true })).toBeEnabled()
  seeded.assertUnchanged()
  await info.attach('preview-input', { body: document.bytes, contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
  await info.attach('unsupported-presentation', { body: await window.screenshot(), contentType: 'image/png' })
})
