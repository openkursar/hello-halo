import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { KnowledgeBaseEntry, RawFileStatus } from '../../../src/shared/types/tlon'
import { expect } from './acceptance-app'
import { waitForHomePage } from './helpers'

export { test, expect, sendAcceptanceMessage, waitForAcceptanceIdle, readAcceptanceConversation } from './acceptance-app'

export function knowledgeAcceptance(caseId: string, mode: 'none' | 'scripted', variant: Record<string, string> = {}) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'app-e2e', mode, variant }) } }
}

export async function readKnowledgeBases(page: Page): Promise<KnowledgeBaseEntry[]> {
  const result = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.tlonList())
  expect(result.success).toBe(true)
  return result.data as KnowledgeBaseEntry[]
}

export async function readKnowledgeFiles(page: Page, id: string): Promise<RawFileStatus[]> {
  const result = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.tlonListRaw(id), id)
  expect(result.success).toBe(true)
  return result.data as RawFileStatus[]
}

export async function readKnowledgeIndex(page: Page, id: string): Promise<string> {
  const result = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.tlonReadIndex(id), id)
  expect(result.success).toBe(true)
  return result.data as string
}

export async function createKnowledgeBase(page: Page, name: string): Promise<KnowledgeBaseEntry> {
  await waitForHomePage(page)
  await page.getByRole('button', { name: 'Knowledge Base', exact: true }).first().click()
  const back = page.getByRole('button', { name: 'Knowledge Bases', exact: true })
  if (await back.isVisible()) await back.click()
  await page.getByRole('button', { name: 'New knowledge base', exact: true }).click()
  await page.getByPlaceholder('My knowledge base', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await expect.poll(async () => (await readKnowledgeBases(page)).filter(kb => kb.name === name).length).toBe(1)
  return (await readKnowledgeBases(page)).find(kb => kb.name === name)!
}

export function sourceFile(profile: string, name: string, content: string | Buffer): string {
  const directory = join(profile, 'Synthetic knowledge sources')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, name)
  writeFileSync(file, content)
  return file
}

interface DropObservation { names: string[]; paths: string[] }

export async function dropKnowledgeFiles(page: Page, files: string[]): Promise<DropObservation> {
  const zone = page.getByText('Drop files or folders here', { exact: true }).locator('..')
  await zone.scrollIntoViewIfNeeded()
  const box = await zone.boundingBox()
  expect(box, 'The production knowledge drop zone must be visible').not.toBeNull()
  await page.evaluate(() => {
    const state = globalThis as unknown as { halo: HaloAPI; acceptanceKnowledgeDrop?: DropObservation }
    delete state.acceptanceKnowledgeDrop
    document.addEventListener('drop', event => {
      const files = Array.from(event.dataTransfer?.files ?? [])
      state.acceptanceKnowledgeDrop = {
        names: files.map(file => file.name),
        paths: files.map(file => state.halo.getPathForFile(file)),
      }
    }, { once: true, capture: true })
  })
  const session = await page.context().newCDPSession(page)
  try {
    const data = { items: [], files, dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await session.send('Input.dispatchDragEvent', { type, x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, data })
    }
  } finally { await session.detach() }
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { acceptanceKnowledgeDrop?: DropObservation }).acceptanceKnowledgeDrop?.names)).toEqual(files.map(file => basename(file)))
  const observed = await page.evaluate(() => (globalThis as unknown as { acceptanceKnowledgeDrop: DropObservation }).acceptanceKnowledgeDrop)
  expect(observed.paths.map(path => realpathSync(path))).toEqual(files.map(path => realpathSync(path)))
  return observed
}

export function knowledgeFileRow(page: Page, name: string) {
  return page.locator('div.group').filter({ has: page.getByText(name, { exact: true }) })
}

export async function waitForKnowledgeFiles(page: Page, id: string, expected: Record<string, RawFileStatus['state']>) {
  await expect.poll(async () => Object.fromEntries((await readKnowledgeFiles(page, id)).map(file => [file.name, file.state])), { timeout: 30000 }).toEqual(expected)
  await expect(page.getByRole('heading', { name: 'Learned', exact: true })).toBeVisible()
}

export async function assertImportedCopy(page: Page, kb: KnowledgeBaseEntry, source: string) {
  const name = basename(source)
  await expect.poll(async () => (await readKnowledgeFiles(page, kb.id)).filter(file => file.name === name).length).toBe(1)
  const copied = (await readKnowledgeFiles(page, kb.id)).find(file => file.name === name)!
  expect(copied.source).toBe('raw')
  expect(resolve(copied.openPath)).toBe(resolve(kb.path, 'raw', name))
  expect(resolve(copied.openPath)).not.toBe(resolve(source))
  expect(readFileSync(copied.openPath)).toEqual(readFileSync(source))
  await expect(knowledgeFileRow(page, name)).toBeVisible()
  return copied
}

export function extractedDocument(index: string, name: string): string {
  const line = index.split('\n').find(line => line.startsWith(`- **${name}**`))
  const target = line?.match(/ — `([^`]+)`$/)?.[1]
  expect(target, 'The real document map must name the extracted source path').toBeTruthy()
  return target!
}

export function blankPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}
