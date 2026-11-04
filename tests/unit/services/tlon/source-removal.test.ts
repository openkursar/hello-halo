/**
 * Removed sources leave the knowledge base's searchable corpus.
 *
 * Real temp files only. A KB chat Greps/Reads its text/ dir and is shown the
 * index.md document map, so "no longer found" means: no text file containing
 * the content, no index entry, no learned record and no stats count.
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
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))

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
  addRawFiles,
  addLinkedDir,
  removeLinkedDir,
  removeRawFile,
  readHashes,
  writeHashes,
  refreshStats,
  collectIngestCandidates,
  retireRemovedSources,
  sha256,
} from '../../../../src/main/services/tlon/service'
import {
  enqueueFiles,
  processQueue,
  triggerFullIngest,
  migrateKBsToTextIndex,
  sweepRemovedSourcesAndIndex,
  collectCandidatesRetiringRemoved,
} from '../../../../src/main/services/tlon/ingest'
import { getKBTextDir, getKBRawDir, getKBIndexMdPath, getKBRetainedDir, getKBRetirementMarkerPath } from '../../../../src/main/services/tlon/paths'
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

/** What the KB chat's Grep over its working directory (text/) would match. */
function corpusContains(kbId: string, needle: string): boolean {
  const dir = getKBTextDir(kbId)
  if (!fs.existsSync(dir)) return false
  return fs.readdirSync(dir).some(f => fs.readFileSync(path.join(dir, f), 'utf-8').includes(needle))
}

function indexMentions(kbId: string, needle: string): boolean {
  return fs.readFileSync(getKBIndexMdPath(kbId), 'utf-8').includes(needle)
}

function textName(sourcePath: string): string {
  return sha256(sourcePath).slice(0, 16) + '.txt'
}

async function settle(): Promise<void> {
  await vi.dynamicImportSettled()
  await new Promise(r => setTimeout(r, 0))
}

