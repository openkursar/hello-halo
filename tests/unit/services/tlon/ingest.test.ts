/**
 * Tlon Ingest Unit Tests
 *
 * End-to-end extraction pipeline on real temp files: enqueue/dedupe, full
 * ingest, empty-extraction bookkeeping, per-file failure isolation, index.md
 * document map rebuild, and clear-and-relearn guarding.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { getTestDir } from '../../setup'

vi.mock('../../../../src/main/services/tlon/watcher', () => ({
  startWatchersForKB: vi.fn(async () => {}),
  stopWatchersForKB: vi.fn(async () => {}),
  startLinkedDirWatch: vi.fn(async () => {}),
  stopLinkedDirWatch: vi.fn(async () => {}),
}))
vi.mock('@parcel/watcher', () => ({
  default: {
    subscribe: vi.fn(async () => ({ unsubscribe: vi.fn(async () => {}) })),
  },
}))

const sendToRenderer = vi.fn()
const broadcastToAll = vi.fn()
vi.mock('../../../../src/main/foundation/window.service', () => ({
  sendToRenderer: (...args: unknown[]) => sendToRenderer(...args),
}))
vi.mock('../../../../src/main/http/websocket', () => ({
  broadcastToAll: (...args: unknown[]) => broadcastToAll(...args),
}))

// Gate hook: when set, extractText awaits it before delegating to the real
// implementation — lets a test observe the "ingest in progress" state.
let extractGate: Promise<void> | null = null
vi.mock('../../../../src/main/services/tlon/extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/services/tlon/extract')>()
  return {
    ...actual,
    extractText: async (absPath: string, buf: Buffer) => {
      if (extractGate) await extractGate
      return actual.extractText(absPath, buf)
    },
  }
})

import {
  _resetTlonRegistry,
  _resetTlonHashCache,
  createKB,
  getKB,
  deleteKB,
  addRawFiles,
  readHashes,
  writeHashes,
  sha256,
  collectIngestCandidates,
} from '../../../../src/main/services/tlon/service'
import {
  enqueueFiles,
  processQueue,
  triggerFullIngest,
  clearAndRelearn,
  migrateKBsToTextIndex,
  isIngesting,
  getIngestProgress,
  rebuildIndexMd,
  evictIngestState,
} from '../../../../src/main/services/tlon/ingest'
import {
  getKBTextDir,
  getKBRawDir,
  getKBIndexMdPath,
  getKBLogPath,
  getKBHashesPath,
} from '../../../../src/main/services/tlon/paths'
import { DEFAULT_INDEX_MD } from '../../../../src/main/services/tlon/defaults'
import { initializeApp } from '../../../../src/main/foundation/config.service'

function makeScratchDir(): string {
  const dir = path.join(getTestDir(), 'scratch-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeScratchFile(dir: string, name: string, content: string | Buffer): string {
  const p = path.join(dir, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}

/** The extracted-text files (.txt) currently in a KB's text/ dir. */
function textFiles(kbId: string): string[] {
  return fs.readdirSync(getKBTextDir(kbId)).filter(f => f.endsWith('.txt'))
}

