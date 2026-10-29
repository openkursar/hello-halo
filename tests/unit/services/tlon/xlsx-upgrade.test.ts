import fs from 'node:fs'
import { readdirSync as observedReaddirSync } from 'fs'
import path from 'node:path'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDir } from '../../setup'

vi.mock('@parcel/watcher', () => ({ default: { subscribe: vi.fn(async () => ({ unsubscribe: vi.fn(async () => {}) })) } }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))

let extractionGate: Promise<void> | null = null
let extractionCalls = 0
let legacyCalls = 0
let afterTemporaryWrite: (() => void) | null = null
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, readdirSync: vi.fn(actual.readdirSync), writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
    actual.writeFileSync(...args)
    if (afterTemporaryWrite && typeof args[0] === 'number') {
      const callback = afterTemporaryWrite
      afterTemporaryWrite = null
      callback()
    }
  } }
})
vi.mock('../../../../src/main/services/tlon/extract', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../src/main/services/tlon/extract')>()
  return { ...actual, extractText: async (name: string, bytes: Buffer) => {
    extractionCalls++
    if (extractionGate) await extractionGate
    return actual.extractText(name, bytes)
  } }
})
vi.mock('../../../../src/main/services/tlon/legacy-xlsx', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../src/main/services/tlon/legacy-xlsx')>()
  return { ...actual, legacyXlsxTextHash: async (bytes: Buffer, name: string) => {
    legacyCalls++
    return actual.legacyXlsxTextHash(bytes, name)
  } }
})

import { initializeApp } from '../../../../src/main/foundation/config.service'
import {
  _resetTlonHashCache, _resetTlonRegistry, addRawFiles, collectIngestCandidates, createKB,
  deleteKB, getRawFileLearnedStatus, readHashes, removeRawFile, sha256, updateKB, writeHashes,
} from '../../../../src/main/services/tlon/service'
import { migrateKBsToTextIndex, triggerFullIngest } from '../../../../src/main/services/tlon/ingest'
import { getKBDir, getKBHashesPath, getKBIndexMdPath, getKBTextDir, getKBRawDir, getKBWikiDir } from '../../../../src/main/services/tlon/paths'
import { shutdownTlon } from '../../../../src/main/services/tlon/watcher'

function workbook(shared: boolean, amount = 87261345.25, empty = false) {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(empty ? [] : [['Reference', 'Cedar'], ['Quantity', amount]]), 'Data')
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx', bookSST: shared }) as Buffer
}