describe('Tlon source removal', () => {
  beforeEach(async () => {
    _resetTlonRegistry()
    _resetTlonHashCache()
    extractGate = null
    await initializeApp()
  })

  afterEach(async () => {
    await vi.dynamicImportSettled()
  })

  async function kbWithRaw(files: Record<string, string>) {
    const kb = createKB({ name: 'Removal KB' })
    const src = scratch()
    addRawFiles(kb.id, Object.entries(files).map(([n, c]) => put(src, n, c)))
    await triggerFullIngest(kb.id)
    return kb
  }

  it('removing an imported file retires its text, record, index entry and count', async () => {
    const kb = await kbWithRaw({ 'gone.md': 'ZEBRA-SECRET gone', 'kept.md': 'KEPT-ALPHA kept' })
    expect(corpusContains(kb.id, 'ZEBRA-SECRET')).toBe(true)

    expect(removeRawFile(kb.id, 'gone.md')).toBe(true)
    await settle()

    expect(corpusContains(kb.id, 'ZEBRA-SECRET')).toBe(false)
    expect(fs.existsSync(path.join(getKBTextDir(kb.id), textName('gone.md')))).toBe(false)
    expect(readHashes(kb.id).files['gone.md']).toBeUndefined()
    expect(indexMentions(kb.id, 'gone.md')).toBe(false)
    expect(getKB(kb.id)!.stats.indexedCount).toBe(1)
    expect(getKB(kb.id)!.stats.rawFileCount).toBe(1)

    expect(corpusContains(kb.id, 'KEPT-ALPHA')).toBe(true)
    expect(indexMentions(kb.id, 'kept.md')).toBe(true)
  })

  it('a watched file deleted or renamed is retired even when the rescan finds nothing new to learn', async () => {
    const kb = createKB({ name: 'Watched' })
    const dir = scratch()
    const doomed = put(dir, 'doomed.md', 'DOOMED-TOKEN')
    const moved = put(dir, 'old-name.md', 'RENAMED-TOKEN')
    put(dir, 'stay.md', 'STAY-TOKEN')
    addLinkedDir(kb.id, { path: dir, label: 'w' })
    await triggerFullIngest(kb.id)

    fs.rmSync(doomed)
    fs.rmSync(moved)
    await triggerFullIngest(kb.id)
    expect(corpusContains(kb.id, 'DOOMED-TOKEN')).toBe(false)
    expect(corpusContains(kb.id, 'RENAMED-TOKEN')).toBe(false)
    expect(readHashes(kb.id).files[doomed]).toBeUndefined()
    expect(indexMentions(kb.id, 'doomed.md')).toBe(false)
    expect(getKB(kb.id)!.stats.indexedCount).toBe(1)

    // The rename's new name is learned under its own key.
    const renamed = put(dir, 'new-name.md', 'RENAMED-TOKEN')
    await triggerFullIngest(kb.id)
    expect(readHashes(kb.id).files[renamed]?.textPath).toBe(textName(renamed))
    expect(readHashes(kb.id).files[moved]).toBeUndefined()
    expect(corpusContains(kb.id, 'STAY-TOKEN')).toBe(true)
  })

  it('a delete event retires only what it names, and only once proven', async () => {
    const kb = createKB({ name: 'Watched' })
    const dir = scratch()
    const doomed = put(dir, 'doomed.md', 'DOOMED-TOKEN')
    const other = put(dir, 'sub/other.md', 'OTHER-TOKEN')
    put(dir, 'stay.md', 'STAY-TOKEN')
    addLinkedDir(kb.id, { path: dir, label: 'w' })
    await triggerFullIngest(kb.id)
    fs.rmSync(doomed)
    fs.rmSync(path.join(dir, 'sub'), { recursive: true })

    // An event for a file still present is a hint, not a fact.
    expect(retireRemovedSources(kb.id, [path.join(dir, 'stay.md')])).toBe(0)
    expect(retireRemovedSources(kb.id, [doomed])).toBe(1)
    expect(corpusContains(kb.id, 'DOOMED-TOKEN')).toBe(false)
    // Not named by the event: left for its own event or a sweep.
    expect(corpusContains(kb.id, 'OTHER-TOKEN')).toBe(true)
    // A deleted folder covers what was under it.
    expect(retireRemovedSources(kb.id, [path.join(dir, 'sub')])).toBe(1)
    expect(corpusContains(kb.id, 'OTHER-TOKEN')).toBe(false)
    expect(corpusContains(kb.id, 'STAY-TOKEN')).toBe(true)
  })

  it('a deleted source stays retired across a restart', async () => {
    const kb = await kbWithRaw({ 'gone.md': 'ZEBRA-SECRET', 'kept.md': 'KEPT' })
    fs.rmSync(path.join(getKBRawDir(kb.id), 'gone.md'))

    _resetTlonRegistry()
    _resetTlonHashCache()
    await migrateKBsToTextIndex()
    expect(corpusContains(kb.id, 'ZEBRA-SECRET')).toBe(false)

    _resetTlonRegistry()
    await migrateKBsToTextIndex()
    expect(corpusContains(kb.id, 'ZEBRA-SECRET')).toBe(false)
    expect(readHashes(kb.id).files['gone.md']).toBeUndefined()
    expect(corpusContains(kb.id, 'KEPT')).toBe(true)
  })

  it('an extraction still running when its source is removed does not write the text back', async () => {
    const kb = createKB({ name: 'Race' })
    const src = scratch()
    addRawFiles(kb.id, [put(src, 'race.md', 'RACE-TOKEN')])
    let release!: () => void
    extractGate = new Promise<void>(r => { release = r })
    const raw = path.join(getKBRawDir(kb.id), 'race.md')
    enqueueFiles(kb.id, [{ sourcePath: 'race.md', absolutePath: raw, sourceType: 'raw' }])
    const run = processQueue(kb.id)
    await new Promise(r => setTimeout(r, 10))

    expect(removeRawFile(kb.id, 'race.md')).toBe(true)
    release()
    await run
    await settle()

    expect(corpusContains(kb.id, 'RACE-TOKEN')).toBe(false)
    expect(readHashes(kb.id).files['race.md']).toBeUndefined()
    expect(indexMentions(kb.id, 'race.md')).toBe(false)
  })

  it('a source deleted and recreated at the same path mid-extraction does not commit the old bytes', async () => {
    const kb = createKB({ name: 'Recreate' })
    const raw = put(getKBRawDir(kb.id), 'swap.md', 'OLD-BYTES-TOKEN')
    let release!: () => void
    extractGate = new Promise<void>(r => { release = r })
    enqueueFiles(kb.id, [{ sourcePath: 'swap.md', absolutePath: raw, sourceType: 'raw' }])
    const run = processQueue(kb.id)
    await new Promise(r => setTimeout(r, 10))

    fs.rmSync(raw)
    put(getKBRawDir(kb.id), 'swap.md', 'NEW-BYTES-TOKEN, a different file')
    release()
    await run
    expect(corpusContains(kb.id, 'OLD-BYTES-TOKEN')).toBe(false)
    expect(readHashes(kb.id).files['swap.md']).toBeUndefined()

    extractGate = null
    await triggerFullIngest(kb.id)
    expect(corpusContains(kb.id, 'NEW-BYTES-TOKEN')).toBe(true)
    expect(corpusContains(kb.id, 'OLD-BYTES-TOKEN')).toBe(false)
  })

  it('a queued job whose source is gone leaves nothing behind', async () => {
    const kb = createKB({ name: 'Queued' })
    const raw = put(getKBRawDir(kb.id), 'queued.md', 'QUEUED-TOKEN')
    enqueueFiles(kb.id, [{ sourcePath: 'queued.md', absolutePath: raw, sourceType: 'raw' }])
    fs.rmSync(raw)
    await processQueue(kb.id)
    expect(corpusContains(kb.id, 'QUEUED-TOKEN')).toBe(false)
    expect(readHashes(kb.id).files['queued.md']).toBeUndefined()
  })

  it('an unavailable watched folder keeps its learned knowledge', async () => {
    const kb = createKB({ name: 'Offline' })
    const dir = scratch()
    const file = put(dir, 'remote.md', 'REMOTE-TOKEN')
    addLinkedDir(kb.id, { path: dir, label: 'drive' })
    await triggerFullIngest(kb.id)

    // An unplugged drive: the whole folder disappears.
    fs.renameSync(dir, dir + '-parked')
    expect(retireRemovedSources(kb.id, [file])).toBe(0)
    await triggerFullIngest(kb.id)
    expect(corpusContains(kb.id, 'REMOTE-TOKEN')).toBe(true)
    expect(readHashes(kb.id).files[file]).toBeDefined()
  })

  /**
   * Mount identity is simulated through the recorded device: a surviving
   * folder on another device than the source was learned on stands for an
   * unmounted volume's mount point. No real volume is mounted or unmounted.
   */
  describe('volume identity', () => {
    async function nested() {
      const kb = createKB({ name: 'Nested' })
      const dir = scratch()
      put(dir, 'unrelated.md', 'UNRELATED')
      const file = put(dir, 'mnt/inner/doc.md', 'NESTED-TOKEN')
      addLinkedDir(kb.id, { path: dir, label: 'w' })
      await triggerFullIngest(kb.id)
      return { kb, dir, file }
    }

    function setDev(kbId: string, key: string, dev: number | undefined) {
      const hashes = readHashes(kbId)
      const record = { ...hashes.files[key] }
      if (dev === undefined) delete record.sourceDev
      else record.sourceDev = dev
      hashes.files[key] = record
      writeHashes(kbId, hashes)
    }

    it('keeps a source under a non-empty root whose surviving folder is on another device', async () => {
      const { kb, dir, file } = await nested()
      setDev(kb.id, file, -1)
      fs.rmSync(path.join(dir, 'mnt/inner'), { recursive: true })
      put(dir, 'mnt/.placeholder', '')
      expect(retireRemovedSources(kb.id, [file])).toBe(0)
      expect(await sweepRemovedSourcesAndIndex(kb.id)).toBe(0)
      expect(corpusContains(kb.id, 'NESTED-TOKEN')).toBe(true)
    })

    it('keeps a removed source when the root itself is now another device', async () => {
      const { kb, file } = await nested()
      setDev(kb.id, file, -1)
      fs.rmSync(file)
      expect(await sweepRemovedSourcesAndIndex(kb.id)).toBe(0)
      expect(corpusContains(kb.id, 'NESTED-TOKEN')).toBe(true)
    })

    it('retires a file or folder deleted on the device it was learned on', async () => {
      const { kb, dir, file } = await nested()
      expect(readHashes(kb.id).files[file].sourceDev).toBe(fs.statSync(dir).dev)
      fs.rmSync(path.join(dir, 'mnt'), { recursive: true })
      expect(retireRemovedSources(kb.id, [path.join(dir, 'mnt')])).toBe(1)
      expect(corpusContains(kb.id, 'NESTED-TOKEN')).toBe(false)
      expect(corpusContains(kb.id, 'UNRELATED')).toBe(true)
    })

    it('retires a folder the owner emptied', async () => {
      const kb = createKB({ name: 'Emptied' })
      const dir = scratch()
      const file = put(dir, 'only.md', 'ONLY-TOKEN')
      addLinkedDir(kb.id, { path: dir, label: 'w' })
      await triggerFullIngest(kb.id)
      fs.rmSync(file)
      expect(retireRemovedSources(kb.id, [file])).toBe(1)
      expect(corpusContains(kb.id, 'ONLY-TOKEN')).toBe(false)
    })

    it('keeps a record learned before devices were kept, even with a same-device non-empty parent', async () => {
      const { kb, dir, file } = await nested()
      setDev(kb.id, file, undefined)
      fs.rmSync(file)
      put(dir, 'mnt/inner/placeholder.md', 'left behind')
      expect(retireRemovedSources(kb.id, [file])).toBe(0)
      expect(await sweepRemovedSourcesAndIndex(kb.id)).toBe(0)
      expect(corpusContains(kb.id, 'NESTED-TOKEN')).toBe(true)
    })

    it('backfills the device of an old record only while its file is still there', async () => {
      const { kb, dir, file } = await nested()
      const gone = put(dir, 'gone.md', 'GONE')
      await triggerFullIngest(kb.id)
      setDev(kb.id, file, undefined)
      setDev(kb.id, gone, undefined)
      fs.rmSync(gone)
      _resetTlonHashCache()
      collectIngestCandidates(kb.id)
      expect(readHashes(kb.id).files[file].sourceDev).toBe(fs.statSync(file).dev)
      expect(readHashes(kb.id).files[gone].sourceDev).toBeUndefined()
    })
  })

  it('an unreadable path is not treated as deleted', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const kb = createKB({ name: 'Locked' })
    const dir = scratch()
    const sub = path.join(dir, 'locked')
    const file = put(sub, 'secret.md', 'LOCKED-TOKEN')
    put(dir, 'other.md', 'OTHER')
    addLinkedDir(kb.id, { path: dir, label: 'w' })
    await triggerFullIngest(kb.id)
    fs.chmodSync(sub, 0o000)
    try {
      expect(await sweepRemovedSourcesAndIndex(kb.id)).toBe(0)
      expect(readHashes(kb.id).files[file]).toBeDefined()
    } finally {
      fs.chmodSync(sub, 0o755)
    }
    expect(corpusContains(kb.id, 'LOCKED-TOKEN')).toBe(true)
  })

  it('unlinking a watched folder keeps what was already learned from it', async () => {
    const kb = createKB({ name: 'Unlink' })
    const dir = scratch()
    const file = put(dir, 'learned.md', 'UNLINK-TOKEN')
    const add = addLinkedDir(kb.id, { path: dir, label: 'w' })
    await triggerFullIngest(kb.id)
    expect(add.ok).toBe(true)
    if (!add.ok) return

    removeLinkedDir(kb.id, add.linked.id)
    fs.rmSync(file)
    expect(await sweepRemovedSourcesAndIndex(kb.id)).toBe(0)
    await triggerFullIngest(kb.id)
    expect(corpusContains(kb.id, 'UNLINK-TOKEN')).toBe(true)
    expect(readHashes(kb.id).files[file]?.textPath).toBe(textName(file))
    expect(indexMentions(kb.id, 'learned.md')).toBe(true)
  })

  it('owner-maintained (protected) text of a removed source is kept but leaves search', async () => {
    const kb = await kbWithRaw({ 'book.md': 'BOOK-TOKEN', 'kept.md': 'KEPT' })
    const hashes = readHashes(kb.id)
    const record = hashes.files['book.md']
    const textFile = path.join(getKBTextDir(kb.id), record.textPath!)
    fs.writeFileSync(textFile, fs.readFileSync(textFile, 'utf-8') + '\nOWNER-EDIT')
    hashes.files['book.md'] = {
      ...record,
      protection: { revision: 1, sourceHash: record.hash, textPath: record.textPath!, scope: 'path', reason: 'kept' },
    }
    writeHashes(kb.id, hashes)
    const maintained = fs.readFileSync(textFile, 'utf-8')
    fs.rmSync(path.join(getKBRawDir(kb.id), 'book.md'))

    expect(removeRawFile(kb.id, 'book.md')).toBe(false)
    expect(await sweepRemovedSourcesAndIndex(kb.id)).toBe(1)
    expect(corpusContains(kb.id, 'BOOK-TOKEN')).toBe(false)
    expect(corpusContains(kb.id, 'OWNER-EDIT')).toBe(false)
    expect(indexMentions(kb.id, 'book.md')).toBe(false)
    expect(readHashes(kb.id).files['book.md']).toBeUndefined()
    expect(getKB(kb.id)!.stats.indexedCount).toBe(1)
    expect(fs.readFileSync(path.join(getKBRetainedDir(kb.id), record.textPath!), 'utf-8')).toBe(maintained)
    expect(corpusContains(kb.id, 'KEPT')).toBe(true)
  })

  it('protected text whose source is not provably gone stays where it is', async () => {
    const kb = createKB({ name: 'Protected offline' })
    const dir = scratch()
    const file = put(dir, 'p.md', 'PROT-TOKEN')
    addLinkedDir(kb.id, { path: dir, label: 'w' })
    await triggerFullIngest(kb.id)
    const hashes = readHashes(kb.id)
    const record = hashes.files[file]
    hashes.files[file] = { ...record, protection: { revision: 1, sourceHash: record.hash, textPath: record.textPath!, scope: 'path', reason: 'kept' } }
    writeHashes(kb.id, hashes)
    fs.renameSync(dir, dir + '-parked')
    expect(await sweepRemovedSourcesAndIndex(kb.id)).toBe(0)
    expect(corpusContains(kb.id, 'PROT-TOKEN')).toBe(true)
    expect(fs.existsSync(getKBRetainedDir(kb.id))).toBe(false)
  })

  describe('startup and scans', () => {
    it('learn everything records the one-time cleanup so the next startup skips the full pass', async () => {
      const kb = await kbWithRaw({ 'a.md': 'A' })
      expect(fs.existsSync(getKBRetirementMarkerPath(kb.id))).toBe(true)
    })

    it('the full pass runs once per KB; later startups find removals in the ingest walk alone', async () => {
      const kb = await kbWithRaw({ 'a.md': 'A-TOKEN', 'b.md': 'B-TOKEN', 'keep.md': 'KEEP' })
      // Leftover from a removal made by an earlier release.
      fs.rmSync(path.join(getKBRawDir(kb.id), 'a.md'))
      const hashes = readHashes(kb.id)
      delete hashes.files['a.md']
      writeHashes(kb.id, hashes)
      // As upgraded from a build without the cleanup.
      fs.rmSync(getKBRetirementMarkerPath(kb.id))

      await migrateKBsToTextIndex()
      expect(fs.existsSync(getKBRetirementMarkerPath(kb.id))).toBe(true)
      expect(corpusContains(kb.id, 'A-TOKEN')).toBe(false)

      // After the migration, an unrecorded leftover is not looked for again…
      put(getKBTextDir(kb.id), textName('ghost.md'), `<!-- source: ghost.md -->\n\nGHOST`)
      // …but a recorded source deleted while closed is found by the walk.
      fs.rmSync(path.join(getKBRawDir(kb.id), 'b.md'))
      _resetTlonRegistry()
      await migrateKBsToTextIndex()
      expect(corpusContains(kb.id, 'B-TOKEN')).toBe(false)
      expect(readHashes(kb.id).files['b.md']).toBeUndefined()
      expect(indexMentions(kb.id, 'b.md')).toBe(false)
      expect(corpusContains(kb.id, 'GHOST')).toBe(true)
      // An explicit "learn everything" does the full pass.
      await triggerFullIngest(kb.id)
      expect(corpusContains(kb.id, 'GHOST')).toBe(false)
      expect(corpusContains(kb.id, 'KEEP')).toBe(true)
    })

    it('a watcher scan retires a deleted watched file with no extra pass', async () => {
      const kb = createKB({ name: 'Scan' })
      const dir = scratch()
      const doomed = put(dir, 'doomed.md', 'DOOMED-TOKEN')
      put(dir, 'stay.md', 'STAY')
      addLinkedDir(kb.id, { path: dir, label: 'w' })
      await triggerFullIngest(kb.id)
      fs.rmSync(doomed)
      expect(collectCandidatesRetiringRemoved(kb.id)).toEqual([])
      expect(corpusContains(kb.id, 'DOOMED-TOKEN')).toBe(false)
      expect(indexMentions(kb.id, 'doomed.md')).toBe(false)
      expect(corpusContains(kb.id, 'STAY')).toBe(true)
    })

    it('a folder the walk could not list completely yields no suspects', async () => {
      const kb = createKB({ name: 'Partial' })
      const dir = scratch()
      const file = put(dir, 'x.md', 'X-TOKEN')
      addLinkedDir(kb.id, { path: dir, label: 'w' })
      await triggerFullIngest(kb.id)
      fs.renameSync(dir, dir + '-parked')
      expect(collectCandidatesRetiringRemoved(kb.id)).toEqual([])
      expect(readHashes(kb.id).files[file]).toBeDefined()
      expect(corpusContains(kb.id, 'X-TOKEN')).toBe(true)
    })
  })

  it('a record whose text is linked rather than Halo-owned is kept when its source is removed', async () => {
    if (process.platform === 'win32') return
    const kb = await kbWithRaw({ 'link.md': 'LINK-TOKEN', 'kept.md': 'KEPT' })
    const record = readHashes(kb.id).files['link.md']
    const textFile = path.join(getKBTextDir(kb.id), record.textPath!)
    const outside = path.join(scratch(), 'outside.txt')
    fs.renameSync(textFile, outside)
    fs.symlinkSync(outside, textFile)
    fs.rmSync(path.join(getKBRawDir(kb.id), 'link.md'))
    expect(retireRemovedSources(kb.id, ['link.md'])).toBe(0)
    expect(readHashes(kb.id).files['link.md']).toBeDefined()
    expect(fs.lstatSync(textFile).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(outside, 'utf-8')).toContain('LINK-TOKEN')
  })

  it('a cleanup failure is logged once even when nothing is kept', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const kb = await kbWithRaw({ 'f.md': 'F-TOKEN' })
    fs.rmSync(path.join(getKBRawDir(kb.id), 'f.md'))
    const textDir = getKBTextDir(kb.id)
    fs.chmodSync(textDir, 0o555)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      retireRemovedSources(kb.id, ['f.md'])
      retireRemovedSources(kb.id, ['f.md'])
      const lines = errors.mock.calls.filter(c => String(c[0]).includes('Removed-source cleanup failed'))
      expect(lines).toHaveLength(1)
      expect(String(lines[0][0])).toContain('remove-text=1')
    } finally {
      errors.mockRestore()
      fs.chmodSync(textDir, 0o755)
    }
    expect(readHashes(kb.id).files['f.md']).toBeDefined()
  })

  it('matching removed paths stays linear for a large knowledge base', async () => {
    const kb = createKB({ name: 'Scale' })
    const hashes = readHashes(kb.id)
    for (let i = 0; i < 5000; i++) hashes.files[`dir/f${i}.md`] = { hash: 'h', ingestedAt: 'x', empty: true }
    writeHashes(kb.id, hashes)
    const unseen = Array.from({ length: 500 }, (_, i) => `dir/f${i * 10}.md`)
    const started = performance.now()
    // None exist on disk, so exactly the 500 named records are retired.
    expect(retireRemovedSources(kb.id, unseen)).toBe(500)
    expect(performance.now() - started).toBeLessThan(1500)
    expect(Object.keys(readHashes(kb.id).files)).toHaveLength(4500)
  })

  describe('orphaned text from earlier removals', () => {
    it('retires generated text whose source is provably gone', async () => {
      const kb = await kbWithRaw({ 'old.md': 'ORPHAN-TOKEN', 'kept.md': 'KEPT' })
      // A removal made by an earlier release: record dropped, text left behind.
      fs.rmSync(path.join(getKBRawDir(kb.id), 'old.md'))
      const hashes = readHashes(kb.id)
      delete hashes.files['old.md']
      writeHashes(kb.id, hashes)
      expect(refreshStats(kb.id).indexedCount).toBe(2)

      expect(await sweepRemovedSourcesAndIndex(kb.id)).toBe(1)
      expect(corpusContains(kb.id, 'ORPHAN-TOKEN')).toBe(false)
      expect(getKB(kb.id)!.stats.indexedCount).toBe(1)
      expect(corpusContains(kb.id, 'KEPT')).toBe(true)
    })

    it('keeps text it cannot prove was generated for a removed source', async () => {
      const kb = await kbWithRaw({ 'kept.md': 'KEPT' })
      const textDir = getKBTextDir(kb.id)
      // Header names a source but the file name does not match it.
      put(textDir, 'notes.txt', '<!-- source: ghost.md -->\n\nOWNER-NOTES')
      // Matching name but no header: not provably generated.
      put(textDir, textName('ghost2.md'), 'NO-HEADER')
      // Source still exists, just unrecorded: re-learned, not deleted.
      put(textDir, textName('kept.md') + '.bak', 'BACKUP')
      // From a folder no longer watched.
      const unlinked = path.join(scratch(), 'x.md')
      put(textDir, textName(unlinked), `<!-- source: ${unlinked} -->\n\nUNLINKED`)

      expect(await sweepRemovedSourcesAndIndex(kb.id)).toBe(0)
      for (const token of ['OWNER-NOTES', 'NO-HEADER', 'BACKUP', 'UNLINKED']) {
        expect(corpusContains(kb.id, token)).toBe(true)
      }
    })
  })
})
