import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { Page } from '@playwright/test'
import type { AcceptanceApp } from './acceptance-app'
import type { HaloAPI } from '../../../src/preload'
import type { IngestHashesV1, KnowledgeBaseEntry, RawFileStatus } from '../../../src/shared/types/tlon'
import {
  assertImportedCopy, createKnowledgeBase, dropKnowledgeFiles, expect, extractedDocument,
  knowledgeFileRow, readKnowledgeBases, readKnowledgeFiles, readKnowledgeIndex, sourceFile, waitForKnowledgeFiles,
} from './acceptance-knowledge'
import { knowledgeDocument, type KnowledgeDocument } from './acceptance-knowledge-formats'
import { waitForHomePage } from './helpers'

export interface UpgradeKnowledge {
  kb: KnowledgeBaseEntry
  document: KnowledgeDocument
  source: string
  copied: RawFileStatus
  hashesPath: string
  textPath: string
  textRelativePath: string
  currentText: string
  expectedRevision: number
  marker: string
  wikiPath: string
  notePath: string
}

export type LegacyKnowledgeState = 'learned' | 'no-text' | 'edited' | 'current'

const curatedWiki = 'The owner and AI curated this note; a format upgrade must retain it.\n'
const independentText = 'This independently maintained text is unrelated to the spreadsheet.\n'

function confinedTo(directory: string, file: string) {
  const part = relative(realpathSync(directory), realpathSync(file))
  if (part === '..' || part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(part)) throw new Error('Refusing to seed knowledge state outside the isolated profile')
}

async function waitForKnowledgeReady(page: Page) {
  await waitForHomePage(page)
  await expect.poll(() => page.evaluate(async () => {
    try {
      const result = await (globalThis as unknown as { halo: HaloAPI }).halo.tlonList()
      return result.success ? { ready: true } : { ready: false, error: result.error }
    } catch (error) { return { ready: false, error: String(error) } }
  }), { timeout: 20000, message: 'The real knowledge IPC is registered after the background startup work begins' }).toMatchObject({ ready: true })
}

export function readUpgradeRecord(source: UpgradeKnowledge) {
  const hashes = JSON.parse(readFileSync(source.hashesPath, 'utf8')) as IngestHashesV1
  const record = hashes.files[source.copied.path]
  expect(record, 'The imported source must have its own persistent extraction record').toBeTruthy()
  return record
}

export async function prepareUpgradeKnowledge(app: AcceptanceApp, page: Page, role: 'control' | 'target', strings: 'shared' | 'cell' = 'shared'): Promise<UpgradeKnowledge> {
  expect(await app.app.evaluate(({ app }) => app.isPackaged), 'Upgrade coverage requires the controlled packaged application').toBe(true)
  await waitForKnowledgeReady(page)
  const marker = `Synthetic ${role} upgrade reference ${randomUUID()}`
  const generated = await knowledgeDocument('xlsx', marker, strings)
  const document = { ...generated, name: `${role}-${generated.name}` }
  const source = sourceFile(app.profile, document.name, document.bytes)
  const kb = await createKnowledgeBase(page, `${role === 'control' ? 'Control' : 'Target'} upgrade knowledge`)
  confinedTo(app.profile, kb.path)
  await dropKnowledgeFiles(page, [source])
  const copied = await assertImportedCopy(page, kb, source)
  await waitForKnowledgeFiles(page, kb.id, { [document.name]: 'learned' })
  const textPath = extractedDocument(await readKnowledgeIndex(page, kb.id), document.name)
  confinedTo(app.profile, copied.openPath)
  confinedTo(join(kb.path, 'text'), textPath)
  const currentText = readFileSync(textPath, 'utf8')
  for (const expected of document.expectedText) expect(currentText).toContain(expected)
  const hashesPath = join(kb.path, '.ingest', 'hashes.json')
  const record = (JSON.parse(readFileSync(hashesPath, 'utf8')) as IngestHashesV1).files[copied.path]
  expect(record.extractorRevision).toBeGreaterThan(0)
  expect(record.hash).toBe(createHash('sha256').update(document.bytes).digest('hex'))
  return {
    kb, document, source, copied, hashesPath, textPath, textRelativePath: record.textPath!, currentText,
    expectedRevision: record.extractorRevision!, marker,
    wikiPath: join(kb.path, 'wiki', 'curated-note.md'), notePath: join(kb.path, 'text', 'independent-note.txt'),
  }
}

