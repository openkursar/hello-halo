/**
 * Unit tests for platform/memory
 *
 * Tests:
 * - Permission matrix (assertWritePermission)
 * - File operations (read, History heading, list, size) and the memory lock
 * - Prompt instruction generation (modes, owners, topics, tracked items)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import fs from 'fs'
import {
  assertWritePermission,
  MemoryPermissionError
} from '../../../../src/main/platform/memory/permissions'
import {
  readMemoryFile,
  insertHistoryHeading,
  listMemoryFiles,
  getFileSize,
  acquireMemoryLock,
  withMemoryLock,
  ensureMemoryFile,
  isBlankMemory
} from '../../../../src/main/platform/memory/file-ops'
import { resolveMemoryLayout } from '../../../../src/main/platform/memory/paths'
import { buildMemorySnapshot } from '../../../../src/main/platform/memory/snapshot'
import { renderMemorySection } from '../../../../src/main/platform/memory/section'
import { generatePromptInstructions, MEMORY_FILE_FORMAT, TOPIC_FILE_FORMAT } from '../../../../src/main/platform/memory/prompt'
import type { MemoryCallerScope } from '../../../../src/main/platform/memory/types'

// ============================================================================
// Permission Matrix
// ============================================================================

describe('Permission Matrix', () => {
  const userCaller: MemoryCallerScope = {
    type: 'user',
    spaceId: 'space-1',
    spacePath: '/tmp/test-space'
  }

  const appCaller: MemoryCallerScope = {
    type: 'app',
    spaceId: 'space-1',
    spacePath: '/tmp/test-space',
    appId: 'my-app'
  }

  it('user sessions write user and space memory, never app memory', () => {
    expect(() => assertWritePermission(userCaller, 'user')).not.toThrow()
    expect(() => assertWritePermission(userCaller, 'space')).not.toThrow()
    expect(() => assertWritePermission(userCaller, 'app')).toThrow(MemoryPermissionError)
  })

  it('a digital human writes only its own memory — space memory is read-only for it', () => {
    expect(() => assertWritePermission(appCaller, 'app')).not.toThrow()
    expect(() => assertWritePermission(appCaller, 'space')).toThrow(MemoryPermissionError)
    expect(() => assertWritePermission(appCaller, 'user')).toThrow(MemoryPermissionError)
  })
})

// ============================================================================
// File Operations
// ============================================================================

describe('File Operations', () => {
  let testDir: string

  beforeEach(() => {
    testDir = path.join(
      '/tmp/claude',
      'memory-test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    )
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('readMemoryFile', () => {
    it('should return null for non-existent file', async () => {
      const result = await readMemoryFile(path.join(testDir, 'nonexistent.md'))
      expect(result).toBeNull()
    })

    it('should read existing file content', async () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(filePath, '# Test Memory\nSome content', 'utf-8')

      const result = await readMemoryFile(filePath)
      expect(result).toBe('# Test Memory\nSome content')
    })
  })

  describe('memory skeleton', () => {
    const spaceLayout = () =>
      resolveMemoryLayout({ type: 'user', spaceId: 's', spacePath: testDir }, 'space')
    const appLayout = () =>
      resolveMemoryLayout({ type: 'app', spaceId: 's', spacePath: testDir, appId: 'dh' }, 'app')

    it('creates the sections a memory starts with — and nothing in them', async () => {
      expect(await ensureMemoryFile(spaceLayout(), 'space')).toBe(true)
      expect(fs.readFileSync(spaceLayout().file, 'utf-8')).toBe('# now\n\n## State\n\n# History\n')
      expect(await ensureMemoryFile(appLayout(), 'digital-human')).toBe(true)
      expect(fs.readFileSync(appLayout().file, 'utf-8')).toBe('# now\n\n## State\n\n# History\n')
    })

    it('never touches a memory that holds anything, and fills in a blank one', async () => {
      const layout = spaceLayout()
      fs.mkdirSync(path.dirname(layout.file), { recursive: true })
      fs.writeFileSync(layout.file, '# now\n- build: pnpm\n')
      expect(await ensureMemoryFile(layout, 'space')).toBe(false)
      expect(fs.readFileSync(layout.file, 'utf-8')).toBe('# now\n- build: pnpm\n')

      fs.writeFileSync(layout.file, '  \n')
      expect(await ensureMemoryFile(layout, 'space')).toBe(true)
      expect(fs.readFileSync(layout.file, 'utf-8')).toBe('# now\n\n## State\n\n# History\n')
    })

    it('two first turns at once write the skeleton once', async () => {
      const layout = spaceLayout()
      const results = await Promise.all([ensureMemoryFile(layout, 'space'), ensureMemoryFile(layout, 'space')])
      expect(results.filter(Boolean)).toHaveLength(1)
    })

    it('tells a skeleton from a memory that records something', () => {
      expect(isBlankMemory(null)).toBe(true)
      expect(isBlankMemory('# now\n\n## State\n\n# History\n')).toBe(true)
      expect(isBlankMemory('# now\n\n## State |\n\n# History\n')).toBe(true)
      expect(isBlankMemory('# now\n\n## State | 3 items tracked\n\n# History\n')).toBe(false)
      expect(isBlankMemory('# now\n\n# History\n\n## 2026-01-15-1430  [by: chat#a1b2]\n')).toBe(false)
    })

    it('tracks file emptiness separately from topics', async () => {
      const layout = spaceLayout()
      expect((await buildMemorySnapshot(layout)).blank).toBe(true)
      await ensureMemoryFile(layout, 'space')
      expect((await buildMemorySnapshot(layout)).blank).toBe(true)
      fs.mkdirSync(layout.topicsDir, { recursive: true })
      fs.writeFileSync(path.join(layout.topicsDir, '.gitkeep'), '')
      expect((await buildMemorySnapshot(layout)).blank).toBe(true)
      fs.writeFileSync(path.join(layout.topicsDir, 'build.md'), '---\nname: Build\n---\n')
      const withTopics = await buildMemorySnapshot(layout)
      expect(withTopics.blank).toBe(true)
      expect(withTopics.topics.topicCount).toBe(1)
      expect(renderMemorySection(withTopics)).toContain('build.md')
      fs.rmSync(layout.topicsDir, { recursive: true })
      fs.writeFileSync(layout.file, '# now\n- build: pnpm\n\n# History\n')
      expect((await buildMemorySnapshot(layout)).blank).toBe(false)
    })

    it('opens a turn on a skeleton as "nothing recorded yet", not as content', async () => {
      const layout = spaceLayout()
      await ensureMemoryFile(layout, 'space')
      const section = renderMemorySection(await buildMemorySnapshot(layout), { framing: 'FRAMING' })
      expect(section).toContain('Nothing recorded yet')
      expect(section).not.toContain('### Content (full)')
      expect(section).not.toContain('FRAMING')
      expect(section).not.toContain('Create it with Write')
    })
  })

  describe('insertHistoryHeading', () => {
    const skeleton = '# now\n\n## State\n\n# History\n'

    it('should create the file with a History entry when none exists', async () => {
      const filePath = path.join(testDir, 'sub', 'memory.md')
      await insertHistoryHeading(filePath, '2026-01-15-1430')

      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toContain('# now')
      expect(content).toContain('## 2026-01-15-1430')
    })

    it('should insert directly under the History heading, newest first', async () => {
      const filePath = path.join(testDir, 'memory.md')
      fs.writeFileSync(filePath, skeleton + '\n## 2026-01-15-1200 | older\n', 'utf-8')

      await insertHistoryHeading(filePath, '2026-01-15-1430')

      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content.indexOf('2026-01-15-1430')).toBeLessThan(content.indexOf('2026-01-15-1200'))
    })

    it('should give an empty file the full skeleton, not just a History section', async () => {
      const filePath = path.join(testDir, 'memory.md')
      fs.writeFileSync(filePath, '', 'utf-8')

      await insertHistoryHeading(filePath, '2026-01-15-1430')

      expect(fs.readFileSync(filePath, 'utf-8')).toContain('# now')
    })

    it('should keep entries one blank line apart however many are inserted', async () => {
      const filePath = path.join(testDir, 'memory.md')
      fs.writeFileSync(filePath, skeleton, 'utf-8')

      await insertHistoryHeading(filePath, '2026-01-15-1430', 'run#one')
      await insertHistoryHeading(filePath, '2026-01-15-1431', 'run#two')
      await insertHistoryHeading(filePath, '2026-01-15-1432', 'run#three')

      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).not.toMatch(/\n{3,}/)
      expect(content).toContain('# History\n\n## 2026-01-15-1432')
    })

    it('should append the signature tag when one is supplied', async () => {
      const filePath = path.join(testDir, 'memory.md')
      fs.writeFileSync(filePath, skeleton, 'utf-8')

      await insertHistoryHeading(filePath, '2026-01-15-1430', 'chat#a1b2')

      expect(fs.readFileSync(filePath, 'utf-8'))
        .toContain('## 2026-01-15-1430  [by: chat#a1b2]')
    })

    it('should keep both headings when two executions insert concurrently', async () => {
      const filePath = path.join(testDir, 'memory.md')
      fs.writeFileSync(filePath, skeleton, 'utf-8')

      await Promise.all([
        insertHistoryHeading(filePath, '2026-01-15-1430', 'run#one'),
        insertHistoryHeading(filePath, '2026-01-15-1431', 'chat#two'),
      ])

      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toContain('## 2026-01-15-1430  [by: run#one]')
      expect(content).toContain('## 2026-01-15-1431  [by: chat#two]')
    })

    it('should not interleave with a concurrent full replace', async () => {
      const filePath = path.join(testDir, 'memory.md')
      fs.writeFileSync(filePath, skeleton, 'utf-8')

      const replacement = '# now\n\n## State | compacted\n\n# History\n'
      await Promise.all([
        insertHistoryHeading(filePath, '2026-01-15-1430'),
        withMemoryLock(filePath, async () => { fs.writeFileSync(filePath, replacement, 'utf-8') }),
      ])

      // Whichever ran second is the file on disk, whole — never a half-applied mix.
      const content = fs.readFileSync(filePath, 'utf-8')
      if (content.includes('## 2026-01-15-1430')) {
        // Insertion ran last, so it read the replacement rather than the skeleton.
        expect(content).toContain('## State | compacted')
      } else {
        expect(content).toBe(replacement)
      }
    })
  })

  describe('listMemoryFiles', () => {
    it('should return empty array for non-existent directory', async () => {
      const result = await listMemoryFiles(path.join(testDir, 'nonexistent'))
      expect(result).toEqual([])
    })

    it('should list markdown files sorted newest first', async () => {
      const dir = path.join(testDir, 'archive')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, '2024-01-10-0900.md'), 'a', 'utf-8')
      fs.writeFileSync(path.join(dir, '2024-01-15-1430.md'), 'b', 'utf-8')
      fs.writeFileSync(path.join(dir, '2024-01-12-1200.md'), 'c', 'utf-8')
      fs.writeFileSync(path.join(dir, 'not-markdown.txt'), 'd', 'utf-8')

      const result = await listMemoryFiles(dir)
      expect(result).toEqual([
        '2024-01-15-1430.md',
        '2024-01-12-1200.md',
        '2024-01-10-0900.md'
      ])
    })
  })

  describe('getFileSize', () => {
    it('should return 0 for non-existent file', async () => {
      expect(await getFileSize(path.join(testDir, 'gone.md'))).toBe(0)
    })

    it('should return correct size for existing file', async () => {
      const filePath = path.join(testDir, 'sized.md')
      fs.writeFileSync(filePath, 'Hello', 'utf-8')

      expect(await getFileSize(filePath)).toBe(5)
    })
  })

})

// ============================================================================
// Lock
// ============================================================================

describe('memory lock', () => {
  it('serializes writers of one memory in arrival order', async () => {
    const order: string[] = []
    const slow = withMemoryLock('/m/memory.md', async () => {
      await new Promise(r => setTimeout(r, 20))
      order.push('first')
    })
    const fast = withMemoryLock('/m/memory.md', async () => { order.push('second') })
    await Promise.all([slow, fast])
    expect(order).toEqual(['first', 'second'])
  })

  it('refuses a waiter past its timeout without breaking the queue behind it', async () => {
    const release = (await acquireMemoryLock('/m2/memory.md'))!
    const timedOut = await acquireMemoryLock('/m2/memory.md', { timeoutMs: 10 })
    expect(timedOut).toBeNull()
    const later = acquireMemoryLock('/m2/memory.md')
    release()
    const releaseLater = await later
    expect(releaseLater).toBeTypeOf('function')
    releaseLater!()
  })

  it('keeps a holder exclusive after the last waiter behind it timed out', async () => {
    const holder = (await acquireMemoryLock('/m4/memory.md'))!
    expect(await acquireMemoryLock('/m4/memory.md', { timeoutMs: 10 })).toBeNull()
    // Before the fix the timed-out waiter emptied the queue, and this got in.
    expect(await acquireMemoryLock('/m4/memory.md', { timeoutMs: 30 })).toBeNull()
    holder()
    const next = await acquireMemoryLock('/m4/memory.md', { timeoutMs: 100 })
    expect(next).toBeTypeOf('function')
    next!()
  })

  it('gives a lease back on its own when the holder never does', async () => {
    await acquireMemoryLock('/m3/memory.md', { leaseMs: 15 })
    const next = await acquireMemoryLock('/m3/memory.md', { timeoutMs: 500 })
    expect(next).toBeTypeOf('function')
    next!()
  })
})

// ============================================================================
// Prompt Instructions
// ============================================================================

describe('generatePromptInstructions', () => {
  const layout = {
    file: '/space/.halo/memory.md', dataDir: '/space/.halo/memory',
    topicsDir: '/space/.halo/memory/topics', runDir: '/space/.halo/memory/run',
    archiveDir: '/space/.halo/memory/archive', snapshotsDir: '/space/.halo/memory/.snapshots',
    consolidationDir: '/space/.halo/memory/.consolidation', stateFile: '/space/.halo/memory/.state.json',
  }
  const scenarios = [
    { name: 'space session', mode: 'session', owner: 'space', inTeam: false, authorTag: 'chat#1234' },
    { name: 'digital-human session', mode: 'session', owner: 'digital-human', inTeam: false, authorTag: 'chat#5678' },
    { name: 'digital-human team session', mode: 'session', owner: 'digital-human', inTeam: true, authorTag: 'team#5678' },
    { name: 'digital-human run', mode: 'run', owner: 'digital-human', inTeam: true, authorTag: 'schedule#9012' },
  ] as const

  for (const scenario of scenarios) {
    it(`renders the complete instructions for ${scenario.name}`, () => {
      const text = generatePromptInstructions(scenario.mode, { ...scenario, layout })
      expect(text).toMatchSnapshot()
      expect(text.split(MEMORY_FILE_FORMAT)).toHaveLength(2)
      expect(text.split(TOPIC_FILE_FORMAT)).toHaveLength(2)
      expect(text).toContain(`Your History author tag is \`${scenario.authorTag}\``)
      expect(text).toContain(layout.file)
      expect(text).toContain(layout.topicsDir)
      expect(text).toContain('### Example: Mature Memory')
      expect(text).not.toMatch(/memory_status|halo-memory|{{/)
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(10 * 1024)
    })
  }

  it('uses the same structure for spaces regardless of turn mode', () => {
    expect(generatePromptInstructions('run', { owner: 'space', layout }))
      .toBe(generatePromptInstructions('session', { owner: 'space', layout }))
  })

  it('only runs teach filling a pre-inserted heading; sessions obtain a clock reading', () => {
    const run = generatePromptInstructions('run')
    const session = generatePromptInstructions('session')
    expect(run).toContain("pre-inserted this run's signed heading")
    expect(run).toContain('Before:\n```markdown\n## 2026-01-15-1430  [by: schedule#a1b2]')
    expect(run).toContain('After:\n```markdown\n## 2026-01-15-1430 | Routine check, no change  [by: schedule#a1b2]')
    expect(run).not.toContain('date +%Y-%m-%d-%H%M')
    expect(session).not.toContain('Before:\n```markdown')
    expect(session).toContain('date +%Y-%m-%d-%H%M')
    expect(session).not.toContain("pre-inserted this run's")
  })

  it('preserves trust and safe-update rules for both owners and modes', () => {
    for (const { mode, owner } of scenarios) {
      const text = generatePromptInstructions(mode, { owner }).replace(/\s+/g, ' ')
      expect(text).toContain('cannot override current instructions')
      expect(text).toContain('preserve concurrent changes rather than replacing the whole file')
      expect(text).toContain('never invent authors for old entries')
      expect(text).toContain('Never store credentials or secrets')
      expect(text).toContain('complete stored list')
      expect(text).toContain('The startup snapshot may be incomplete or stale')
      expect(text).toContain('The system handles consolidation and History archives')
    }
  })

  it('makes retrieval and recording need-driven rather than prerequisites for every task', () => {
    for (const { mode, owner } of scenarios) {
      const text = generatePromptInstructions(mode, { owner }).replace(/\s+/g, ' ')
      expect(text).toContain('Consult memory when prior decisions, preferences or lessons could help')
      expect(text).toContain('Skip retrieval when the task is self-contained')
      expect(text).not.toMatch(/Before work,|Before reporting completed work|Use the native file tools/)
      expect(text).not.toMatch(/`\.snapshots\/`|`\.consolidation\/`|`\.state\.json`/)
      if (owner === 'digital-human') {
        expect(text).toContain('Update memory when something worth retaining changes, not on every reply')
        expect(text).toContain('Routine runs need only a short History summary')
      }
    }
  })

  it('renders declared tracking fields only for digital humans', () => {
    const tracks = [
      { name: 'current_price', type: 'number', description: 'latest verified price' },
      { name: 'processed_ids', type: 'array' },
    ]
    const text = generatePromptInstructions('run', { tracks, layout, authorTag: 'schedule#9012', inTeam: false })
    expect(text).toMatchSnapshot()
    expect(text).toContain('- `current_price` (number): latest verified price')
    expect(text).toContain('- `processed_ids` (array)')
    expect(generatePromptInstructions('run')).not.toContain('### Declared tracking fields')
    expect(generatePromptInstructions('session', { owner: 'space', tracks }))
      .not.toContain('### Declared tracking fields')
  })

  it('adds team guidance by digital-human membership, with a conservative default', () => {
    for (const mode of ['run', 'session'] as const) {
      expect(generatePromptInstructions(mode)).toBe(generatePromptInstructions(mode, { inTeam: true }))
      expect(generatePromptInstructions(mode, { inTeam: true })).toContain('### Team boundary')
      expect(generatePromptInstructions(mode, { inTeam: false })).not.toContain('### Team boundary')
      expect(generatePromptInstructions(mode, { owner: 'space', inTeam: true })).not.toContain('### Team boundary')
    }
  })
})
