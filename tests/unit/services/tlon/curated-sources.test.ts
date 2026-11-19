/**
 * Curated, versioned document sets: a batch lands all at once, folder versions
 * reach the map and citations, the map groups by folder, per-KB limits apply,
 * and an unlinked folder can be forgotten without leaving a gap.
 *
 * Real temp files only; the watcher is mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { getTestDir } from '../../setup'

const rescanKB = vi.fn()
vi.mock('../../../../src/main/services/tlon/watcher', () => ({
  startWatchersForKB: vi.fn(async () => {}),
  stopWatchersForKB: vi.fn(async () => {}),
  startLinkedDirWatch: vi.fn(async () => {}),
  stopLinkedDirWatch: vi.fn(async () => {}),
  refreshLinkedWatches: vi.fn(async () => {}),
  rescanKB: (...args: unknown[]) => rescanKB(...args),
}))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))

// Extraction of a file whose name contains "slow" waits for the gate.
let slowGate: Promise<void> | null = null
let slowReached: (() => void) | null = null
vi.mock('../../../../src/main/services/tlon/extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/services/tlon/extract')>()
  return {
    ...actual,
    extractText: async (absPath: string, buf: Buffer) => {
      if (slowGate && absPath.includes('slow')) {
        slowReached?.()
        await slowGate
      }
      return actual.extractText(absPath, buf)
    },
  }
})

import {
  _resetTlonRegistry,
  _resetTlonHashCache,
  createKB,
  getKB,
  listKBs,
  updateKB,
  addRawFiles,
  addLinkedDir,
  removeLinkedDir,
  readHashes,
  writeHashes,
  resolveSources,
  sha256,
  FORGET_GRACE_MS,
} from '../../../../src/main/services/tlon/service'
import {
  enqueueFiles,
  processQueue,
  triggerFullIngest,
  hasPendingCommit,
} from '../../../../src/main/services/tlon/ingest'
import { resolveFolderVersion } from '../../../../src/main/services/tlon/version'
import { getKBTextDir, getKBIndexMdPath, getKBStagingDir, getKBRetainedDir } from '../../../../src/main/services/tlon/paths'
import { initializeApp } from '../../../../src/main/foundation/config.service'

function scratch(): string {
  const dir = path.join(getTestDir(), 'scratch-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function put(dir: string, name: string, content: string): string {
  const p = path.join(dir, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}

function corpusContains(kbId: string, needle: string): boolean {
  const dir = getKBTextDir(kbId)
  if (!fs.existsSync(dir)) return false
  return fs.readdirSync(dir).some(f => fs.readFileSync(path.join(dir, f), 'utf-8').includes(needle))
}

function indexMd(kbId: string): string {
  return fs.readFileSync(getKBIndexMdPath(kbId), 'utf-8')
}

function textName(sourcePath: string): string {
  return sha256(sourcePath).slice(0, 16) + '.txt'
}

function linkOk(kbId: string, dir: string, label = 'docs') {
  const add = addLinkedDir(kbId, { path: dir, label })
  if (!add.ok) throw new Error(`link failed: ${add.reason}`)
  return add.linked
}

function holdSlowExtraction(): { reached: Promise<void>; release: () => void } {
  let release!: () => void
  slowGate = new Promise<void>(r => { release = r })
  const reached = new Promise<void>(r => { slowReached = r })
  return { reached, release }
}

describe('Tlon curated sources', () => {
  beforeEach(async () => {
    _resetTlonRegistry()
    _resetTlonHashCache()
    slowGate = null
    slowReached = null
    rescanKB.mockClear()
    await initializeApp()
  })

  afterEach(async () => {
    slowGate = null
    await vi.dynamicImportSettled()
  })

  describe('a batch lands all at once', () => {
    it('text extracted mid-batch is staged, not searchable, until the batch commits', async () => {
      const kb = createKB({ name: 'Batch' })
      const dir = scratch()
      put(dir, 'a-fast.md', 'FAST-TOKEN')
      put(dir, 'z-slow.md', 'SLOW-TOKEN')
      addRawFiles(kb.id, [path.join(dir, 'a-fast.md'), path.join(dir, 'z-slow.md')])
      enqueueFiles(kb.id, [
        { sourcePath: 'a-fast.md', absolutePath: path.join(dir, 'a-fast.md'), sourceType: 'raw' },
        { sourcePath: 'z-slow.md', absolutePath: path.join(dir, 'z-slow.md'), sourceType: 'raw' },
      ])
      const hold = holdSlowExtraction()
      const run = processQueue(kb.id)
      await hold.reached

      expect(corpusContains(kb.id, 'FAST-TOKEN')).toBe(false)
      expect(readHashes(kb.id).files['a-fast.md']).toBeUndefined()
      expect(fs.readdirSync(getKBStagingDir(kb.id))).toContain(textName('a-fast.md'))

      hold.release()
      await run
      expect(corpusContains(kb.id, 'FAST-TOKEN')).toBe(true)
      expect(corpusContains(kb.id, 'SLOW-TOKEN')).toBe(true)
      expect(readHashes(kb.id).files['a-fast.md']?.textPath).toBe(textName('a-fast.md'))
      expect(fs.existsSync(getKBStagingDir(kb.id))).toBe(false)
    })

    it('the commit merges into the current records instead of overwriting them', async () => {
      const kb = createKB({ name: 'Merge' })
      const dir = scratch()
      put(dir, 'slow.md', 'MERGE-TOKEN')
      addRawFiles(kb.id, [path.join(dir, 'slow.md')])
      enqueueFiles(kb.id, [{ sourcePath: 'slow.md', absolutePath: path.join(dir, 'slow.md'), sourceType: 'raw' }])
      const hold = holdSlowExtraction()
      const run = processQueue(kb.id)
      await hold.reached

      const hashes = readHashes(kb.id)
      hashes.files['other.md'] = { hash: 'h', ingestedAt: new Date().toISOString(), empty: true }
      writeHashes(kb.id, hashes)

      hold.release()
      await run
      const after = readHashes(kb.id)
      expect(after.files['other.md']?.empty).toBe(true)
      expect(after.files['slow.md']?.textPath).toBe(textName('slow.md'))
    })

    it('a source extracted earlier in the batch is not queued again by a mid-batch scan', async () => {
      const kb = createKB({ name: 'Requeue' })
      const dir = scratch()
      put(dir, 'a.md', 'A')
      put(dir, 'slow.md', 'S')
      addRawFiles(kb.id, [path.join(dir, 'a.md'), path.join(dir, 'slow.md')])
      const raw = (name: string) => ({ sourcePath: name, absolutePath: path.join(dir, name), sourceType: 'raw' as const })
      enqueueFiles(kb.id, [raw('a.md'), raw('slow.md')])
      const hold = holdSlowExtraction()
      const run = processQueue(kb.id)
      await hold.reached
      enqueueFiles(kb.id, [raw('a.md')])
      hold.release()
      await run
      expect(fs.readFileSync(getKBIndexMdPath(kb.id), 'utf-8').match(/\*\*a\.md\*\*/g)?.length).toBe(1)
    })
  })

  describe('folder versions', () => {
    it('reads VERSION.md, records it, names it in the map and in citations, and follows a change', async () => {
      const kb = createKB({ name: 'Versions' })
      const dir = scratch()
      put(dir, 'VERSION.md', '# v1.2.3\n\nrelease notes')
      const doc = put(dir, 'policy.md', 'POLICY-TOKEN')
      linkOk(kb.id, dir, 'Policies')
      await triggerFullIngest(kb.id)

      const hashes = readHashes(kb.id)
      expect(hashes.versions?.[dir]).toBe('v1.2.3')
      expect(hashes.files[doc]?.version).toBe('v1.2.3')
      expect(indexMd(kb.id)).toContain('## Policies (version v1.2.3)')
      const cited = resolveSources(kb.id, [path.join(getKBTextDir(kb.id), textName(doc))])
      expect(cited).toEqual([{ name: 'policy.md', path: doc, version: 'v1.2.3' }])

      put(dir, 'VERSION.md', 'v1.2.4')
      expect(hasPendingCommit(kb.id)).toBe(true)
      await triggerFullIngest(kb.id)
      expect(readHashes(kb.id).versions?.[dir]).toBe('v1.2.4')
      expect(indexMd(kb.id)).toContain('(version v1.2.4)')
      expect(hasPendingCommit(kb.id)).toBe(false)
    })

    it('falls back to the enclosing git commit, loose or packed, and refuses odd refs', () => {
      const sha = 'a'.repeat(40)
      const repo = scratch()
      const sub = path.join(repo, 'docs')
      fs.mkdirSync(sub)
      put(repo, '.git/HEAD', 'ref: refs/heads/main\n')
      put(repo, '.git/refs/heads/main', sha + '\n')
      expect(resolveFolderVersion(sub)).toBe(sha.slice(0, 12))

      const packed = scratch()
      put(packed, '.git/HEAD', 'ref: refs/heads/rel\n')
      put(packed, '.git/packed-refs', `# pack-refs\n${'b'.repeat(40)} refs/heads/rel\n`)
      expect(resolveFolderVersion(packed)).toBe('b'.repeat(12))

      const detached = scratch()
      put(detached, '.git/HEAD', 'c'.repeat(40) + '\n')
      expect(resolveFolderVersion(detached)).toBe('c'.repeat(12))

      const odd = scratch()
      put(odd, '.git/HEAD', 'ref: refs/../../../etc/x\n')
      expect(resolveFolderVersion(odd)).toBeUndefined()
    })

    it('keeps the last version of a folder that is unreachable right now', async () => {
      const kb = createKB({ name: 'Unreachable' })
      const dir = scratch()
      put(dir, 'VERSION.md', 'r7')
      put(dir, 'a.md', 'A')
      linkOk(kb.id, dir)
      await triggerFullIngest(kb.id)
      const away = dir + '-away'
      fs.renameSync(dir, away)
      expect(hasPendingCommit(kb.id)).toBe(false)
      fs.renameSync(away, dir)
      expect(readHashes(kb.id).versions?.[dir]).toBe('r7')
    })
  })

  describe('document map', () => {
    it('groups by watched folder with folder-relative names, then added files; uses a front-matter summary', async () => {
      const kb = createKB({ name: 'Map' })
      const dir = scratch()
      put(dir, 'guides/setup.md', '---\ntitle: Setup\ndescription: "How to set it up"\n---\n\nbody')
      put(dir, 'faq.md', 'Frequently asked')
      const extra = scratch()
      put(extra, 'notes.md', 'Loose notes')
      addRawFiles(kb.id, [path.join(extra, 'notes.md')])
      linkOk(kb.id, dir, 'Handbook')
      await triggerFullIngest(kb.id)

      const md = indexMd(kb.id)
      expect(md).toContain('## Handbook\n')
      expect(md).toContain('- **guides/setup.md** — How to set it up')
      expect(md).toContain('- **faq.md** — Frequently asked')
      expect(md).toContain('## Added files')
      expect(md.indexOf('## Handbook')).toBeLessThan(md.indexOf('## Added files'))
      expect(md.indexOf('## Added files')).toBeLessThan(md.indexOf('**notes.md**'))
    })

    it('without watched folders keeps one flat list', async () => {
      const kb = createKB({ name: 'Flat' })
      const dir = scratch()
      put(dir, 'one.md', 'one')
      addRawFiles(kb.id, [path.join(dir, 'one.md')])
      await triggerFullIngest(kb.id)
      const md = indexMd(kb.id)
      expect(md).not.toContain('## ')
      expect(md).toContain('- **one.md** — one')
    })

    it('lists at most mapMaxDocs documents', async () => {
      const kb = createKB({ name: 'Cap', options: { mapMaxDocs: 2 } })
      const dir = scratch()
      for (const n of ['a', 'b', 'c']) put(dir, `${n}.md`, n)
      linkOk(kb.id, dir)
      await triggerFullIngest(kb.id)
      const md = indexMd(kb.id)
      expect(md.match(/^- \*\*/gm)?.length).toBe(2)
      expect(md).toContain('…and 1 more documents')
    })
  })

  describe('per-KB options', () => {
    it('rejects bad options whole, before anything is written', () => {
      const count = listKBs().length
      expect(() => createKB({ name: 'Bad', options: { maxLinkedFiles: 0 } })).toThrow(/maxLinkedFiles/)
      expect(() => createKB({ name: 'Bad', options: { mapMaxDocs: 2001 } })).toThrow(/mapMaxDocs/)
      expect(() => createKB({ name: 'Bad', options: { extraExtensions: ['.exe'] } })).toThrow(/not a text format/)
      expect(() => createKB({ name: 'Bad', options: { extraExtensions: ['../x'] } })).toThrow(/invalid extension/)
      expect(listKBs().length).toBe(count)

      const kb = createKB({ name: 'Good', options: { extraExtensions: ['YAML', '.yaml'] } })
      expect(kb.options).toEqual({ extraExtensions: ['.yaml'] })
      expect(() => updateKB(kb.id, { name: 'Renamed', options: { maxLinkedFiles: 1.5 } })).toThrow()
      expect(getKB(kb.id)?.name).toBe('Good')
      updateKB(kb.id, { options: null })
      expect(getKB(kb.id)?.options).toBeUndefined()
    })

    it('a raised file cap admits a folder the default would refuse', async () => {
      const kb = createKB({ name: 'Files', options: { maxLinkedFiles: 2 } })
      const dir = scratch()
      for (const n of ['a', 'b', 'c']) put(dir, `${n}.md`, n)
      const refused = addLinkedDir(kb.id, { path: dir, label: 'd' })
      expect(refused).toMatchObject({ ok: false, reason: 'too-many-files', count: 3, limit: 2 })
      updateKB(kb.id, { options: { maxLinkedFiles: 5 } })
      expect(addLinkedDir(kb.id, { path: dir, label: 'd' }).ok).toBe(true)
    })

    it('learns extra extensions, and retires them once no longer accepted', async () => {
      const kb = createKB({ name: 'Ext', options: { extraExtensions: ['.yaml'] } })
      const dir = scratch()
      const yaml = put(dir, 'spec.yaml', 'YAML-TOKEN: 1')
      put(dir, 'readme.md', 'README-TOKEN')
      linkOk(kb.id, dir)
      await triggerFullIngest(kb.id)
      expect(corpusContains(kb.id, 'YAML-TOKEN')).toBe(true)

      updateKB(kb.id, { options: null })
      await vi.dynamicImportSettled()
      expect(corpusContains(kb.id, 'YAML-TOKEN')).toBe(false)
      expect(readHashes(kb.id).files[yaml]).toBeUndefined()
      expect(corpusContains(kb.id, 'README-TOKEN')).toBe(true)
      expect(rescanKB).toHaveBeenCalledWith(kb.id)
    })
  })

  describe('forgetting an unlinked folder', () => {
    it('by default unlinking keeps what was learned', async () => {
      const kb = createKB({ name: 'Keep' })
      const dir = scratch()
      put(dir, 'a.md', 'KEEP-TOKEN')
      const linked = linkOk(kb.id, dir)
      await triggerFullIngest(kb.id)
      removeLinkedDir(kb.id, linked.id)
      await vi.dynamicImportSettled()
      expect(readHashes(kb.id).forget).toBeUndefined()
      await triggerFullIngest(kb.id)
      expect(corpusContains(kb.id, 'KEEP-TOKEN')).toBe(true)
    })

    it('is deferred to the next batch, which first lands the replacement folder', async () => {
      const kb = createKB({ name: 'Swap' })
      const oldDir = scratch()
      put(oldDir, 'policy.md', 'OLD-TOKEN')
      const oldLink = linkOk(kb.id, oldDir)
      await triggerFullIngest(kb.id)

      removeLinkedDir(kb.id, oldLink.id, { forget: true })
      await vi.dynamicImportSettled()
      expect(rescanKB).toHaveBeenCalledWith(kb.id, FORGET_GRACE_MS)
      expect(readHashes(kb.id).forget).toEqual([oldDir])
      expect(corpusContains(kb.id, 'OLD-TOKEN')).toBe(true)

      const newDir = scratch()
      put(newDir, 'slow-policy.md', 'NEW-TOKEN')
      linkOk(kb.id, newDir)
      const hold = holdSlowExtraction()
      const run = triggerFullIngest(kb.id)
      await hold.reached
      // Mid-batch the previous set is still complete.
      expect(corpusContains(kb.id, 'OLD-TOKEN')).toBe(true)
      expect(corpusContains(kb.id, 'NEW-TOKEN')).toBe(false)
      hold.release()
      await run

      expect(corpusContains(kb.id, 'NEW-TOKEN')).toBe(true)
      expect(corpusContains(kb.id, 'OLD-TOKEN')).toBe(false)
      expect(readHashes(kb.id).files[path.join(oldDir, 'policy.md')]).toBeUndefined()
      expect(readHashes(kb.id).forget).toBeUndefined()
      expect(indexMd(kb.id)).not.toContain('**policy.md**')
    })

    it('applies on its own when nothing else is learned', async () => {
      const kb = createKB({ name: 'Alone' })
      const dir = scratch()
      put(dir, 'a.md', 'ALONE-TOKEN')
      const linked = linkOk(kb.id, dir)
      await triggerFullIngest(kb.id)
      removeLinkedDir(kb.id, linked.id, { forget: true })
      await vi.dynamicImportSettled()
      expect(hasPendingCommit(kb.id)).toBe(true)
      await processQueue(kb.id)
      expect(corpusContains(kb.id, 'ALONE-TOKEN')).toBe(false)
      expect(hasPendingCommit(kb.id)).toBe(false)
    })

    it('is cancelled when the same folder is linked again', async () => {
      const kb = createKB({ name: 'Relink' })
      const dir = scratch()
      put(dir, 'a.md', 'RELINK-TOKEN')
      const linked = linkOk(kb.id, dir)
      await triggerFullIngest(kb.id)
      removeLinkedDir(kb.id, linked.id, { forget: true })
      await vi.dynamicImportSettled()
      linkOk(kb.id, dir)
      expect(readHashes(kb.id).forget).toBeUndefined()
      await triggerFullIngest(kb.id)
      expect(corpusContains(kb.id, 'RELINK-TOKEN')).toBe(true)
    })

    it('keeps owner-maintained text out of search rather than deleting it', async () => {
      const kb = createKB({ name: 'Protected' })
      const dir = scratch()
      const doc = put(dir, 'a.md', 'ORIGINAL')
      const linked = linkOk(kb.id, dir)
      await triggerFullIngest(kb.id)
      const hashes = readHashes(kb.id)
      const record = hashes.files[doc]
      const textFile = path.join(getKBTextDir(kb.id), record.textPath!)
      fs.writeFileSync(textFile, fs.readFileSync(textFile, 'utf-8') + '\nOWNER-EDIT')
      hashes.files[doc] = {
        ...record,
        protection: { revision: 1, sourceHash: record.hash, textPath: record.textPath!, scope: 'path', reason: 'kept' },
      }
      writeHashes(kb.id, hashes)
      const maintained = fs.readFileSync(textFile, 'utf-8')

      removeLinkedDir(kb.id, linked.id, { forget: true })
      await vi.dynamicImportSettled()
      await processQueue(kb.id)
      expect(corpusContains(kb.id, 'OWNER-EDIT')).toBe(false)
      expect(fs.readFileSync(path.join(getKBRetainedDir(kb.id), record.textPath!), 'utf-8')).toBe(maintained)
    })
  })
})
