/**
 * platform/memory consolidation (file side): the live memory changes only
 * through a validated, conflict-checked swap that keeps a restorable snapshot.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  prepareConsolidation,
  validateConsolidation,
  commitConsolidation,
  moveWithinWorkspace,
  trimHistoryContent,
  carryHistory,
  writeMemoryState,
  readMemoryState,
  trimHistoryFallback,
  assessConsolidation,
  isConsolidationDue,
  recordFailedAttempt,
  readMemoryStatus,
  rebaseWorkspace,
} from '../../../../src/main/platform/memory/consolidation'
import { resolveMemoryLayout, type MemoryLayout } from '../../../../src/main/platform/memory/paths'

const topic = (d: string, body = 'body') => `---\nname: x\ndescription: ${d}\n---\n${body}\n`

function history(n: number): string {
  return Array.from({ length: n }, (_, i) => `## 2026-01-01-${String(1000 + n - i)} | entry ${n - i}  [by: chat#${i}]\n`).join('\n')
}

let space = ''
let layout: MemoryLayout

beforeEach(() => {
  space = mkdtempSync(join(tmpdir(), 'consolidation-'))
  layout = resolveMemoryLayout({ type: 'user', spaceId: 's', spacePath: space }, 'space')
  mkdirSync(join(layout.topicsDir, 'product'), { recursive: true })
  writeFileSync(layout.file, `# now\n## State | busy\n- big block about migration\n\n# History\n${history(3)}`)
  writeFileSync(join(layout.topicsDir, 'product', 'index.md'), topic('when asked about the product'))
  writeFileSync(join(layout.topicsDir, 'product', 'migration.md'), topic('when moving machines', 'x'.repeat(3000)))
})

afterEach(() => rmSync(space, { recursive: true, force: true }))

describe('consolidation workspace', () => {
  it('works on a private copy; the live memory is untouched until commit', async () => {
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, `# now\n## State | tidy\n- migration → topic product/migration.md\n\n# History\n${history(3)}`)
    expect(readFileSync(layout.file, 'utf-8')).toContain('big block about migration')

    expect(await validateConsolidation(ws)).toEqual({ ok: true, notes: [] })
    const result = await commitConsolidation(ws)
    expect(result.status).toBe('committed')
    expect(readFileSync(layout.file, 'utf-8')).toContain('## State | tidy')
    expect(existsSync(ws.dir)).toBe(false)

    // The memory as it stood is archived and snapshotted; the first snapshot is kept for good.
    expect(readdirSync(layout.archiveDir)).toHaveLength(1)
    expect(readFileSync(join(layout.snapshotsDir, 'initial', 'memory.md'), 'utf-8')).toContain('big block about migration')
    expect(existsSync(join(layout.snapshotsDir, 'initial', 'topics', 'product', 'migration.md'))).toBe(true)
  })

  it('rejects a result that lost # now / # History, lists topics in memory.md, or left a page undescribed', async () => {
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, '# now\n## State\n')
    expect((await validateConsolidation(ws)).ok).toBe(false)

    writeFileSync(ws.memoryFile, '# now\n\n# Topics\n- a\n\n# History\n')
    expect((await validateConsolidation(ws)).ok).toBe(false)

    writeFileSync(ws.memoryFile, '# now\n\n# History\n')
    writeFileSync(join(ws.topicsDir, 'new.md'), 'no front matter')
    const v = await validateConsolidation(ws)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain('new.md')
  })

  it('rejects a topic that disappeared unaccounted, and accepts one merged through memory_move', async () => {
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, '# now\n\n# History\n')
    rmSync(join(ws.topicsDir, 'product', 'migration.md'))
    const lost = await validateConsolidation(ws)
    expect(lost.ok).toBe(false)

    const ws2 = await prepareConsolidation(layout)
    writeFileSync(ws2.memoryFile, '# now\n\n# History\n')
    writeFileSync(join(ws2.topicsDir, 'moving.md'), topic('when moving machines', 'x'.repeat(3100)))
    await moveWithinWorkspace(ws2, 'product/migration.md', null, 'moving.md')
    expect((await validateConsolidation(ws2)).ok).toBe(true)
  })

  it('follows moves of whole categories', async () => {
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, '# now\n\n# History\n')
    await moveWithinWorkspace(ws, 'product', 'halo/product')
    expect((await validateConsolidation(ws)).ok).toBe(true)
    await expect(moveWithinWorkspace(ws, '../escape.md', 'x.md')).rejects.toThrow('outside the topics folder')
    await expect(moveWithinWorkspace(ws, 'halo/product/migration.md', null)).rejects.toThrow('merged_into')
  })

  it('rejects a result whose topic content shrank sharply', async () => {
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, '# now\n\n# History\n')
    writeFileSync(join(ws.topicsDir, 'product', 'migration.md'), topic('when moving machines', 'short'))
    const v = await validateConsolidation(ws)
    expect(v.ok).toBe(false)
  })

  it('keeps `initial` for good and rotates the rest', async () => {
    for (let i = 0; i < 5; i++) {
      const ws = await prepareConsolidation(layout)
      await commitConsolidation(ws)
    }
    const names = readdirSync(layout.snapshotsDir)
    expect(names).toContain('initial')
    expect(names.filter(n => n !== 'initial')).toHaveLength(3)
  })
})

describe('consolidation edge cases', () => {
  it('measures topic bytes the same way before and after, so non-markdown files cannot fail it', async () => {
    writeFileSync(join(layout.topicsDir, 'diagram.png'), Buffer.alloc(20_000))
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, `# now\n## State\n\n# History\n${history(3)}`)
    expect(await validateConsolidation(ws)).toEqual({ ok: true, notes: [] })
  })

  it('carries hidden files of the topics folder across a commit', async () => {
    mkdirSync(join(layout.topicsDir, '.obsidian'), { recursive: true })
    writeFileSync(join(layout.topicsDir, '.obsidian', 'app.json'), '{}')
    writeFileSync(join(layout.topicsDir, 'product', '.gitkeep'), '')
    const ws = await prepareConsolidation(layout)
    expect((await commitConsolidation(ws)).status).toBe('committed')
    expect(existsSync(join(layout.topicsDir, '.obsidian', 'app.json'))).toBe(true)
    expect(existsSync(join(layout.topicsDir, 'product', '.gitkeep'))).toBe(true)
  })

})

describe('History trimming', () => {
  it('keeps the newest entries and everything outside # History', () => {
    const content = `# now\n## State\n- a: 1\n\n# History\n${history(15)}`
    const trimmed = trimHistoryContent(content, 10)
    expect(trimmed).toContain('- a: 1')
    expect(trimmed).toContain('entry 15')
    expect(trimmed).toContain('entry 6')
    expect(trimmed).not.toContain('entry 5 ')
  })

  it('treats a History entry and its details as one unit', () => {
    const content = '# now\n\n# History\n## b | two\n### detail\n- x\n\n## a | one\n'
    expect(trimHistoryContent(content, 1)).toBe('# now\n\n# History\n## b | two\n### detail\n- x\n')
  })

  it('falls back to trimming the live file after archiving it', async () => {
    writeFileSync(layout.file, `# now\n## State\n\n# History\n${history(40)}`)
    expect(await trimHistoryFallback(layout, 10)).toBe(true)
    expect(readFileSync(layout.file, 'utf-8').match(/^## /gm)).toHaveLength(11)
    expect(readdirSync(layout.archiveDir)).toHaveLength(1)
  })

})

describe('assessing whether a memory is due', () => {
  it('is due past any of the cadence thresholds', async () => {
    expect((await assessConsolidation(layout, 'diligent')).due).toBe(false)

    writeFileSync(layout.file, `# now\n${'- x: y\n'.repeat(2000)}\n# History\n`)
    const bigNow = await assessConsolidation(layout, 'diligent')
    expect(bigNow.due).toBe(true)
    expect(bigNow.reasons.join()).toContain('# now')
    expect((await assessConsolidation(layout, 'economical')).due).toBe(false)

    writeFileSync(layout.file, `# now\n## State\n\n# History\n${history(31)}`)
    expect((await assessConsolidation(layout, 'diligent')).reasons.join()).toContain('History 31')
  })

  it('reports size, topics and the last attempt for settings', async () => {
    await recordFailedAttempt(layout, 'diligent', 'trimmed', 'model down')
    const status = await readMemoryStatus(layout)
    expect(status.exists).toBe(true)
    expect(status.topicCount).toBe(1)
    expect(status.totalBytes).toBeGreaterThan(3000)
    expect(status.lastAttempt?.outcome).toBe('trimmed')
    expect(status.lastConsolidatedAt).toBeNull()
  })
})

describe('changes made while consolidating', () => {
  const tidy = `# now\n## State | tidy\n\n# History\n${history(3)}`
  const withEntry = (content: string, entry: string) => content.replace('# History\n', `# History\n${entry}\n\n`)

  it('carries History written meanwhile even when # now changed too, and says what is left', async () => {
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, tidy)
    // A run opened and filled its entry, and updated its State, while the agent worked.
    const live = withEntry(readFileSync(layout.file, 'utf-8'), '## 2026-01-02-0900 | run 9  [by: schedule#a1b2]')
      .replace('## State | busy', '## State | busy\n- runs_completed: 9')
    writeFileSync(layout.file, live)

    const conflict = await commitConsolidation(ws)
    expect(conflict.status).toBe('conflict')
    if (conflict.status !== 'conflict') return
    expect(conflict.changes.carriedHistory).toBe(1)
    expect(readFileSync(ws.memoryFile, 'utf-8')).toContain('run 9  [by: schedule#a1b2]')
    expect(conflict.changes.memory?.added).toEqual(['- runs_completed: 9'])
    expect(readFileSync(conflict.changes.memory!.incomingPath, 'utf-8')).toBe(live)

    // The agent merges only what it was asked to.
    writeFileSync(ws.memoryFile, readFileSync(ws.memoryFile, 'utf-8').replace('## State | tidy', '## State | tidy\n- runs_completed: 9'))
    rebaseWorkspace(ws, conflict.liveBaseline)
    expect((await commitConsolidation(ws)).status).toBe('committed')
    const after = readFileSync(layout.file, 'utf-8')
    expect(after).toContain('run 9  [by: schedule#a1b2]')
    expect(after).toContain('- runs_completed: 9')
    expect(after).toContain('## State | tidy')
  })

  it('carries History by itself and commits at once when nothing else changed', async () => {
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, tidy)
    writeFileSync(layout.file, withEntry(readFileSync(layout.file, 'utf-8'), '## 2026-01-02-0900 | new run  [by: schedule#a1b2]'))
    const result = await commitConsolidation(ws)
    expect(result.status).toBe('committed')
    if (result.status === 'committed') expect(result.carriedHistory).toBe(1)
    expect(readFileSync(layout.file, 'utf-8')).toContain('new run')
  })

  it('merges topic changes the agent did not touch — added, changed or large — in full', async () => {
    for (let i = 0; i < 12; i++) writeFileSync(join(layout.topicsDir, `t${i}.md`), topic(`when ${i}`, 'v1'))
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, tidy)

    for (let i = 0; i < 12; i++) writeFileSync(join(layout.topicsDir, `t${i}.md`), topic(`when ${i}`, `v2 ${'y'.repeat(100)}`))
    const big = topic('when big', 'z'.repeat(12_000) + 'THE-END')
    writeFileSync(join(layout.topicsDir, 'big.md'), big)

    const result = await commitConsolidation(ws)
    expect(result.status).toBe('committed')
    if (result.status === 'committed') expect(result.mergedTopics).toBe(13)
    for (let i = 0; i < 12; i++) expect(readFileSync(join(layout.topicsDir, `t${i}.md`), 'utf-8')).toContain('v2')
    expect(readFileSync(join(layout.topicsDir, 'big.md'), 'utf-8')).toBe(big)
  })

  it('hands a topic both sides changed to the agent in full, never truncated', async () => {
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, tidy)
    writeFileSync(join(ws.topicsDir, 'product', 'migration.md'), topic('when moving machines', 'agent version ' + 'x'.repeat(3000)))
    const live = topic('when moving machines', 'live version ' + 'q'.repeat(20_000) + 'TAIL')
    writeFileSync(join(layout.topicsDir, 'product', 'migration.md'), live)

    const conflict = await commitConsolidation(ws)
    expect(conflict.status).toBe('conflict')
    if (conflict.status !== 'conflict') return
    expect(conflict.changes.topics).toEqual([
      expect.objectContaining({ path: 'product/migration.md', live: 'changed' }),
    ])
    expect(readFileSync(conflict.changes.topics[0].incomingPath!, 'utf-8')).toBe(live)
    // The live memory is untouched until the agent merges.
    expect(readFileSync(join(layout.topicsDir, 'product', 'migration.md'), 'utf-8')).toBe(live)
  })

  it('a topic removed meanwhile that the agent left alone stays removed', async () => {
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, tidy)
    rmSync(join(layout.topicsDir, 'product', 'migration.md'))
    const result = await commitConsolidation(ws)
    expect(result.status).toBe('committed')
    expect(existsSync(join(layout.topicsDir, 'product', 'migration.md'))).toBe(false)
  })

  it('carryHistory ignores changes outside History', () => {
    const original = '# now\nA\n\n# History\n## t1 | one  [by: x]\n'
    const current = '# now\nC\n\n# History\n## t2 | two  [by: y]\n\n## t1 | one  [by: x]\n'
    const consolidated = '# now\nB\n\n# History\n## t1 | one  [by: x]\n'
    expect(carryHistory(original, current, consolidated)).toEqual({
      content: '# now\nB\n\n# History\n## t2 | two  [by: y]\n\n## t1 | one  [by: x]\n',
      carried: 1,
    })
  })
  it('a new entry sharing a minute (and no author) with others removes none of them', () => {
    const base = '# now\n\n# History\n\n## 2026-01-01-1000 | A decided X\n- a\n\n## 2026-01-01-1000 | B decided Y\n- b\n'
    const live = base.replace('# History\n\n', '# History\n\n## 2026-01-01-1000 | C new entry same minute\n- c\n\n')
    const result = carryHistory(base, live, base)!
    expect(result.carried).toBe(1)
    for (const summary of ['A decided X', 'B decided Y', 'C new entry same minute']) expect(result.content).toContain(summary)

    const tagged = '# now\n\n# History\n\n## 2026-01-01-1000 | first  [by: schedule#a1]\n'
    const taggedLive = tagged.replace('# History\n\n', '# History\n\n## 2026-01-01-1000 | second  [by: schedule#a1]\n\n')
    const r2 = carryHistory(tagged, taggedLive, tagged)!
    expect(r2.content).toContain('first')
    expect(r2.content).toContain('second')
  })

  it('an entry rewritten live replaces its old text where it stands', () => {
    const entries = (middle: string) =>
      `# now\n\n# History\n\n## 2026-01-03-1000 | newest  [by: a]\n\n${middle}\n\n## 2026-01-01-1000 | oldest  [by: c]\n`
    const original = entries('## 2026-01-02-1000 | middle  [by: b]')
    const live = entries('## 2026-01-02-1000 | middle, with its outcome  [by: b]')
    const consolidated = original.replace('# now\n', '# now\n## State | tidy\n')
    const result = carryHistory(original, live, consolidated)!
    expect(result.carried).toBe(1)
    const headings = result.content.split('\n').filter(l => l.startsWith('## 2026'))
    expect(headings).toEqual([
      '## 2026-01-03-1000 | newest  [by: a]',
      '## 2026-01-02-1000 | middle, with its outcome  [by: b]',
      '## 2026-01-01-1000 | oldest  [by: c]',
    ])
    expect(result.content).toContain('## State | tidy')
  })

  it('a topic the agent merged away and the live memory removed is no conflict', async () => {
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, tidy)
    await moveWithinWorkspace(ws, 'product/migration.md', null, 'product/index.md')
    rmSync(join(layout.topicsDir, 'product', 'migration.md'))
    const result = await commitConsolidation(ws)
    expect(result.status).toBe('committed')
    expect(existsSync(join(layout.topicsDir, 'product', 'migration.md'))).toBe(false)
  })
})

describe('a swap that fails half way', () => {
  it('restores the old topics when the new ones cannot be put in place', async () => {
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, '# now\n## State | new\n\n# History\n')
    const before = readFileSync(layout.file, 'utf-8')
    rmSync(ws.topicsDir, { recursive: true, force: true })
    await expect(commitConsolidation(ws)).rejects.toThrow()
    expect(readFileSync(layout.file, 'utf-8')).toBe(before)
    expect(existsSync(join(layout.topicsDir, 'product', 'migration.md'))).toBe(true)
  })

  it('puts both back when memory.md cannot be archived', async () => {
    const ws = await prepareConsolidation(layout)
    writeFileSync(ws.memoryFile, '# now\n## State | new\n\n# History\n')
    writeFileSync(join(ws.topicsDir, 'product', 'migration.md'), topic('when moving machines', 'agent'.repeat(700)))
    const before = readFileSync(layout.file, 'utf-8')
    writeFileSync(layout.archiveDir, 'not a folder')
    await expect(commitConsolidation(ws)).rejects.toThrow()
    expect(readFileSync(layout.file, 'utf-8')).toBe(before)
    expect(readFileSync(join(layout.topicsDir, 'product', 'migration.md'), 'utf-8')).toContain('x'.repeat(100))
  })

  it('a crash between the two renames is repaired by the next prepare', async () => {
    const ws = await prepareConsolidation(layout)
    renameSync(layout.topicsDir, join(ws.dir, 'topics.retired'))
    expect(existsSync(layout.topicsDir)).toBe(false)
    await prepareConsolidation(layout)
    expect(existsSync(join(layout.topicsDir, 'product', 'migration.md'))).toBe(true)
  })
})

describe('when automatic consolidation runs', () => {
  it('cools down after a failed attempt until the memory has grown, longer each time', async () => {
    writeFileSync(layout.file, `# now\n## State\n\n# History\n${history(40)}`)
    const first = await recordFailedAttempt(layout, 'diligent', 'failed', 'test')
    const size = Buffer.byteLength(readFileSync(layout.file, 'utf-8'))
    expect(first.cooldownUntilBytes).toBe(Math.ceil(size * 1.2))
    const second = await recordFailedAttempt(layout, 'diligent', 'failed', 'test')
    expect(second.cooldownUntilBytes).toBe(Math.ceil(size * 1.4))

    const later = Date.now() + 2 * 60 * 60_000
    expect((await isConsolidationDue(layout, 'diligent', { now: later })).coolingDown).toBe(true)
    writeFileSync(layout.file, `# now\n## State\n\n# History\n${history(80)}`)
    expect((await isConsolidationDue(layout, 'diligent', { now: later })).due).toBe(true)
  })

  it('waits the cadence\'s minimum interval after an attempt', async () => {
    writeFileSync(layout.file, `# now\n## State\n\n# History\n${history(40)}`)
    await writeMemoryState(layout, { lastAttempt: { at: new Date().toISOString(), outcome: 'committed' } })
    expect((await isConsolidationDue(layout, 'diligent')).tooSoon).toBe(true)
    expect((await isConsolidationDue(layout, 'diligent', { now: Date.now() + 61 * 60_000 })).due).toBe(true)
    expect((await isConsolidationDue(layout, 'economical', { now: Date.now() + 61 * 60_000 })).tooSoon).toBe(true)
  })

  it('holds # now to the owner\'s injection limit', async () => {
    writeFileSync(layout.file, `# now\n${'- x: y\n'.repeat(1400)}\n# History\n`)
    expect((await assessConsolidation(layout, 'economical')).overNow).toBe(false)
    expect((await assessConsolidation(layout, 'economical', { nowCapBytes: 8 * 1024 })).overNow).toBe(true)
  })

  it('a state file that is not an object reads as empty', async () => {
    mkdirSync(layout.dataDir, { recursive: true })
    writeFileSync(layout.stateFile, 'null')
    expect(await readMemoryState(layout)).toEqual({})
    await expect(isConsolidationDue(layout, 'diligent')).resolves.toBeDefined()
  })
})
