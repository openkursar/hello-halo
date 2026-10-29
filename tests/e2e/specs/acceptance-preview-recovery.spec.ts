import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, managementAcceptance, seedManagedSpace, workspaceCard, type ManagedSpace } from '../fixtures/acceptance-management'
import { previewDocument, previewQuantity } from '../fixtures/acceptance-preview-formats'
import { damagedPreviewDocument } from '../fixtures/acceptance-preview-recovery'
import { navigateToChat, navigateToWorkspaces } from '../fixtures/helpers'
import { clickArtifactByName, openWorkspaceRail } from '../../perf/lib/open-artifact'

test.setTimeout(120000)

async function openPreviewWorkspace(window: Page, space: ManagedSpace) {
  await navigateToWorkspaces(window)
  const card = workspaceCard(window, space.name)
  await expect(card).toHaveCount(1)
  await card.click()
  await expect(window.getByTitle(`Current workspace: ${space.name} — click to switch`, { exact: true })).toBeVisible()
  await openWorkspaceRail(window)
  await expect(window.getByRole('tree')).toHaveCount(1)
}

async function readWatchedMarkdown(window: Page, name: string, marker: string) {
  await clickArtifactByName(window, name)
  await expect(window.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(name)
  const preview = window.locator('.prose').filter({ has: window.getByRole('heading', { name: 'Preview report', exact: true }) })
  await expect(preview.getByRole('heading', { name: 'Preview report', exact: true })).toBeVisible()
  await expect(preview.locator('[data-streamdown="strong"]')).toBeVisible()
  await expect(preview.locator('[data-streamdown="strong"]')).toHaveText(marker)
  await expect(preview.getByRole('listitem')).toHaveText([`Quantity: ${previewQuantity}`, 'Status: ready'])
}

async function closePreviewTab(window: Page, name: string, controlName: string) {
  const tab = window.locator('.canvas-tab').filter({ has: window.getByTitle(name, { exact: true }) })
  await expect(tab).toHaveCount(1)
  await tab.locator('button.canvas-tab-close').click()
  await expect(tab).toHaveCount(0)
  await expect(window.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(controlName)
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

test('real file creation, rename and removal update the visible workspace rail without changing another workspace', managementAcceptance('files.preview.watcher'), async ({ managementApp, window }, info) => {
  const firstDirectory = join(managementApp.profile, 'watched workspace')
  const otherDirectory = join(managementApp.profile, 'control workspace')
  mkdirSync(firstDirectory)
  mkdirSync(otherDirectory)
  const firstMarker = `Watched-${randomUUID().slice(0, 8)}`
  const otherMarker = `Control-${randomUUID().slice(0, 8)}`
  const firstDocument = await previewDocument('markdown', firstMarker)
  const otherDocument = await previewDocument('markdown', otherMarker)
  const initialName = 'shared-note.md'
  const renamedName = 'renamed-note.md'
  const firstPath = join(firstDirectory, initialName)
  const renamedPath = join(firstDirectory, renamedName)
  const otherPath = join(otherDirectory, initialName)
  const firstSentinel = join(firstDirectory, 'watched-control.txt')
  const otherSentinel = join(otherDirectory, 'other-control.txt')
  const sentinelBytes = new Map([
    [firstSentinel, Buffer.from('The watched workspace keeps its original control file.\n')],
    [otherSentinel, Buffer.from('The other workspace keeps its original control file.\n')],
  ])
  for (const [file, bytes] of sentinelBytes) writeFileSync(file, bytes)
  writeFileSync(otherPath, otherDocument.bytes)
  const observations: Array<Record<string, unknown>> = []
  const checkControls = () => {
    for (const [file, bytes] of sentinelBytes) expect(readFileSync(file).equals(bytes)).toBe(true)
    expect(readFileSync(otherPath).equals(otherDocument.bytes)).toBe(true)
    expect(readdirSync(otherDirectory).sort()).toEqual(['other-control.txt', initialName].sort())
  }
  const record = (phase: string) => observations.push({ phase, watchedFiles: readdirSync(firstDirectory).sort(), otherFiles: readdirSync(otherDirectory).sort(), otherDocumentHash: sha256(readFileSync(otherPath)) })
  try {
    const firstSpace = await seedManagedSpace(window, 'Watched files', firstDirectory)
    const otherSpace = await seedManagedSpace(window, 'Independent files', otherDirectory)
    await window.setViewportSize({ width: 1600, height: 1000 })
    await openPreviewWorkspace(window, otherSpace)
    await expect(window.getByRole('treeitem', { name: initialName, exact: true })).toBeVisible()
    await clickArtifactByName(window, 'other-control.txt')
    await expect(window.locator('.cm-content:visible')).toContainText(sentinelBytes.get(otherSentinel)!.toString('utf8').trim())
    await readWatchedMarkdown(window, initialName, otherMarker)
    await closePreviewTab(window, initialName, 'other-control.txt')
    await openPreviewWorkspace(window, firstSpace)
    await expect(window.getByRole('treeitem', { name: 'watched-control.txt', exact: true })).toBeVisible()
    await expect(window.getByRole('treeitem', { name: initialName, exact: true })).toHaveCount(0)
    await expect(window.getByRole('treeitem', { name: 'other-control.txt', exact: true })).toHaveCount(0)
    await clickArtifactByName(window, 'watched-control.txt')
    await expect(window.locator('.cm-content:visible')).toContainText(sentinelBytes.get(firstSentinel)!.toString('utf8').trim())

    writeFileSync(firstPath, firstDocument.bytes)
    await expect(window.getByRole('treeitem', { name: initialName, exact: true })).toBeVisible()
    await readWatchedMarkdown(window, initialName, firstMarker)
    expect(readFileSync(firstPath).equals(firstDocument.bytes)).toBe(true)
    checkControls()
    record('created')
    await closePreviewTab(window, initialName, 'watched-control.txt')

    renameSync(firstPath, renamedPath)
    await expect(window.getByRole('treeitem', { name: initialName, exact: true })).toHaveCount(0)
    await expect(window.getByRole('treeitem', { name: renamedName, exact: true })).toBeVisible()
    await readWatchedMarkdown(window, renamedName, firstMarker)
    expect(existsSync(firstPath)).toBe(false)
    expect(readFileSync(renamedPath).equals(firstDocument.bytes)).toBe(true)
    checkControls()
    record('renamed')
    await closePreviewTab(window, renamedName, 'watched-control.txt')

    rmSync(renamedPath)
    await expect(window.getByRole('treeitem', { name: renamedName, exact: true })).toHaveCount(0)
    await expect(window.getByRole('treeitem', { name: initialName, exact: true })).toHaveCount(0)
    await expect(window.getByRole('treeitem', { name: 'watched-control.txt', exact: true })).toBeVisible()
    expect(readdirSync(firstDirectory)).toEqual(['watched-control.txt'])
    checkControls()
    record('removed')

    await openPreviewWorkspace(window, otherSpace)
    await expect(window.getByRole('treeitem', { name: initialName, exact: true })).toBeVisible()
    await expect(window.getByRole('treeitem', { name: renamedName, exact: true })).toHaveCount(0)
    await expect(window.getByRole('treeitem', { name: 'watched-control.txt', exact: true })).toHaveCount(0)
    await readWatchedMarkdown(window, initialName, otherMarker)
    await closePreviewTab(window, initialName, 'other-control.txt')
    await openPreviewWorkspace(window, firstSpace)
    await expect(window.getByRole('treeitem', { name: 'watched-control.txt', exact: true })).toBeVisible()
    for (const name of [initialName, renamedName, 'other-control.txt']) await expect(window.getByRole('treeitem', { name, exact: true })).toHaveCount(0)
    checkControls()
    record('returned-to-watched-workspace')
  } finally {
    await info.attach('filesystem-watcher-observations', { body: JSON.stringify({ observations, createdDocumentHash: sha256(firstDocument.bytes), untouchedDocumentHash: sha256(otherDocument.bytes) }, null, 2), contentType: 'application/json' })
  }
})

test('a damaged Word document reports an actionable failure and a valid document still renders in the same application', managementAcceptance('files.preview.corrupt'), async ({ managementApp, window }, info) => {
  const marker = `Recovered-${randomUUID().slice(0, 8)}`
  const documents = await damagedPreviewDocument(marker)
  const directory = join(managementApp.profile, '.halo', 'temp', 'artifacts')
  mkdirSync(directory, { recursive: true })
  const files = new Map([
    [join(directory, documents.valid.name), documents.valid.bytes],
    [join(directory, documents.damaged.name), documents.damaged.bytes],
    [join(directory, 'preview-recovery-control.txt'), Buffer.from('Leave this independent preview control unchanged.\n')],
  ])
  for (const [file, bytes] of files) writeFileSync(file, bytes)
  const pageErrors: string[] = []
  const onPageError = (error: Error) => { pageErrors.push(error.message) }
  window.on('pageerror', onPageError)
  try {
    await navigateToChat(window)
    await clickArtifactByName(window, documents.damaged.name)
    await expect(window.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(documents.damaged.name)
    await expect(window.getByText('Unable to preview this document', { exact: true })).toBeVisible()
    await expect(window.getByText('The file may be corrupt or in an unsupported format.', { exact: true })).toBeVisible()
    for (const name of ['Open in external application', 'Download']) {
      await expect(window.getByRole('button', { name, exact: true })).toBeVisible()
      await expect(window.getByRole('button', { name, exact: true })).toBeEnabled()
    }
    await expect(window.locator('.docx-wrapper > section.docx')).toHaveCount(0)
    for (const [file, bytes] of files) expect(readFileSync(file).equals(bytes)).toBe(true)
    await info.attach('damaged-document-feedback', { body: await window.screenshot(), contentType: 'image/png' })

    await clickArtifactByName(window, documents.valid.name)
    await expect(window.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(documents.valid.name)
    const pages = window.locator('.docx-wrapper > section.docx')
    await expect(pages.first()).toBeVisible()
    await expect(pages.getByText(marker, { exact: true })).toBeVisible()
    await expect(pages.getByText(`Quantity: ${previewQuantity}`, { exact: true })).toBeVisible()
    await expect(pages.getByText('Review: Alpha & Beta < Gamma', { exact: true })).toBeVisible()
    await expect(window.getByText('Unable to preview this document', { exact: true })).toHaveCount(0)
    expect(pageErrors).toEqual([])
    for (const [file, bytes] of files) expect(readFileSync(file).equals(bytes)).toBe(true)
    await info.attach('valid-document-after-failure', { body: await window.screenshot(), contentType: 'image/png' })
  } finally {
    window.removeListener('pageerror', onPageError)
    await info.attach('document-preview-recovery', { body: JSON.stringify({ marker, pageErrors, documents: [...files].map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: sha256(bytes), unchanged: existsSync(file) && readFileSync(file).equals(bytes) })) }, null, 2), contentType: 'application/json' })
  }
})
