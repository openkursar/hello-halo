/**
 * Tlon Service Unit Tests
 *
 * Covers KB registry CRUD, default-KB exclusivity, space/app binding, raw file
 * operations (accept/reject, directory import, traversal guards), learned
 * status, source-citation resolution, and stats.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { getTestDir } from '../../setup'

// The service lazily imports ./watcher (native @parcel/watcher) on createKB
// and deleteKB; stub it so no real filesystem watchers are created.
vi.mock('../../../../src/main/services/tlon/watcher', () => ({
  startWatchersForKB: vi.fn(async () => {}),
  stopWatchersForKB: vi.fn(async () => {}),
  startLinkedDirWatch: vi.fn(async () => {}),
  stopLinkedDirWatch: vi.fn(async () => {}),
}))
// Belt and braces: if the real watcher module still loads (dynamic import),
// its native subscribe must never touch the real filesystem watch API.
vi.mock('@parcel/watcher', () => ({
  default: {
    subscribe: vi.fn(async () => ({ unsubscribe: vi.fn(async () => {}) })),
  },
}))

import {
  _resetTlonRegistry,
  _resetTlonHashCache,
  hashFileCached,
  createKB,
  getKB,
  updateKB,
  deleteKB,
  listKBs,
  listKBsForSpace,
  listKBsForApp,
  setDefaultKB,
  getDefaultKB,
  bindToSpace,
  unbindFromSpace,
  bindToApp,
  unbindFromApp,
  addLinkedDir,
  removeLinkedDir,
  addRawFiles,
  removeRawFile,
  isAcceptedTextFile,
  isAcceptedSourceFile,
  looksBinary,
  sha256,
  readHashes,
  writeHashes,
  refreshStats,
  clearWikiAndHashes,
  getRawFileLearnedStatus,
  resolveSources,
  resolveSourcesForReadPaths,
  getSeedKBIds,
  getKBReferenceById,
  getKBChatContext,
  collectIngestCandidates,
} from '../../../../src/main/services/tlon/service'
import {
  getKBIndexPath,
  getKBDir,
  getKBRawDir,
  getKBTextDir,
  getKBHashesPath,
  getKBIndexMdPath,
  getKBMetaPath,
  getTlonRoot,
} from '../../../../src/main/services/tlon/paths'
import { DEFAULT_INDEX_MD } from '../../../../src/main/services/tlon/defaults'
import { initializeApp } from '../../../../src/main/foundation/config.service'

/** Scratch dir (outside the tlon root) for source files fed to addRawFiles. */
function makeScratchDir(): string {
  const dir = path.join(getTestDir(), 'scratch-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeScratchFile(dir: string, name: string, content = 'hello'): string {
  const p = path.join(dir, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

describe('Tlon Service', () => {
  beforeEach(async () => {
    _resetTlonRegistry()
    _resetTlonHashCache()
    await initializeApp()
  })

  afterEach(async () => {
    // createKB/addLinkedDir fire-and-forget import('./watcher'); settle those
    // imports inside the test so the (mocked) module never loads for real
    // against a torn-down temp dir.
    await vi.dynamicImportSettled()
  })

  describe('extension acceptance', () => {
    it('accepts document-like text extensions case-insensitively', () => {
      for (const p of ['a.md', 'B.MD', 'c.markdown', 'd.txt', 'e.rst', 'f.org', 'g.csv', 'h.tsv', 'i.html', 'j.htm']) {
        expect(isAcceptedTextFile(p), p).toBe(true)
      }
    })

    it('rejects code, config, and extension-less files', () => {
      for (const p of ['a.ts', 'b.py', 'c.json', 'd.yaml', 'e.sh', 'f.log', 'Makefile', 'g.exe']) {
        expect(isAcceptedTextFile(p), p).toBe(false)
      }
    })

    it('accepts extractable documents and images as source files', () => {
      for (const p of ['a.pdf', 'b.docx', 'c.pptx', 'd.xlsx', 'e.png', 'f.jpg']) {
        expect(isAcceptedSourceFile(p), p).toBe(true)
      }
      expect(isAcceptedSourceFile('a.ts')).toBe(false)
    })

    it('rejects Office/OS lock and owner junk despite a document extension', () => {
      for (const p of [
        '~$Report.docx',                  // MS Office owner file (open document)
        'dir/~$Deck.pptx',
        '~$Budget.xlsx',
        '.~lock.Notes.odt#',              // LibreOffice lock
        'folder/.DS_Store',
        'Thumbs.db',
        'desktop.ini',
      ]) {
        expect(isAcceptedSourceFile(p), p).toBe(false)
      }
    })
  })

  describe('looksBinary / sha256', () => {
    it('detects a NUL byte within the first 8KB', () => {
      expect(looksBinary(Buffer.from('plain text'))).toBe(false)
      expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true)
      // NUL beyond the 8KB guard window is not scanned
      const big = Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0x00])])
      expect(looksBinary(big)).toBe(false)
    })

    it('treats UTF-16 BOM buffers as text despite their NUL bytes', () => {
      expect(looksBinary(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]))).toBe(false)
      const be = Buffer.from('hi', 'utf16le')
      be.swap16()
      expect(looksBinary(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(false)
    })

    it('hashes buffers and strings identically for the same bytes', () => {
      expect(sha256('abc')).toBe(sha256(Buffer.from('abc')))
      expect(sha256('abc')).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('createKB', () => {
    it('creates the KB directory layout and seed files', () => {
      const kb = createKB({ name: 'My KB', description: 'desc' })

      expect(kb.name).toBe('My KB')
      expect(kb.status).toBe('active')
      expect(fs.existsSync(getKBRawDir(kb.id))).toBe(true)
      expect(fs.existsSync(getKBTextDir(kb.id))).toBe(true)
      expect(fs.readFileSync(getKBIndexMdPath(kb.id), 'utf-8')).toBe(DEFAULT_INDEX_MD)
      const hashes = JSON.parse(fs.readFileSync(getKBHashesPath(kb.id), 'utf-8'))
      expect(hashes).toEqual({ version: 1, files: {} })
    })

    it('persists the registry so a reload finds the KB', () => {
      const kb = createKB({ name: 'Persisted' })
      _resetTlonRegistry()
      const loaded = getKB(kb.id)
      expect(loaded?.name).toBe('Persisted')
      expect(listKBs().map(k => k.id)).toContain(kb.id)
    })

    it('records linked dirs, marking existing paths as watching', () => {
      const scratch = makeScratchDir()
      const kb = createKB({
        name: 'Linked',
        linkedDirs: [
          { path: scratch, label: 'exists' },
          { path: path.join(scratch, 'missing'), label: 'gone' },
        ],
      })
      expect(kb.linkedDirs).toHaveLength(2)
      expect(kb.linkedDirs[0].watching).toBe(true)
      expect(kb.linkedDirs[1].watching).toBe(false)
    })
  })

  describe('registry load', () => {
    it('starts empty when index.json is corrupted', () => {
      const kb = createKB({ name: 'Doomed' })
      fs.writeFileSync(getKBIndexPath(), '{not json', 'utf-8')
      _resetTlonRegistry()
      expect(listKBs()).toEqual([])
      expect(getKB(kb.id)).toBeNull()
    })

    it('ignores malformed entries and applies defensive defaults', () => {
      const kb = createKB({ name: 'Valid' })
      const raw = JSON.parse(fs.readFileSync(getKBIndexPath(), 'utf-8'))
      // Strip optional arrays and inject a broken entry.
      delete raw.knowledgeBases[kb.id].spaceIds
      delete raw.knowledgeBases[kb.id].linkedDirs
      delete raw.knowledgeBases[kb.id].stats
      raw.knowledgeBases['broken'] = { name: 'no id/path' }
      fs.writeFileSync(getKBIndexPath(), JSON.stringify(raw), 'utf-8')

      _resetTlonRegistry()
      const loaded = getKB(kb.id)
      expect(loaded).not.toBeNull()
      expect(loaded?.spaceIds).toEqual([])
      expect(loaded?.linkedDirs).toEqual([])
      expect(loaded?.stats).toEqual({ rawFileCount: 0, indexedCount: 0, rawSizeBytes: 0 })
      expect(getKB('broken')).toBeNull()
    })

    it('ignores an index file with an unknown version', () => {
      fs.mkdirSync(getTlonRoot(), { recursive: true })
      fs.writeFileSync(getKBIndexPath(), JSON.stringify({ version: 99, knowledgeBases: {} }), 'utf-8')
      _resetTlonRegistry()
      expect(listKBs()).toEqual([])
    })
  })

  describe('updateKB / deleteKB', () => {
    it('updates only provided fields', () => {
      const kb = createKB({ name: 'Before', description: 'old' })
      const updated = updateKB(kb.id, { name: 'After', status: 'paused' })
      expect(updated?.name).toBe('After')
      expect(updated?.status).toBe('paused')
      expect(updated?.description).toBe('old')
      expect(updateKB('missing', { name: 'x' })).toBeNull()
    })

    it('deletes the KB directory and registry entry', async () => {
      const kb = createKB({ name: 'Gone' })
      const dir = getKBDir(kb.id)
      expect(fs.existsSync(dir)).toBe(true)

      expect(await deleteKB(kb.id)).toBe(true)
      expect(fs.existsSync(dir)).toBe(false)
      expect(getKB(kb.id)).toBeNull()
      expect(await deleteKB(kb.id)).toBe(false)
    })
  })

  describe('setDefaultKB exclusivity', () => {
    it('keeps at most one default KB', () => {
      const a = createKB({ name: 'A' })
      const b = createKB({ name: 'B' })

      expect(setDefaultKB(a.id)).toBe(true)
      expect(getDefaultKB()?.id).toBe(a.id)

      expect(setDefaultKB(b.id)).toBe(true)
      expect(getDefaultKB()?.id).toBe(b.id)
      expect(getKB(a.id)?.isDefault).toBe(false)

      // Exclusivity survives a registry reload.
      _resetTlonRegistry()
      expect(listKBs().filter(k => k.isDefault)).toHaveLength(1)
      expect(getDefaultKB()?.id).toBe(b.id)
    })

    it('clears the default with null and rejects unknown ids', () => {
      const a = createKB({ name: 'A' })
      setDefaultKB(a.id)
      expect(setDefaultKB('nope')).toBe(false)
      expect(getDefaultKB()?.id).toBe(a.id)
      expect(setDefaultKB(null)).toBe(true)
      expect(getDefaultKB()).toBeNull()
    })
  })

  describe('space/app binding', () => {
    it('binds and unbinds spaces without duplicates', () => {
      const kb = createKB({ name: 'Bind' })
      expect(bindToSpace(kb.id, 's1')).toBe(true)
      expect(bindToSpace(kb.id, 's1')).toBe(false)
      expect(listKBsForSpace('s1').map(k => k.id)).toEqual([kb.id])

      expect(unbindFromSpace(kb.id, 's1')).toBe(true)
      expect(unbindFromSpace(kb.id, 's1')).toBe(false)
      expect(listKBsForSpace('s1')).toEqual([])
      expect(bindToSpace('missing', 's1')).toBe(false)
    })

    it('binds and unbinds apps without duplicates', () => {
      const kb = createKB({ name: 'BindApp' })
      expect(bindToApp(kb.id, 'app1')).toBe(true)
      expect(bindToApp(kb.id, 'app1')).toBe(false)
      expect(listKBsForApp('app1').map(k => k.id)).toEqual([kb.id])
      expect(unbindFromApp(kb.id, 'app1')).toBe(true)
      expect(unbindFromApp(kb.id, 'app1')).toBe(false)
    })
  })

  describe('linked directories', () => {
    it('adds an existing dir once and removes it by link id', () => {
      const kb = createKB({ name: 'LD' })
      const scratch = makeScratchDir()

      const linked = addLinkedDir(kb.id, { path: scratch, label: 'docs' })
      expect(linked?.path).toBe(scratch)
      // Duplicate path returns the existing link.
      expect(addLinkedDir(kb.id, { path: scratch, label: 'again' })?.id).toBe(linked?.id)
      expect(getKB(kb.id)?.linkedDirs).toHaveLength(1)

      expect(removeLinkedDir(kb.id, linked!.id)).toBe(true)
      expect(getKB(kb.id)?.linkedDirs).toHaveLength(0)
      expect(removeLinkedDir(kb.id, linked!.id)).toBe(false)
    })

    it('rejects a nonexistent path', () => {
      const kb = createKB({ name: 'LD2' })
      expect(addLinkedDir(kb.id, { path: '/nonexistent/road', label: 'x' })).toBeNull()
    })
  })

  describe('addRawFiles', () => {
    it('copies accepted text files and rejects others by extension', () => {
      const kb = createKB({ name: 'Raw' })
      const scratch = makeScratchDir()
      const md = writeScratchFile(scratch, 'notes.md', '# notes')
      const ts = writeScratchFile(scratch, 'code.ts', 'const x = 1')

      const result = addRawFiles(kb.id, [md, ts])
      expect(result.added).toEqual(['notes.md'])
      expect(result.rejected).toEqual(['code.ts'])
      expect(fs.readFileSync(path.join(getKBRawDir(kb.id), 'notes.md'), 'utf-8')).toBe('# notes')
    })

    it('rejects unreadable inputs like relative traversal paths', () => {
      const kb = createKB({ name: 'RawBad' })
      const result = addRawFiles(kb.id, ['../evil.md', '/nonexistent/abs.md'])
      expect(result.added).toEqual([])
      expect(result.rejected).toEqual(['evil.md', 'abs.md'])
    })

    it('imports a directory recursively, pruning ignored dirs', () => {
      const kb = createKB({ name: 'RawDir' })
      const scratch = makeScratchDir()
      const folder = path.join(scratch, 'project')
      writeScratchFile(folder, 'readme.md', 'root doc')
      writeScratchFile(folder, path.join('docs', 'guide.txt'), 'nested doc')
      writeScratchFile(folder, 'main.py', 'code')
      writeScratchFile(folder, path.join('node_modules', 'dep.md'), 'ignored')
      writeScratchFile(folder, path.join('.git', 'config.md'), 'ignored')

      const result = addRawFiles(kb.id, [folder])
      expect(result.added.sort()).toEqual([
        path.join('project', 'docs', 'guide.txt'),
        path.join('project', 'readme.md'),
      ])
      expect(result.rejected).toEqual([path.join('project', 'main.py')])
      expect(fs.existsSync(path.join(getKBRawDir(kb.id), 'project', 'node_modules'))).toBe(false)
      expect(fs.existsSync(path.join(getKBRawDir(kb.id), 'project', '.git'))).toBe(false)
    })

    it('refreshes stats after adding', () => {
      const kb = createKB({ name: 'RawStats' })
      const scratch = makeScratchDir()
      const md = writeScratchFile(scratch, 'a.md', '12345')
      addRawFiles(kb.id, [md])
      const entry = getKB(kb.id)!
      expect(entry.stats.rawFileCount).toBe(1)
      expect(entry.stats.rawSizeBytes).toBe(5)
    })

    it('returns empty result for a missing KB', () => {
      expect(addRawFiles('missing', ['/tmp/x.md'])).toEqual({ added: [], rejected: [] })
    })

    it('uniquifies a basename collision with different content instead of overwriting', () => {
      const kb = createKB({ name: 'Collide' })
      const a = makeScratchDir()
      const b = makeScratchDir()
      const c = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(a, 'notes.md', 'from a')])
      const second = addRawFiles(kb.id, [writeScratchFile(b, 'notes.md', 'from b')])
      const third = addRawFiles(kb.id, [writeScratchFile(c, 'notes.md', 'from c')])

      expect(second.added).toEqual(['notes-2.md'])
      expect(third.added).toEqual(['notes-3.md'])
      const rawDir = getKBRawDir(kb.id)
      expect(fs.readFileSync(path.join(rawDir, 'notes.md'), 'utf-8')).toBe('from a')
      expect(fs.readFileSync(path.join(rawDir, 'notes-2.md'), 'utf-8')).toBe('from b')
      expect(fs.readFileSync(path.join(rawDir, 'notes-3.md'), 'utf-8')).toBe('from c')
    })

    it('re-adding identical content keeps the existing copy and reports it added', () => {
      const kb = createKB({ name: 'SameBytes' })
      const scratch = makeScratchDir()
      const src = writeScratchFile(scratch, 'same.md', 'identical')
      addRawFiles(kb.id, [src])
      const again = addRawFiles(kb.id, [src])

      expect(again.added).toEqual(['same.md'])
      expect(fs.readdirSync(getKBRawDir(kb.id))).toEqual(['same.md'])
    })
  })

  describe('hashFileCached', () => {
    it('memoizes by mtime+size and re-hashes after reset or size change', () => {
      const scratch = makeScratchDir()
      const p = writeScratchFile(scratch, 'memo.txt', 'aaaa')
      // Whole-second mtime so utimesSync can restore it exactly below.
      const mtime = new Date('2026-01-01T00:00:00Z')
      fs.utimesSync(p, mtime, mtime)
      const first = hashFileCached(p)
      expect(first.hash).toBe(sha256('aaaa'))
      expect(first.binary).toBe(false)

      // Same size + same mtime: the (stale) memo is served without a read.
      fs.writeFileSync(p, 'bbbb', 'utf-8')
      fs.utimesSync(p, mtime, mtime)
      expect(hashFileCached(p).hash).toBe(sha256('aaaa'))

      // Reset drops the memo and the new bytes are hashed.
      _resetTlonHashCache()
      expect(hashFileCached(p).hash).toBe(sha256('bbbb'))

      // A size change invalidates without any reset.
      fs.writeFileSync(p, 'cc', 'utf-8')
      expect(hashFileCached(p).hash).toBe(sha256('cc'))
    })

    it('reports binary content and throws on missing files', () => {
      const scratch = makeScratchDir()
      const p = path.join(scratch, 'bin.dat')
      fs.writeFileSync(p, Buffer.from([1, 0, 2, 3]))
      expect(hashFileCached(p).binary).toBe(true)
      expect(() => hashFileCached(path.join(scratch, 'missing'))).toThrow()
    })
  })

  describe('removeRawFile', () => {
    it('removes the file and its learned-status entry', () => {
      const kb = createKB({ name: 'Rm' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(scratch, 'a.md', 'content')])
      writeHashes(kb.id, {
        version: 1,
        files: { 'a.md': { hash: sha256('content'), ingestedAt: 'now', textPath: 'x.txt' } },
      })

      expect(removeRawFile(kb.id, 'a.md')).toBe(true)
      expect(fs.existsSync(path.join(getKBRawDir(kb.id), 'a.md'))).toBe(false)
      expect(readHashes(kb.id).files['a.md']).toBeUndefined()
      expect(getKB(kb.id)?.stats.rawFileCount).toBe(0)
    })

    it('blocks path traversal and absolute paths', () => {
      const kb = createKB({ name: 'RmGuard' })
      // meta.json lives one level above raw/ — must not be reachable.
      expect(removeRawFile(kb.id, '../meta.json')).toBe(false)
      expect(removeRawFile(kb.id, path.join('sub', '..', '..', 'meta.json'))).toBe(false)
      expect(removeRawFile(kb.id, getKBMetaPath(kb.id))).toBe(false)
      expect(fs.existsSync(getKBMetaPath(kb.id))).toBe(true)
      expect(removeRawFile(kb.id, 'not-there.md')).toBe(false)
    })
  })

  describe('getRawFileLearnedStatus', () => {
    it('is learned iff hash matches AND extracted text exists', () => {
      const kb = createKB({ name: 'Learn' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [
        writeScratchFile(scratch, 'learned.md', 'aaa'),
        writeScratchFile(scratch, 'stale.md', 'bbb'),
        writeScratchFile(scratch, 'no-text.md', 'ccc'),
        writeScratchFile(scratch, 'never.md', 'ddd'),
      ])
      fs.writeFileSync(path.join(getKBTextDir(kb.id), 'l.txt'), 'aaa', 'utf-8')
      fs.writeFileSync(path.join(getKBTextDir(kb.id), 's.txt'), 'old', 'utf-8')
      writeHashes(kb.id, {
        version: 1,
        files: {
          'learned.md': { hash: sha256('aaa'), ingestedAt: 'now', textPath: 'l.txt' },
          'stale.md': { hash: sha256('OLD CONTENT'), ingestedAt: 'now', textPath: 's.txt' },
          'no-text.md': { hash: sha256('ccc'), ingestedAt: 'now', textPath: 'missing.txt' },
        },
      })

      const statuses = getRawFileLearnedStatus(kb.id)
      const byPath = Object.fromEntries(statuses.map(s => [s.path, s.learned]))
      expect(byPath['learned.md']).toBe(true)
      expect(byPath['stale.md']).toBe(false) // hash mismatch
      expect(byPath['no-text.md']).toBe(false) // textPath missing on disk
      expect(byPath['never.md']).toBe(false) // no hashes entry
      // Sorted by path
      expect(statuses.map(s => s.path)).toEqual([...statuses.map(s => s.path)].sort())
    })

    it('derives the refined state (learned / no-text / failed / pending)', () => {
      const kb = createKB({ name: 'States' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [
        writeScratchFile(scratch, 'ok.md', 'aaa'),
        writeScratchFile(scratch, 'scan.md', 'bbb'),
        writeScratchFile(scratch, 'broken.md', 'ccc'),
        writeScratchFile(scratch, 'stale-fail.md', 'ddd'),
        writeScratchFile(scratch, 'fresh.md', 'eee'),
      ])
      fs.writeFileSync(path.join(getKBTextDir(kb.id), 'ok.txt'), 'aaa', 'utf-8')
      writeHashes(kb.id, {
        version: 1,
        files: {
          'ok.md': { hash: sha256('aaa'), ingestedAt: 't', textPath: 'ok.txt' },
          'scan.md': { hash: sha256('bbb'), ingestedAt: 't', empty: true },
          'broken.md': { hash: sha256('ccc'), ingestedAt: 't', lastError: 'parser exploded' },
          // Error from a previous version of the bytes: hash mismatch → pending.
          'stale-fail.md': { hash: sha256('OLD'), ingestedAt: 't', lastError: 'old failure' },
        },
      })

      const byPath = Object.fromEntries(getRawFileLearnedStatus(kb.id).map(s => [s.path, s]))
      expect(byPath['ok.md']).toMatchObject({ state: 'learned', learned: true })
      expect(byPath['scan.md']).toMatchObject({ state: 'no-text', learned: false })
      expect(byPath['broken.md']).toMatchObject({ state: 'failed', learned: false, error: 'parser exploded' })
      expect(byPath['stale-fail.md']).toMatchObject({ state: 'pending', learned: false })
      expect(byPath['stale-fail.md'].error).toBeUndefined()
      expect(byPath['fresh.md']).toMatchObject({ state: 'pending', learned: false })
    })

    it('lists watched-folder files (keyed by absolute path) tagged source=linked', () => {
      const kb = createKB({ name: 'Watched' })
      const rawScratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(rawScratch, 'own.md', 'own')])

      const watched = makeScratchDir()
      const linkedDoc = writeScratchFile(watched, 'memo.md', 'watched content')
      writeScratchFile(watched, 'ignore.ts', 'const x = 1') // non-document → excluded
      addLinkedDir(kb.id, { path: watched, label: 'Onboarding' })

      // Mark the watched doc learned (linked sources are keyed by absolute path).
      fs.writeFileSync(path.join(getKBTextDir(kb.id), 'w.txt'), 'watched content', 'utf-8')
      writeHashes(kb.id, {
        version: 1,
        files: {
          'own.md': { hash: sha256('own'), ingestedAt: 't', textPath: 'own.txt' },
          [linkedDoc]: { hash: sha256('watched content'), ingestedAt: 't', textPath: 'w.txt' },
        },
      })
      fs.writeFileSync(path.join(getKBTextDir(kb.id), 'own.txt'), 'own', 'utf-8')

      const statuses = getRawFileLearnedStatus(kb.id)
      const byPath = Object.fromEntries(statuses.map(s => [s.path, s]))

      // The raw file stays source=raw with its relative path.
      expect(byPath['own.md']).toMatchObject({ source: 'raw', state: 'learned' })
      // The watched file appears, keyed by its absolute path, tagged linked.
      expect(byPath[linkedDoc]).toMatchObject({
        source: 'linked',
        dirLabel: 'Onboarding',
        state: 'learned',
        name: 'memo.md',
      })
      // The non-document watched file is not listed.
      expect(statuses.some(s => s.name === 'ignore.ts')).toBe(false)
    })
  })

  describe('hashes persistence', () => {
    it('round-trips and resets on corruption', () => {
      const kb = createKB({ name: 'Hash' })
      const data = { version: 1 as const, files: { 'a.md': { hash: 'h', ingestedAt: 't', textPath: 'x.txt' } } }
      writeHashes(kb.id, data)
      expect(readHashes(kb.id)).toEqual(data)
      expect(fs.existsSync(getKBHashesPath(kb.id) + '.tmp')).toBe(false)

      fs.writeFileSync(getKBHashesPath(kb.id), 'garbage', 'utf-8')
      expect(readHashes(kb.id)).toEqual({ version: 1, files: {} })
    })

    it('returns empty for a KB without a hashes file', () => {
      expect(readHashes('nonexistent-kb')).toEqual({ version: 1, files: {} })
    })
  })

  describe('resolveSources', () => {
    it('maps read text files back to raw and linked sources, deduped', () => {
      const kb = createKB({ name: 'Src' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(scratch, 'doc.md', 'raw doc')])
      const linkedFile = writeScratchFile(scratch, 'linked-note.md', 'linked doc')
      writeHashes(kb.id, {
        version: 1,
        files: {
          'doc.md': { hash: 'h1', ingestedAt: 't', textPath: 'aaa.txt' },
          [linkedFile]: { hash: 'h2', ingestedAt: 't', textPath: 'bbb.txt' },
          'gone.md': { hash: 'h3', ingestedAt: 't', textPath: 'ccc.txt' },
        },
      })

      const textDir = getKBTextDir(kb.id)
      const sources = resolveSources(kb.id, [
        path.join(textDir, 'aaa.txt'),
        'bbb.txt', // bare filename also resolves
        path.join(textDir, 'aaa.txt'), // duplicate read deduped
        path.join(textDir, 'ccc.txt'), // source file missing → filtered
        path.join(textDir, 'zzz.txt'), // unknown text file → ignored
      ])

      expect(sources).toHaveLength(2)
      expect(sources).toContainEqual({ name: 'doc.md', path: path.join(getKBRawDir(kb.id), 'doc.md') })
      expect(sources).toContainEqual({ name: 'linked-note.md', path: linkedFile })
    })
  })

  describe('resolveSourcesForReadPaths', () => {
    it('groups paths by KB under the tlon root and ignores outside paths', () => {
      const scratch = makeScratchDir()
      const kb1 = createKB({ name: 'One' })
      const kb2 = createKB({ name: 'Two' })
      addRawFiles(kb1.id, [writeScratchFile(scratch, 'one.md', '1')])
      addRawFiles(kb2.id, [writeScratchFile(scratch, 'two.md', '2')])
      writeHashes(kb1.id, { version: 1, files: { 'one.md': { hash: 'h', ingestedAt: 't', textPath: 'a.txt' } } })
      writeHashes(kb2.id, { version: 1, files: { 'two.md': { hash: 'h', ingestedAt: 't', textPath: 'b.txt' } } })

      const sources = resolveSourcesForReadPaths([
        path.join(getKBTextDir(kb1.id), 'a.txt'),
        path.join(getKBTextDir(kb2.id), 'b.txt'),
        path.join(getTestDir(), 'outside', 'a.txt'),
      ])
      expect(sources.map(s => s.name).sort()).toEqual(['one.md', 'two.md'])
    })
  })

  describe('conversation integration', () => {
    it('seeds a new conversation with space-bound KBs plus the default, deduped', () => {
      const bound = createKB({ name: 'Bound' })
      const other = createKB({ name: 'Other' })
      const def = createKB({ name: 'Default' })
      bindToSpace(bound.id, 'space-1')
      setDefaultKB(def.id)

      const seeded = getSeedKBIds('space-1').sort()
      expect(seeded).toEqual([bound.id, def.id].sort())
      // A KB bound to a different space is not seeded here.
      expect(getSeedKBIds('space-1')).not.toContain(other.id)
    })

    it('keeps seed ids regardless of status (use-time gating resolves them)', () => {
      // Space bindings snapshot at creation; status/index availability is gated
      // later by getKBReferenceById, so a paused KB is still seeded.
      const kb = createKB({ name: 'Paused' })
      bindToSpace(kb.id, 'space-2')
      updateKB(kb.id, { status: 'paused' })
      expect(getSeedKBIds('space-2')).toEqual([kb.id])
      expect(getKBReferenceById(kb.id)).toBeNull()
    })

    it('getKBChatContext returns the text dir as work dir, creating it if needed', () => {
      const kb = createKB({ name: 'Chat' })
      fs.rmSync(getKBTextDir(kb.id), { recursive: true, force: true })
      const ctx = getKBChatContext(kb.id)
      expect(ctx?.workDir).toBe(getKBTextDir(kb.id))
      expect(fs.existsSync(getKBTextDir(kb.id))).toBe(true)
      expect(ctx?.reference.name).toBe('Chat')
      expect(getKBChatContext('missing')).toBeNull()
    })

    it('strips a markdown fence wrapper from index.md', () => {
      const kb = createKB({ name: 'Fence' })
      fs.writeFileSync(getKBIndexMdPath(kb.id), '```markdown\n# Inner\n```', 'utf-8')
      expect(getKBReferenceById(kb.id)?.indexContent).toBe('# Inner')
    })
  })

  describe('refreshStats', () => {
    it('counts raw files, bytes, and .txt files in text/', () => {
      const kb = createKB({ name: 'Stats' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [
        writeScratchFile(scratch, 'a.md', '123'),
        writeScratchFile(scratch, 'b.txt', '4567'),
      ])
      fs.writeFileSync(path.join(getKBTextDir(kb.id), 'x.txt'), 'extracted', 'utf-8')
      fs.writeFileSync(path.join(getKBTextDir(kb.id), 'not-counted.md'), 'nope', 'utf-8')

      const stats = refreshStats(kb.id)
      expect(stats.rawFileCount).toBe(2)
      expect(stats.rawSizeBytes).toBe(7)
      expect(stats.indexedCount).toBe(1)
    })

    it('counts watched-folder documents toward the total (accepted files only)', () => {
      const kb = createKB({ name: 'StatsWatched' })
      const rawScratch = makeScratchDir()
      addRawFiles(kb.id, [writeScratchFile(rawScratch, 'a.md', '12')])

      const watched = makeScratchDir()
      writeScratchFile(watched, 'doc.md', '345')       // accepted → counted
      writeScratchFile(watched, 'code.ts', 'ignored')  // rejected → not counted
      addLinkedDir(kb.id, { path: watched, label: 'Docs' })

      const stats = refreshStats(kb.id)
      expect(stats.rawFileCount).toBe(2)          // 1 raw + 1 accepted watched
      expect(stats.rawSizeBytes).toBe(2 + 3)      // "12" + "345"
    })
  })

  describe('clearWikiAndHashes', () => {
    it('wipes text/ and hashes and restores the default index', () => {
      const kb = createKB({ name: 'Clear' })
      fs.writeFileSync(path.join(getKBTextDir(kb.id), 'x.txt'), 'old', 'utf-8')
      writeHashes(kb.id, { version: 1, files: { 'a.md': { hash: 'h', ingestedAt: 't', textPath: 'x.txt' } } })
      fs.writeFileSync(getKBIndexMdPath(kb.id), '# Custom map', 'utf-8')

      expect(clearWikiAndHashes(kb.id)).toBe(true)
      expect(fs.readdirSync(getKBTextDir(kb.id))).toEqual([])
      expect(readHashes(kb.id)).toEqual({ version: 1, files: {} })
      expect(fs.readFileSync(getKBIndexMdPath(kb.id), 'utf-8')).toBe(DEFAULT_INDEX_MD)
      expect(clearWikiAndHashes('missing')).toBe(false)
    })
  })

  describe('collectIngestCandidates', () => {
    it('includes new/changed sources and skips ingested, empty, and binary ones', () => {
      const kb = createKB({ name: 'Cand' })
      const scratch = makeScratchDir()
      addRawFiles(kb.id, [
        writeScratchFile(scratch, 'new.md', 'new'),
        writeScratchFile(scratch, 'done.md', 'done'),
        writeScratchFile(scratch, 'was-empty.md', 'empty-content'),
        writeScratchFile(scratch, 'legacy.md', 'legacy'),
        writeScratchFile(scratch, 'changed.md', 'v2'),
      ])
      // A raw .md whose bytes are binary must be skipped by the NUL guard.
      fs.writeFileSync(path.join(getKBRawDir(kb.id), 'binary.md'), Buffer.from([0x61, 0x00, 0x62]))
      // A UTF-16 BOM file is NUL-heavy but valid text — must remain a candidate.
      fs.writeFileSync(
        path.join(getKBRawDir(kb.id), 'utf16.txt'),
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wide', 'utf16le')]),
      )
      fs.writeFileSync(path.join(getKBTextDir(kb.id), 'done.txt'), 'x', 'utf-8')
      writeHashes(kb.id, {
        version: 1,
        files: {
          'done.md': { hash: sha256('done'), ingestedAt: 't', textPath: 'done.txt' },
          'was-empty.md': { hash: sha256('empty-content'), ingestedAt: 't', empty: true },
          // Legacy entry: matching hash but neither textPath nor empty → re-extract.
          'legacy.md': { hash: sha256('legacy'), ingestedAt: 't' },
          'changed.md': { hash: sha256('v1'), ingestedAt: 't', textPath: 'done.txt' },
        },
      })

      const candidates = collectIngestCandidates(kb.id).map(c => c.sourcePath).sort()
      expect(candidates).toEqual(['changed.md', 'legacy.md', 'new.md', 'utf16.txt'])
    })

    it('includes accepted files from linked dirs keyed by absolute path', () => {
      const scratch = makeScratchDir()
      const linkedDir = path.join(scratch, 'linked')
      const linkedFile = writeScratchFile(linkedDir, 'note.md', 'linked')
      writeScratchFile(linkedDir, 'skip.py', 'code')
      const kb = createKB({ name: 'CandLinked', linkedDirs: [{ path: linkedDir, label: 'l' }] })

      const candidates = collectIngestCandidates(kb.id)
      expect(candidates).toEqual([
        { sourcePath: linkedFile, absolutePath: linkedFile, sourceType: 'linked' },
      ])
    })
  })
})