describe('Tlon Ingest', () => {
  beforeEach(async () => {
    _resetTlonRegistry()
    _resetTlonHashCache()
    extractGate = null
    await initializeApp()
  })

  afterEach(async () => {
    await vi.dynamicImportSettled()
  })

  describe('triggerFullIngest', () => {
    it('extracts txt/md/csv sources into text/ with a source marker', async () => {
      const kb = createKB({ name: 'E2E' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [
        writeScratchFile(scratch, 'notes.md', '# Heading\n\nBody text.'),
        writeScratchFile(scratch, 'plain.txt', 'Plain contents. 中文内容。'),
        writeScratchFile(scratch, 'data.csv', 'col1,col2\n1,2'),
      ])

      await triggerFullIngest(kb.id)

      expect(textFiles(kb.id)).toHaveLength(3)
      const hashes = readHashes(kb.id)
      expect(Object.keys(hashes.files).sort()).toEqual(['data.csv', 'notes.md', 'plain.txt'])
      for (const [sourcePath, info] of Object.entries(hashes.files)) {
        expect(info.textPath).toMatch(/^[0-9a-f]{16}\.txt$/)
        const text = fs.readFileSync(path.join(getKBTextDir(kb.id), info.textPath!), 'utf-8')
        expect(text.startsWith(`<!-- source: ${sourcePath} -->`)).toBe(true)
      }
      const plainInfo = hashes.files['plain.txt']
      const extracted = fs.readFileSync(path.join(getKBTextDir(kb.id), plainInfo.textPath!), 'utf-8')
      expect(extracted).toContain('Plain contents. 中文内容。')
      expect(plainInfo.hash).toBe(sha256('Plain contents. 中文内容。'))

      // Progress ends 'done' with a correct batch total; stats broadcast fired.
      expect(getIngestProgress(kb.id)).toMatchObject({ total: 3, completed: 3, phase: 'done' })
      expect(sendToRenderer).toHaveBeenCalledWith('tlon:stats-updated', expect.objectContaining({ kbId: kb.id }))
      expect(broadcastToAll).toHaveBeenCalledWith('tlon:ingest-progress', expect.objectContaining({ phase: 'done' }))
      expect(getKB(kb.id)?.stats.indexedCount).toBe(3)
      expect(getKB(kb.id)?.stats.lastIngestAt).toBeTruthy()

      // Log records each extraction.
      const log = fs.readFileSync(getKBLogPath(kb.id), 'utf-8')
      expect(log).toContain('extract | notes.md')
    })

    it('is idempotent — a second run with unchanged bytes extracts nothing', async () => {
      const kb = createKB({ name: 'Idem' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(scratch, 'a.md', 'stable')])
      await triggerFullIngest(kb.id)
      const before = readHashes(kb.id).files['a.md'].ingestedAt

      await triggerFullIngest(kb.id)
      expect(readHashes(kb.id).files['a.md'].ingestedAt).toBe(before)
      expect(getIngestProgress(kb.id)).toMatchObject({ total: 0, phase: 'done' })
    })

    it('does nothing for an unknown KB', async () => {
      await expect(triggerFullIngest('missing')).resolves.toBeUndefined()
    })
  })

  describe('empty extraction', () => {
    it('records empty:true, writes no text file, and is not re-enqueued', async () => {
      const kb = createKB({ name: 'Empty' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(scratch, 'blank.txt', '   \n\t\n')])

      await triggerFullIngest(kb.id)

      const rec = readHashes(kb.id).files['blank.txt']
      expect(rec.empty).toBe(true)
      expect(rec.textPath).toBeUndefined()
      expect(textFiles(kb.id)).toHaveLength(0)
      // Skip logic: unchanged empty source is not a candidate again.
      expect(collectIngestCandidates(kb.id)).toEqual([])

      // …until its bytes change.
      fs.writeFileSync(path.join(getKBRawDir(kb.id), 'blank.txt'), 'now has content', 'utf-8')
      expect(collectIngestCandidates(kb.id).map(c => c.sourcePath)).toEqual(['blank.txt'])
    })
  })

  describe('failure isolation', () => {
    it('a failing extraction does not kill the batch and the KB stays active', async () => {
      const kb = createKB({ name: 'Fail' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [
        writeScratchFile(scratch, 'good.md', 'good content'),
        // Garbage bytes with a .docx extension: jszip throws on load.
        writeScratchFile(scratch, 'broken.docx', Buffer.from('not a zip at all')),
        writeScratchFile(scratch, 'also-good.txt', 'more content'),
      ])

      await triggerFullIngest(kb.id)

      const hashes = readHashes(kb.id)
      expect(hashes.files['good.md']?.textPath).toBeTruthy()
      expect(hashes.files['also-good.txt']?.textPath).toBeTruthy()
      // The failed file records nothing (it will retry next scan)…
      expect(hashes.files['broken.docx']).toBeUndefined()
      // …and the KB is not poisoned.
      expect(getKB(kb.id)?.status).toBe('active')

      // The terminal event surfaces the per-file failure to the UI.
      const final = getIngestProgress(kb.id)
      expect(final).toMatchObject({ total: 3, completed: 3, phase: 'done' })
      expect(final.errors).toHaveLength(1)
      expect(final.errors?.[0].file).toBe('broken.docx')
      expect(final.errors?.[0].message).toBeTruthy()
      // The broadcast terminal event carries the same error list.
      expect(broadcastToAll).toHaveBeenCalledWith(
        'tlon:ingest-progress',
        expect.objectContaining({ phase: 'done', errors: [expect.objectContaining({ file: 'broken.docx' })] })
      )
    })

    it('a clean batch reports no errors field', async () => {
      const kb = createKB({ name: 'Clean' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(scratch, 'fine.md', 'fine')])
      await triggerFullIngest(kb.id)
      expect(getIngestProgress(kb.id).errors).toBeUndefined()
    })
  })

  describe('mid-batch enqueue', () => {
    it('grows the emitted total when files are enqueued during a running batch', async () => {
      const kb = createKB({ name: 'Grow' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(scratch, 'first.md', 'first')])

      let release!: () => void
      extractGate = new Promise<void>(resolve => { release = resolve })
      const running = triggerFullIngest(kb.id)
      await new Promise(r => setTimeout(r, 10))
      expect(isIngesting(kb.id)).toBe(true)

      // Simulate the watcher's debounced scan adding a file mid-batch.
      const second = writeScratchFile(getKBRawDir(kb.id), 'second.md', 'second')
      enqueueFiles(kb.id, [{ sourcePath: 'second.md', absolutePath: second, sourceType: 'raw' }])

      release()
      await running

      // The batch drained both files and the total reflects the growth (2/2, not 2/1).
      expect(getIngestProgress(kb.id)).toMatchObject({ total: 2, completed: 2, phase: 'done' })
      expect(readHashes(kb.id).files['second.md']?.textPath).toBeTruthy()
    })
  })

  describe('evictIngestState', () => {
    it('drops queued jobs and the last progress event', async () => {
      const kb = createKB({ name: 'Evict' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(scratch, 'a.md', 'aaa')])
      await triggerFullIngest(kb.id)
      expect(getIngestProgress(kb.id).phase).toBe('done')

      enqueueFiles(kb.id, [{
        sourcePath: 'b.md',
        absolutePath: path.join(getKBRawDir(kb.id), 'b.md'),
        sourceType: 'raw',
      }])
      evictIngestState(kb.id)

      expect(getIngestProgress(kb.id)).toMatchObject({ total: 0, completed: 0, phase: 'idle' })
      await processQueue(kb.id) // queue was emptied — nothing runs
      expect(getIngestProgress(kb.id).phase).toBe('idle')
    })

    it('deleteKB clears the deleted KB ingest state', async () => {
      const kb = createKB({ name: 'DelEvict' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(scratch, 'a.md', 'aaa')])
      await triggerFullIngest(kb.id)
      expect(getIngestProgress(kb.id).phase).toBe('done')

      await deleteKB(kb.id)
      expect(getIngestProgress(kb.id).phase).toBe('idle')
    })
  })

  describe('enqueueFiles dedupe', () => {
    it('the same sourcePath is only queued once', async () => {
      const kb = createKB({ name: 'Dedupe' })
      const scratch = makeScratchDir()
      const abs = path.join(getKBRawDir(kb.id), 'dup.md')
      addRawFiles(kb.id, [writeScratchFile(scratch, 'dup.md', 'dup content')])

      enqueueFiles(kb.id, [
        { sourcePath: 'dup.md', absolutePath: abs, sourceType: 'raw' },
        { sourcePath: 'dup.md', absolutePath: abs, sourceType: 'raw' },
      ])
      enqueueFiles(kb.id, [{ sourcePath: 'dup.md', absolutePath: abs, sourceType: 'raw' }])
      await processQueue(kb.id)

      expect(getIngestProgress(kb.id)).toMatchObject({ total: 1, completed: 1, phase: 'done' })
      expect(textFiles(kb.id)).toHaveLength(1)
    })
  })

  describe('clearAndRelearn', () => {
    it('throws while an ingest is in progress', async () => {
      const kb = createKB({ name: 'Busy' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(scratch, 'slow.md', 'slow content')])

      let release!: () => void
      extractGate = new Promise<void>(resolve => { release = resolve })

      const running = triggerFullIngest(kb.id)
      // Let processing start and block on the gate.
      await new Promise(r => setTimeout(r, 10))
      expect(isIngesting(kb.id)).toBe(true)
      await expect(clearAndRelearn(kb.id)).rejects.toThrow('Ingest already in progress')

      release()
      await running
      expect(isIngesting(kb.id)).toBe(false)
    })

    it('wipes learned state and re-extracts everything from scratch', async () => {
      const kb = createKB({ name: 'Relearn' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(scratch, 'a.md', 'content a')])
      await triggerFullIngest(kb.id)
      const firstIngestedAt = readHashes(kb.id).files['a.md'].ingestedAt

      await new Promise(r => setTimeout(r, 5))
      await clearAndRelearn(kb.id)

      const rec = readHashes(kb.id).files['a.md']
      expect(rec.textPath).toBeTruthy()
      expect(rec.ingestedAt).not.toBe(firstIngestedAt)
      expect(textFiles(kb.id)).toHaveLength(1)
    })
  })

  describe('rebuildIndexMd', () => {
    it('writes a document map with names, synopses, and absolute text paths', async () => {
      const kb = createKB({ name: 'MapKB' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [
        writeScratchFile(scratch, 'alpha.md', 'Alpha synopsis line.\nSecond line.'),
        writeScratchFile(scratch, 'beta.txt', 'Beta first line.'),
      ])
      await triggerFullIngest(kb.id)

      const md = fs.readFileSync(getKBIndexMdPath(kb.id), 'utf-8')
      expect(md).toContain('# MapKB')
      const alphaText = readHashes(kb.id).files['alpha.md'].textPath!
      expect(md).toContain(`- **alpha.md** — Alpha synopsis line. — \`${path.join(getKBTextDir(kb.id), alphaText)}\``)
      expect(md).toContain('- **beta.txt** — Beta first line.')
      // Alphabetical by name.
      expect(md.indexOf('alpha.md')).toBeLessThan(md.indexOf('beta.txt'))
    })

    it('caps long synopses at 160 characters', async () => {
      const kb = createKB({ name: 'LongLine' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(scratch, 'long.md', 'x'.repeat(500))])
      await triggerFullIngest(kb.id)
      const line = fs.readFileSync(getKBIndexMdPath(kb.id), 'utf-8')
        .split('\n').find(l => l.includes('long.md'))!
      expect(line).toContain('…')
      expect(line.length).toBeLessThan(400)
    })

    it('falls back to DEFAULT_INDEX_MD when no documents are indexed', () => {
      const kb = createKB({ name: 'NoDocs' })
      fs.writeFileSync(getKBIndexMdPath(kb.id), '# stale map', 'utf-8')
      rebuildIndexMd(kb.id)
      expect(fs.readFileSync(getKBIndexMdPath(kb.id), 'utf-8')).toBe(DEFAULT_INDEX_MD)
    })

    it('drops hash entries whose text file no longer exists', async () => {
      const kb = createKB({ name: 'Stale' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(scratch, 'kept.md', 'kept')])
      await triggerFullIngest(kb.id)
      writeHashes(kb.id, {
        version: 1,
        files: {
          ...readHashes(kb.id).files,
          'ghost.md': { hash: 'h', ingestedAt: 't', textPath: 'nope.txt' },
        },
      })
      rebuildIndexMd(kb.id)
      const md = fs.readFileSync(getKBIndexMdPath(kb.id), 'utf-8')
      expect(md).toContain('kept.md')
      expect(md).not.toContain('ghost.md')
    })
  })

  describe('hashes.json atomicity', () => {
    it('leaves valid JSON and no .tmp file after a batch', async () => {
      const kb = createKB({ name: 'Atomic' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(scratch, 'a.md', 'aaa')])
      await triggerFullIngest(kb.id)

      const hashesPath = getKBHashesPath(kb.id)
      expect(fs.existsSync(hashesPath + '.tmp')).toBe(false)
      expect(() => JSON.parse(fs.readFileSync(hashesPath, 'utf-8'))).not.toThrow()
    })
  })

  describe('migrateKBsToTextIndex', () => {
    it('extracts pending sources across all KBs and skips up-to-date ones', async () => {
      const scratch = makeScratchDir()
      const kb1 = createKB({ name: 'M1' })
      const kb2 = createKB({ name: 'M2' })
      addRawFiles(kb1.id, [writeScratchFile(scratch, 'one.md', 'one')])
      addRawFiles(kb2.id, [writeScratchFile(scratch, 'two.md', 'two')])
      await triggerFullIngest(kb1.id) // kb1 already migrated

      await migrateKBsToTextIndex()

      expect(readHashes(kb1.id).files['one.md']?.textPath).toBeTruthy()
      expect(readHashes(kb2.id).files['two.md']?.textPath).toBeTruthy()
    })
  })
})