/** Only called by restart's after-close hook, after a real UI import. */
export function seedOldKnowledge(profile: string, source: UpgradeKnowledge, state: LegacyKnowledgeState) {
  confinedTo(profile, source.kb.path)
  confinedTo(profile, source.source)
  confinedTo(profile, source.copied.openPath)
  confinedTo(profile, dirname(source.textPath))
  confinedTo(profile, dirname(source.hashesPath))
  if (existsSync(source.textPath)) confinedTo(profile, source.textPath)
  if (existsSync(dirname(source.wikiPath))) confinedTo(profile, dirname(source.wikiPath))
  expect(readFileSync(source.source)).toEqual(source.document.bytes)
  expect(readFileSync(source.copied.openPath)).toEqual(source.document.bytes)
  const hashes = JSON.parse(readFileSync(source.hashesPath, 'utf8')) as IngestHashesV1
  const hash = createHash('sha256').update(source.document.bytes).digest('hex')
  const legacyText = `<!-- source: ${source.copied.path} -->\n\nField\nValue\nReference\n${source.marker}\nQuantity`
  if (state === 'no-text') rmSync(source.textPath, { force: true })
  else if (state !== 'current') writeFileSync(source.textPath, state === 'edited' ? `${legacyText}\n\nOwner-maintained explanation: ${source.marker}.\n` : legacyText)
  hashes.files[source.copied.path] = {
    hash, ingestedAt: '2024-01-01T00:00:00.000Z',
    ...(state === 'no-text' ? { empty: true } : { textPath: source.textRelativePath }),
  }
  writeFileSync(source.hashesPath, JSON.stringify(hashes, null, 2))
  mkdirSync(dirname(source.wikiPath), { recursive: true })
  if (!existsSync(source.wikiPath)) writeFileSync(source.wikiPath, curatedWiki)
  if (!existsSync(source.notePath)) writeFileSync(source.notePath, independentText)
  expect(readUpgradeRecord(source).extractorRevision).toBeUndefined()
  expect(readUpgradeRecord(source).protection).toBeUndefined()
}

export function upgradeSnapshot(source: UpgradeKnowledge) {
  const stat = existsSync(source.textPath) ? statSync(source.textPath) : null
  return {
    text: stat ? readFileSync(source.textPath, 'utf8') : null,
    textMtime: stat?.mtimeMs ?? null, textIno: stat?.ino ?? null,
    hashes: readFileSync(source.hashesPath, 'utf8'), hashesMtime: statSync(source.hashesPath).mtimeMs,
  }
}

export function assertUpgradeSourcesRetained(source: UpgradeKnowledge) {
  expect(readFileSync(source.source)).toEqual(source.document.bytes)
  expect(readFileSync(source.copied.openPath)).toEqual(source.document.bytes)
  expect(readFileSync(source.wikiPath, 'utf8')).toBe(curatedWiki)
  expect(readFileSync(source.notePath, 'utf8')).toBe(independentText)
}

export async function openUpgradeKnowledge(page: Page, source: UpgradeKnowledge) {
  await waitForHomePage(page)
  await page.getByRole('button', { name: 'Knowledge Base', exact: true }).first().click()
  const back = page.getByRole('button', { name: 'Knowledge Bases', exact: true })
  if (await back.isVisible()) await back.click()
  const card = page.getByText(source.kb.name, { exact: true })
  await expect(card).toHaveCount(1)
  await card.click()
  await expect(page.getByRole('heading', { name: source.kb.name, exact: true })).toBeVisible()
}

export async function setKnowledgeLearning(page: Page, source: UpgradeKnowledge, enabled: boolean) {
  const files = page.getByRole('button', { name: 'Files', exact: true })
  await expect(files).toHaveCount(1)
  const tabs = files.locator('..')
  await tabs.getByRole('button', { name: 'Settings', exact: true }).click()
  const toggle = page.getByText('Keep learning', { exact: true }).locator('../..').getByRole('switch')
  await expect(toggle).toHaveAttribute('aria-checked', /^(true|false)$/)
  if (await toggle.getAttribute('aria-checked') !== String(enabled)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(enabled))
  await expect.poll(async () => (await readKnowledgeBases(page)).find(kb => kb.id === source.kb.id)?.status).toBe(enabled ? 'active' : 'paused')
  await files.click()
}

export async function waitForKnowledgeUpgrade(page: Page, source: UpgradeKnowledge) {
  await waitForKnowledgeReady(page)
  await expect.poll(() => readUpgradeRecord(source).extractorRevision, { timeout: 30000 }).toBe(source.expectedRevision)
  const files = await readKnowledgeFiles(page, source.kb.id)
  expect(files.find(file => file.path === source.copied.path)).toMatchObject({ state: 'learned', source: 'raw' })
  const record = readUpgradeRecord(source)
  expect(record.protection).toBeUndefined()
  expect(record.empty).toBeUndefined()
  expect(record.textPath).toBe(source.textRelativePath)
  const index = await readKnowledgeIndex(page, source.kb.id)
  expect(extractedDocument(index, source.document.name)).toBe(source.textPath)
  const text = readFileSync(source.textPath, 'utf8')
  for (const expected of source.document.expectedText) expect(text).toContain(expected)
  assertUpgradeSourcesRetained(source)
}

export async function assertUpgradeVisible(page: Page, source: UpgradeKnowledge) {
  await openUpgradeKnowledge(page, source)
  await waitForKnowledgeFiles(page, source.kb.id, { [source.document.name]: 'learned' })
  await expect(knowledgeFileRow(page, source.document.name)).toBeVisible()
}