async function seedOld(shared = true, empty = false) {
  const kb = createKB({ name: 'Existing spreadsheet knowledge' })
  const original = path.join(getTestDir(), `original-${kb.id}.xlsx`)
  const bytes = workbook(shared, 87261345.25, empty)
  fs.writeFileSync(original, bytes)
  const added = addRawFiles(kb.id, [original])
  const sourcePath = added.added[0]
  const raw = path.join(getKBRawDir(kb.id), sourcePath)
  const textPath = `${sha256(sourcePath).slice(0, 16)}.txt`
  const target = path.join(getKBTextDir(kb.id), textPath)
  const zip = await JSZip.loadAsync(bytes)
  const xml = await zip.file('xl/sharedStrings.xml')?.async('string') ?? ''
  const oldText = [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => match[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'))
    .filter(Boolean).join('\n').trim()
  if (oldText) fs.writeFileSync(target, `<!-- source: ${sourcePath} -->\n\n${oldText}`)
  writeHashes(kb.id, { version: 1, files: { [sourcePath]: { hash: sha256(bytes), ingestedAt: '2024-01-01T00:00:00.000Z', ...(oldText ? { textPath } : { empty: true }) } } })
  const wiki = path.join(getKBWikiDir(kb.id), 'human-notes.md')
  fs.mkdirSync(path.dirname(wiki), { recursive: true })
  fs.writeFileSync(wiki, 'Keep the human and AI notes.')
  const extra = path.join(getKBTextDir(kb.id), 'independent-notes.txt')
  fs.writeFileSync(extra, 'Keep this independently maintained text.')
  return { kb, original, bytes, sourcePath, raw, textPath, target, wiki, extra }
}

function expectedCurrent(sourcePath: string, amount = 87261345.25) {
  return `<!-- source: ${sourcePath} -->\n\nReference\tCedar\nQuantity\t${amount}`
}

describe('XLSX extractor revision upgrade', () => {
  beforeEach(() => {
    initializeApp(); _resetTlonRegistry(); _resetTlonHashCache()
    extractionGate = null; extractionCalls = 0; legacyCalls = 0; afterTemporaryWrite = null
  })
  afterEach(async () => { await shutdownTlon(); vi.restoreAllMocks() })

  it.each([true, false])('repairs the same source hash from old sharedStrings=%s results once', async shared => {
    const old = await seedOld(shared)
    await migrateKBsToTextIndex()
    expect(fs.readFileSync(old.target, 'utf8')).toBe(expectedCurrent(old.sourcePath))
    expect(readHashes(old.kb.id).files[old.sourcePath]).toMatchObject({ hash: sha256(old.bytes), textPath: old.textPath, extractorRevision: 1 })
    expect(fs.readFileSync(old.raw)).toEqual(old.bytes)
    expect(fs.readFileSync(old.original)).toEqual(old.bytes)
    expect(fs.readFileSync(old.wiki, 'utf8')).toBe('Keep the human and AI notes.')
    expect(fs.readFileSync(old.extra, 'utf8')).toBe('Keep this independently maintained text.')
    const before = { calls: extractionCalls, legacy: legacyCalls, record: readHashes(old.kb.id).files[old.sourcePath], mtime: fs.statSync(old.target).mtimeMs }
    _resetTlonRegistry(); _resetTlonHashCache()
    await migrateKBsToTextIndex()
    expect({ calls: extractionCalls, legacy: legacyCalls, record: readHashes(old.kb.id).files[old.sourcePath], mtime: fs.statSync(old.target).mtimeMs }).toEqual(before)
  })

  it('records a genuine empty workbook at the current revision without retrying each startup', async () => {
    const old = await seedOld(false, true)
    await migrateKBsToTextIndex()
    expect(readHashes(old.kb.id).files[old.sourcePath]).toMatchObject({ empty: true, extractorRevision: 1 })
    expect(fs.existsSync(old.target)).toBe(false)
    await migrateKBsToTextIndex()
    expect(extractionCalls).toBe(1)
  })

  it('removes only verified obsolete generated text when no worksheet cells remain', async () => {
    const old = await seedOld()
    const zip = await JSZip.loadAsync(old.bytes)
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    zip.file('xl/worksheets/sheet1.xml', sheet.replace(/<sheetData>[\s\S]*?<\/sheetData>/, '<sheetData/>'))
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    fs.writeFileSync(old.raw, bytes)
    fs.writeFileSync(old.original, bytes)
    const hashes = readHashes(old.kb.id)
    hashes.files[old.sourcePath].hash = sha256(bytes)
    writeHashes(old.kb.id, hashes)
    await migrateKBsToTextIndex()
    expect(fs.existsSync(old.target)).toBe(false)
    expect(readHashes(old.kb.id).files[old.sourcePath]).toMatchObject({ hash: sha256(bytes), extractorRevision: 1, empty: true })
    expect(fs.readFileSync(old.raw)).toEqual(bytes)
    expect(fs.readFileSync(old.wiki, 'utf8')).toBe('Keep the human and AI notes.')
    expect(fs.readFileSync(old.extra, 'utf8')).toBe('Keep this independently maintained text.')
    await migrateKBsToTextIndex()
    expect(extractionCalls).toBe(1)
    expect(legacyCalls).toBe(1)
  })

  it('only updates metadata when the existing bytes already match the current extractor', async () => {
    const old = await seedOld()
    fs.writeFileSync(old.target, expectedCurrent(old.sourcePath))
    const before = fs.statSync(old.target)
    await migrateKBsToTextIndex()
    expect(readHashes(old.kb.id).files[old.sourcePath]).toMatchObject({ extractorRevision: 1, textPath: old.textPath })
    expect(fs.statSync(old.target).mtimeMs).toBe(before.mtimeMs)
    expect(fs.statSync(old.target).ino).toBe(before.ino)
    expect(legacyCalls).toBe(0)
  })

  it('preserves edited text once and reevaluates only when source or text identity changes', async () => {
    const old = await seedOld()
    const edited = 'A user-maintained explanation must not be replaced.'
    fs.writeFileSync(old.target, edited)
    await migrateKBsToTextIndex()
    expect(fs.readFileSync(old.target, 'utf8')).toBe(edited)
    expect(readHashes(old.kb.id).files[old.sourcePath]).toMatchObject({ protection: { sourceHash: sha256(old.bytes), textHash: sha256(edited), textPath: old.textPath } })
    expect(readHashes(old.kb.id).files[old.sourcePath].extractorRevision).toBeUndefined()
    expect(getRawFileLearnedStatus(old.kb.id)[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('preserved') })
    _resetTlonRegistry(); _resetTlonHashCache()
    expect(collectIngestCandidates(old.kb.id)).toEqual([])
    await migrateKBsToTextIndex()
    expect({ extractionCalls, legacyCalls }).toEqual({ extractionCalls: 1, legacyCalls: 1 })
    fs.writeFileSync(old.raw, workbook(true, 42))
    await migrateKBsToTextIndex()
    expect({ extractionCalls, legacyCalls }).toEqual({ extractionCalls: 2, legacyCalls: 2 })
    expect(fs.readFileSync(old.target, 'utf8')).toBe(edited)
    fs.writeFileSync(old.target, expectedCurrent(old.sourcePath, 42))
    const modified = fs.statSync(old.target).mtimeMs
    await migrateKBsToTextIndex()
    expect(readHashes(old.kb.id).files[old.sourcePath].extractorRevision).toBe(1)
    expect(readHashes(old.kb.id).files[old.sourcePath].protection).toBeUndefined()
    expect(fs.statSync(old.target).mtimeMs).toBe(modified)
  })

  it('leaves a paused knowledge base untouched and repairs it through the existing resume scan', async () => {
    const old = await seedOld()
    const before = fs.readFileSync(old.target)
    updateKB(old.kb.id, { status: 'paused' })
    await migrateKBsToTextIndex()
    expect(extractionCalls).toBe(0)
    expect(fs.readFileSync(old.target)).toEqual(before)
    updateKB(old.kb.id, { status: 'active' })
    await vi.waitFor(() => expect(readHashes(old.kb.id).files[old.sourcePath].extractorRevision).toBe(1), { timeout: 3000 })
    expect(fs.readFileSync(old.target, 'utf8')).toBe(expectedCurrent(old.sourcePath))
  })

  it('defers an automatic upgrade paused during extraction and resumes through the existing scan', async () => {
    const old = await seedOld()
    const before = fs.readFileSync(old.target)
    let release!: () => void
    extractionGate = new Promise<void>(resolve => { release = resolve })
    const migration = migrateKBsToTextIndex()
    try {
      await vi.waitFor(() => expect(extractionCalls).toBe(1))
      updateKB(old.kb.id, { status: 'paused' })
    } finally { release() }
    await migration
    expect(fs.readFileSync(old.target)).toEqual(before)
    expect(readHashes(old.kb.id).files[old.sourcePath].extractorRevision).toBeUndefined()
    updateKB(old.kb.id, { status: 'active' })
    await vi.waitFor(() => expect(readHashes(old.kb.id).files[old.sourcePath].extractorRevision).toBe(1), { timeout: 3000 })
    expect(extractionCalls).toBe(2)
    expect(fs.readFileSync(old.target, 'utf8')).toBe(expectedCurrent(old.sourcePath))
  })

  it('keeps an explicit Learn request available while automatic learning is paused', async () => {
    const old = await seedOld()
    updateKB(old.kb.id, { status: 'paused' })
    await triggerFullIngest(old.kb.id)
    expect(readHashes(old.kb.id).files[old.sourcePath].extractorRevision).toBe(1)
    expect(fs.readFileSync(old.target, 'utf8')).toBe(expectedCurrent(old.sourcePath))
  })

  for (const change of ['text', 'source', 'remove-source', 'delete-kb', 'symlink'] as const) {
    it(`does not overwrite or recreate data changed during extraction: ${change}`, async () => {
      const old = await seedOld()
      const initial = fs.readFileSync(old.target)
      const external = path.join(getTestDir(), `outside-${old.kb.id}.txt`)
      fs.writeFileSync(external, 'External file stays unchanged.')
      let release!: () => void
      extractionGate = new Promise<void>(resolve => { release = resolve })
      const migration = migrateKBsToTextIndex()
      try {
        await vi.waitFor(() => expect(extractionCalls).toBe(1))
        if (change === 'text') fs.writeFileSync(old.target, 'Edited while the extractor yielded.')
        if (change === 'source') fs.writeFileSync(old.raw, workbook(true, 42))
        if (change === 'remove-source') removeRawFile(old.kb.id, old.sourcePath)
        if (change === 'delete-kb') await deleteKB(old.kb.id)
        if (change === 'symlink') { fs.rmSync(old.target); fs.symlinkSync(external, old.target) }
      } finally { release() }
      await migration
      if (change === 'text') {
        expect(fs.readFileSync(old.target, 'utf8')).toBe('Edited while the extractor yielded.')
        expect(readHashes(old.kb.id).files[old.sourcePath].protection?.textHash).toBe(sha256('Edited while the extractor yielded.'))
        await migrateKBsToTextIndex()
        expect(extractionCalls).toBe(1)
      } else if (change === 'source') {
        expect(fs.readFileSync(old.target)).toEqual(initial)
        expect(readHashes(old.kb.id).files[old.sourcePath].extractorRevision).toBeUndefined()
      } else if (change === 'remove-source') {
        expect(fs.existsSync(old.raw)).toBe(false)
        expect(readHashes(old.kb.id).files[old.sourcePath]).toBeUndefined()
      } else if (change === 'delete-kb') {
        expect(fs.existsSync(getKBDir(old.kb.id))).toBe(false)
        expect(fs.existsSync(getKBHashesPath(old.kb.id))).toBe(false)
      } else {
        expect(fs.lstatSync(old.target).isSymbolicLink()).toBe(true)
        expect(fs.readFileSync(external, 'utf8')).toBe('External file stays unchanged.')
        expect(readHashes(old.kb.id).files[old.sourcePath].protection?.textHash).toBeUndefined()
      }
    })
  }

  it('does not read or overwrite a cached path outside the generated-text directory', async () => {
    const old = await seedOld()
    const hashes = readHashes(old.kb.id)
    hashes.files[old.sourcePath].textPath = '../wiki/human-notes.md'
    writeHashes(old.kb.id, hashes)
    await migrateKBsToTextIndex()
    expect({ extractionCalls, legacyCalls }).toEqual({ extractionCalls: 0, legacyCalls: 0 })
    expect(fs.readFileSync(old.wiki, 'utf8')).toBe('Keep the human and AI notes.')
    expect(readHashes(old.kb.id).files[old.sourcePath].protection).toMatchObject({ scope: 'path', textPath: '../wiki/human-notes.md' })
    expect(readHashes(old.kb.id).files[old.sourcePath].protection?.textHash).toBeUndefined()
    expect(collectIngestCandidates(old.kb.id)).toEqual([])
  })

  it('preserves an edit made after matching old output but before the replacement is committed', async () => {
    const old = await seedOld()
    afterTemporaryWrite = () => fs.writeFileSync(old.target, 'Edited after the ownership comparison.')
    await migrateKBsToTextIndex()
    expect(afterTemporaryWrite).toBeNull()
    expect(fs.readFileSync(old.target, 'utf8')).toBe('Edited after the ownership comparison.')
    expect(readHashes(old.kb.id).files[old.sourcePath].protection?.textHash).toBe(sha256('Edited after the ownership comparison.'))
    expect(readHashes(old.kb.id).files[old.sourcePath].extractorRevision).toBeUndefined()
    expect(fs.readdirSync(getKBTextDir(old.kb.id)).some(name => name.endsWith('.tmp'))).toBe(false)
    await migrateKBsToTextIndex()
    expect(extractionCalls).toBe(1)
    expect(legacyCalls).toBe(1)
  })

  it('does not clean up an external file when the temporary-output directory is redirected', async () => {
    const old = await seedOld()
    const textDir = getKBTextDir(old.kb.id)
    const outside = path.join(getTestDir(), `redirected-${old.kb.id}`)
    fs.mkdirSync(outside)
    const externalText = path.join(outside, old.textPath)
    fs.writeFileSync(externalText, 'External text must remain.')
    let externalTemporary = ''
    afterTemporaryWrite = () => {
      const temporary = fs.readdirSync(textDir).find(name => name.endsWith('.tmp'))!
      expect(temporary).toBeTruthy()
      externalTemporary = path.join(outside, temporary)
      fs.writeFileSync(externalTemporary, 'This external file is not owned by the upgrade.')
      fs.renameSync(textDir, path.join(getKBDir(old.kb.id), 'moved-text'))
      fs.symlinkSync(outside, textDir, process.platform === 'win32' ? 'junction' : 'dir')
    }
    await migrateKBsToTextIndex()
    expect(afterTemporaryWrite).toBeNull()
    expect(fs.readFileSync(externalText, 'utf8')).toBe('External text must remain.')
    expect(fs.readFileSync(externalTemporary, 'utf8')).toBe('This external file is not owned by the upgrade.')
    expect(readHashes(old.kb.id).files[old.sourcePath].protection?.scope).toBe('directory')
    expect(readHashes(old.kb.id).files[old.sourcePath].extractorRevision).toBeUndefined()
  })

  it('preserves a linked text directory without scanning or hashing its external files', async () => {
    const old = await seedOld()
    const outside = path.join(getTestDir(), `outside-directory-${old.kb.id}`)
    fs.mkdirSync(outside)
    const external = path.join(outside, old.textPath)
    fs.writeFileSync(external, 'External directory contents stay private.')
    fs.renameSync(getKBTextDir(old.kb.id), path.join(getKBDir(old.kb.id), 'original-text'))
    fs.symlinkSync(outside, getKBTextDir(old.kb.id), process.platform === 'win32' ? 'junction' : 'dir')
    const reads = vi.mocked(observedReaddirSync)
    reads.mockClear()
    await migrateKBsToTextIndex()
    expect({ extractionCalls, legacyCalls }).toEqual({ extractionCalls: 0, legacyCalls: 0 })
    expect(reads.mock.calls.some(([directory]) => String(directory) === getKBRawDir(old.kb.id))).toBe(true)
    expect(reads.mock.calls.some(([directory]) => String(directory) === getKBTextDir(old.kb.id) || String(directory) === outside)).toBe(false)
    expect(readHashes(old.kb.id).files[old.sourcePath].protection).toMatchObject({ scope: 'directory' })
    expect(readHashes(old.kb.id).files[old.sourcePath].protection?.textHash).toBeUndefined()
    expect(fs.readFileSync(external, 'utf8')).toBe('External directory contents stay private.')
    expect(collectIngestCandidates(old.kb.id)).toEqual([])
  })

  it('does not follow a dangling index symlink to create an external file', async () => {
    const old = await seedOld()
    const external = path.join(getTestDir(), `missing-index-${old.kb.id}.md`)
    fs.rmSync(getKBIndexMdPath(old.kb.id))
    fs.symlinkSync(external, getKBIndexMdPath(old.kb.id))
    await migrateKBsToTextIndex()
    expect(fs.existsSync(external)).toBe(false)
    expect(fs.lstatSync(getKBIndexMdPath(old.kb.id)).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(old.target, 'utf8')).toBe(expectedCurrent(old.sourcePath))
  })
})
