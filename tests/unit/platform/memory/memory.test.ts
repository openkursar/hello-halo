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
  isBlankMemory,
  memoryHasContent
} from '../../../../src/main/platform/memory/file-ops'
import { resolveMemoryLayout } from '../../../../src/main/platform/memory/paths'
import { buildMemorySnapshot } from '../../../../src/main/platform/memory/snapshot'
import { renderMemorySection } from '../../../../src/main/platform/memory/section'
import { generatePromptInstructions, TOPIC_GUIDE } from '../../../../src/main/platform/memory/prompt'
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
      expect(fs.readFileSync(spaceLayout().file, 'utf-8')).toBe('# now\n\n# History\n')
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
      expect(fs.readFileSync(layout.file, 'utf-8')).toBe('# now\n\n# History\n')
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

    it('counts content in memory.md or a topic, not the skeleton', async () => {
      const layout = spaceLayout()
      expect(memoryHasContent(layout)).toBe(false)
      await ensureMemoryFile(layout, 'space')
      expect(memoryHasContent(layout)).toBe(false)
      fs.mkdirSync(layout.topicsDir, { recursive: true })
      fs.writeFileSync(path.join(layout.topicsDir, '.gitkeep'), '')
      expect(memoryHasContent(layout)).toBe(false)
      fs.writeFileSync(path.join(layout.topicsDir, 'build.md'), '---\nname: Build\n---\n')
      expect(memoryHasContent(layout)).toBe(true)
      fs.rmSync(layout.topicsDir, { recursive: true })
      fs.writeFileSync(layout.file, '# now\n- build: pnpm\n\n# History\n')
      expect(memoryHasContent(layout)).toBe(true)
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
  // Memory is edited with native file tools on memory.md — no MCP tools. Same
  // instructions wherever the digital human works; only the two mechanical
  // facts (how `# now` arrived, whether a History heading was written for it)
  // vary, and neither tells it WHAT is worth recording.
  const MODES = ['run', 'session'] as const

  it.each(MODES)('should describe the memory.md structure (%s)', (mode) => {
    const instructions = generatePromptInstructions(mode)
    expect(instructions).toContain('## Memory')
    expect(instructions).toContain('# now')
    expect(instructions).toContain('# History')
    expect(instructions).toContain('memory.md')
  })

  it.each(MODES)('should instruct updating memory before reporting (%s)', (mode) => {
    const instructions = generatePromptInstructions(mode)
    expect(instructions).toContain('When to Update')
    expect(instructions).toContain('before reporting')
  })

  it.each(MODES)('should leave no unresolved placeholder (%s)', (mode) => {
    expect(generatePromptInstructions(mode)).not.toContain('{{')
  })

  it('should promise a pre-inserted History heading only for automation runs', () => {
    // The claim is true only where execute.ts actually writes the heading;
    // promising it elsewhere sends the agent editing a heading that is not there.
    expect(generatePromptInstructions('run')).toContain('pre-inserts a `## YYYY-MM-DD-HHmm` heading')
    expect(generatePromptInstructions('session')).not.toContain('pre-inserts')
    expect(generatePromptInstructions('session')).toContain('add your own')
  })

  it('should tell both modes their memory is already loaded', () => {
    expect(generatePromptInstructions('run')).toContain('pre-loaded in the trigger message')
    expect(generatePromptInstructions('session')).toContain('already in context')
  })

  it('should not dictate what is worth recording', () => {
    // Habits are the digital human's own; the instructions only state mechanics.
    for (const mode of MODES) {
      expect(generatePromptInstructions(mode)).not.toContain('One entry per meaningful outcome')
    }
  })
})

describe('generatePromptInstructions — owners, topics, tracked items', () => {
  it('teaches the topic wiki and that its index is generated', () => {
    const text = generatePromptInstructions('run')
    expect(text).toContain('### Topics')
    expect(text).toContain('The index is generated')
    expect(text).toContain('description: <WHEN to read it')
  })

  it('renders memory_schema as what this memory tracks, and nothing when absent', () => {
    const text = generatePromptInstructions('run', {
      tracks: [{ name: 'faq_cache', type: 'object', description: 'cached answers' }],
    })
    expect(text).toContain('### What this memory tracks')
    expect(text).toContain('- `faq_cache` (object): cached answers')
    // A declared list adds focus; it does not narrow what else is remembered.
    expect(text).toContain('on top of everything else worth remembering')
    expect(generatePromptInstructions('run')).not.toContain('What this memory tracks')
  })

  it('gives a space the compact manual — under 2KB — and only how to start when it is empty', () => {
    const full = generatePromptInstructions('session', { owner: 'space' })
    expect(Buffer.byteLength(full)).toBeLessThanOrEqual(2048)
    expect(full).toContain('shared by all its conversations')
    expect(full).toContain('Most conversations')
    expect(full).toContain('description:')
    expect(full).not.toContain('One memory, many instances')
    expect(full).not.toContain('{{')

    const empty = generatePromptInstructions('session', { owner: 'space', empty: true })
    expect(Buffer.byteLength(empty)).toBeLessThan(Buffer.byteLength(full))
    expect(empty).toContain('nothing is recorded yet')
    expect(empty).toContain('Edit it in')
    expect(empty).not.toMatch(/create `memory\.md`/i)
  })

  it('gives team guidance only to a digital human in a team, and by default', () => {
    for (const mode of ['run', 'session'] as const) {
      const solo = generatePromptInstructions(mode, { inTeam: false })
      const team = generatePromptInstructions(mode, { inTeam: true })
      expect(generatePromptInstructions(mode)).toBe(team)
      expect(team).toContain('Never copy team state into memory')
      expect(team).toContain('a turn inside a team')
      expect(team).toContain('use the team tools')
      expect(team).toContain('team-board state')
      expect(solo).not.toMatch(/team/i)
      expect(solo).toContain('an IM conversation. You cannot')
      expect(solo).toContain('do not wait on one.\n')
      expect(solo).toContain('progress on the current task, credentials')
      for (const text of [solo, team]) expect(text).not.toContain('{{')
    }
  })

  it('says what a digital human is shown of # now, and what sets consolidation off', () => {
    const text = generatePromptInstructions('run')
    expect(text).not.toContain('loaded in full every time')
    expect(text).toContain('only its')
    expect(text).toContain('History getting long')
  })

  it('tells a digital human its memory.md always exists, so it is edited, never written whole', () => {
    const text = generatePromptInstructions('session')
    expect(text).toContain('`memory.md` always exists')
    expect(text).not.toContain('first-time creation')
  })

  it('keeps topic examples out of the standing instructions and points at memory_status for them', () => {
    const text = generatePromptInstructions('run')
    expect(text).not.toContain('customer base responds well to')
    expect(text).toContain('call `memory_status`')
    expect(TOPIC_GUIDE).toContain('customer base responds well to')
  })

  it('tells a digital human, in one sentence, to keep sensitive memory from guests', () => {
    const text = generatePromptInstructions('session')
    expect(text).toContain('do not reveal sensitive')
    expect(text).not.toMatch(/unverified/i)
  })
})
