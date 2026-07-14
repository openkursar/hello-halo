/**
 * Unit tests for platform/memory
 *
 * Tests:
 * - Path resolution (getMemoryFilePath, getMemoryArchiveDir)
 * - Permission matrix (assertReadPermission, assertWritePermission)
 * - File operations (read, write, append, archive)
 * - Prompt instruction generation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import fs from 'fs'
import {
  assertReadPermission,
  assertWritePermission,
  getReadableScopes,
  getWritableScopes,
  MemoryPermissionError
} from '../../../../src/main/platform/memory/permissions'
import {
  readMemoryFile,
  readMemoryHeadings,
  readMemorySection,
  readMemoryTail,
  appendToMemoryFile,
  replaceMemoryFile,
  listMemoryFiles,
  archiveMemoryFile,
  getFileSize
} from '../../../../src/main/platform/memory/file-ops'
import { generatePromptInstructions } from '../../../../src/main/platform/memory/prompt'
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

  describe('assertReadPermission', () => {
    it('user can read user and space scopes', () => {
      expect(() => assertReadPermission(userCaller, 'user')).not.toThrow()
      expect(() => assertReadPermission(userCaller, 'space')).not.toThrow()
    })

    it('user cannot read app scope', () => {
      expect(() => assertReadPermission(userCaller, 'app')).toThrow(MemoryPermissionError)
    })

    it('app can read user, space, and own app scope', () => {
      expect(() => assertReadPermission(appCaller, 'user')).not.toThrow()
      expect(() => assertReadPermission(appCaller, 'space')).not.toThrow()
      expect(() => assertReadPermission(appCaller, 'app')).not.toThrow()
    })
  })

  describe('assertWritePermission', () => {
    it('user can write (any mode) to user and space', () => {
      expect(() => assertWritePermission(userCaller, 'user', 'append')).not.toThrow()
      expect(() => assertWritePermission(userCaller, 'user', 'replace')).not.toThrow()
      expect(() => assertWritePermission(userCaller, 'space', 'append')).not.toThrow()
      expect(() => assertWritePermission(userCaller, 'space', 'replace')).not.toThrow()
    })

    it('user cannot write to app scope', () => {
      expect(() => assertWritePermission(userCaller, 'app', 'append')).toThrow(MemoryPermissionError)
    })

    it('app cannot write to user scope', () => {
      expect(() => assertWritePermission(appCaller, 'user', 'append')).toThrow(MemoryPermissionError)
    })

    it('app can only append to space scope', () => {
      expect(() => assertWritePermission(appCaller, 'space', 'append')).not.toThrow()
      expect(() => assertWritePermission(appCaller, 'space', 'replace')).toThrow(MemoryPermissionError)
    })

    it('app can read/write own app scope (both modes)', () => {
      expect(() => assertWritePermission(appCaller, 'app', 'append')).not.toThrow()
      expect(() => assertWritePermission(appCaller, 'app', 'replace')).not.toThrow()
    })
  })

  describe('scope listings', () => {
    it('user readable scopes are user + space', () => {
      expect(getReadableScopes(userCaller)).toEqual(['user', 'space'])
    })

    it('app readable scopes are user + space + app', () => {
      expect(getReadableScopes(appCaller)).toEqual(['user', 'space', 'app'])
    })

    it('user writable scopes include both modes', () => {
      const writable = getWritableScopes(userCaller)
      expect(writable).toHaveLength(2)
      expect(writable.find(s => s.scope === 'user')?.modes).toEqual(['append', 'replace'])
    })

    it('app writable scopes enforce append-only for space', () => {
      const writable = getWritableScopes(appCaller)
      const space = writable.find(s => s.scope === 'space')
      expect(space?.modes).toEqual(['append'])
      const app = writable.find(s => s.scope === 'app')
      expect(app?.modes).toEqual(['append', 'replace'])
    })
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

  describe('appendToMemoryFile', () => {
    it('should create file if it does not exist', async () => {
      const filePath = path.join(testDir, 'sub', 'new-memory.md')
      await appendToMemoryFile(filePath, 'Hello world', 'test')

      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toContain('Hello world')
      expect(content).toContain('by test')
    })

    it('should append to existing file', async () => {
      const filePath = path.join(testDir, 'existing.md')
      fs.writeFileSync(filePath, '# Existing\n', 'utf-8')

      await appendToMemoryFile(filePath, 'New content', 'test')

      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toContain('# Existing')
      expect(content).toContain('New content')
    })

    it('should include timestamp metadata comment', async () => {
      const filePath = path.join(testDir, 'meta.md')
      await appendToMemoryFile(filePath, 'Content', 'app:my-app')

      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toMatch(/<!-- \d{4}-\d{2}-\d{2}T.+ by app:my-app -->/)
    })
  })

  describe('replaceMemoryFile', () => {
    it('should create file with new content', async () => {
      const filePath = path.join(testDir, 'replace.md')
      await replaceMemoryFile(filePath, '# Fresh Content\n')

      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toBe('# Fresh Content\n')
    })

    it('should replace existing content entirely', async () => {
      const filePath = path.join(testDir, 'old.md')
      fs.writeFileSync(filePath, '# Old Content\n', 'utf-8')

      await replaceMemoryFile(filePath, '# New Content\n')

      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toBe('# New Content\n')
      expect(content).not.toContain('Old')
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

  describe('archiveMemoryFile', () => {
    it('should move memory file to archive directory', async () => {
      const filePath = path.join(testDir, 'memory.md')
      const archiveDir = path.join(testDir, 'archive')
      fs.writeFileSync(filePath, '# Memory Content', 'utf-8')

      const archived = await archiveMemoryFile(filePath, archiveDir)

      expect(fs.existsSync(filePath)).toBe(false) // Original removed
      expect(fs.existsSync(archived)).toBe(true) // Archive exists
      expect(fs.readFileSync(archived, 'utf-8')).toBe('# Memory Content')
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

  // ── V2 Read Modes ──────────────────────────────────────────────────────

  describe('readMemoryHeadings', () => {
    it('should return null for non-existent file', async () => {
      expect(await readMemoryHeadings(path.join(testDir, 'nope.md'))).toBeNull()
    })

    it('should return message when no headings found', async () => {
      const filePath = path.join(testDir, 'no-headings.md')
      fs.writeFileSync(filePath, 'Just some text\nwithout any headings', 'utf-8')

      const result = await readMemoryHeadings(filePath)
      expect(result).toBe('(No markdown headings found in memory file)')
    })

    it('should extract headings with line numbers', async () => {
      const filePath = path.join(testDir, 'structured.md')
      fs.writeFileSync(filePath, [
        '# State',
        'Some state data',
        '',
        '## Tracked Items',
        '- item 1',
        '- item 2',
        '',
        '## Patterns',
        'Some patterns',
        '',
        '# Config',
        'key: value',
      ].join('\n'), 'utf-8')

      const result = await readMemoryHeadings(filePath)
      expect(result).toBe([
        'L1: # State',
        'L4: ## Tracked Items',
        'L8: ## Patterns',
        'L11: # Config',
      ].join('\n'))
    })

    it('should handle all heading levels', async () => {
      const filePath = path.join(testDir, 'levels.md')
      fs.writeFileSync(filePath, [
        '# H1',
        '## H2',
        '### H3',
        '#### H4',
        '##### H5',
        '###### H6',
      ].join('\n'), 'utf-8')

      const result = await readMemoryHeadings(filePath)
      expect(result).toContain('L1: # H1')
      expect(result).toContain('L6: ###### H6')
    })
  })

  describe('readMemorySection', () => {
    const sampleContent = [
      '# State',
      'Current state info',
      '',
      '## Tracked Items',
      '- item A',
      '- item B',
      '',
      '## Patterns',
      'Pattern 1: always do X',
      'Pattern 2: never do Y',
      '',
      '# Config',
      'timeout: 30s',
    ].join('\n')

    it('should return null for non-existent file', async () => {
      expect(await readMemorySection(path.join(testDir, 'nope.md'), 'State')).toBeNull()
    })

    it('should return null for non-existent section', async () => {
      const filePath = path.join(testDir, 'sections.md')
      fs.writeFileSync(filePath, sampleContent, 'utf-8')

      expect(await readMemorySection(filePath, 'Nonexistent')).toBeNull()
    })

    it('should extract section by heading text (case-insensitive)', async () => {
      const filePath = path.join(testDir, 'sections.md')
      fs.writeFileSync(filePath, sampleContent, 'utf-8')

      const result = await readMemorySection(filePath, 'tracked')
      expect(result).toContain('## Tracked Items')
      expect(result).toContain('- item A')
      expect(result).toContain('- item B')
      // Should NOT contain the next section
      expect(result).not.toContain('Pattern 1')
    })

    it('should extract top-level section including subsections', async () => {
      const filePath = path.join(testDir, 'sections.md')
      fs.writeFileSync(filePath, sampleContent, 'utf-8')

      const result = await readMemorySection(filePath, 'State')
      expect(result).toContain('# State')
      expect(result).toContain('Current state info')
      expect(result).toContain('## Tracked Items')
      expect(result).toContain('## Patterns')
      // Should stop at the next H1
      expect(result).not.toContain('# Config')
    })

    it('should handle section at end of file', async () => {
      const filePath = path.join(testDir, 'sections.md')
      fs.writeFileSync(filePath, sampleContent, 'utf-8')

      const result = await readMemorySection(filePath, 'Config')
      expect(result).toContain('# Config')
      expect(result).toContain('timeout: 30s')
    })
  })

  describe('readMemoryTail', () => {
    it('should return null for non-existent file', async () => {
      expect(await readMemoryTail(path.join(testDir, 'nope.md'))).toBeNull()
    })

    it('should return entire file when shorter than limit', async () => {
      const filePath = path.join(testDir, 'short.md')
      fs.writeFileSync(filePath, 'line 1\nline 2\nline 3', 'utf-8')

      const result = await readMemoryTail(filePath, 50)
      expect(result).toBe('line 1\nline 2\nline 3')
    })

    it('should return last N lines for long files', async () => {
      const filePath = path.join(testDir, 'long.md')
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')

      const result = await readMemoryTail(filePath, 5)
      expect(result).toContain('showing last 5 of 100 lines')
      expect(result).toContain('line 96')
      expect(result).toContain('line 100')
      expect(result).not.toContain('line 95')
    })

    it('should default to 50 lines', async () => {
      const filePath = path.join(testDir, 'default.md')
      const lines = Array.from({ length: 200 }, (_, i) => `entry ${i + 1}`)
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')

      const result = await readMemoryTail(filePath)
      expect(result).toContain('showing last 50 of 200 lines')
      expect(result).toContain('entry 151')
      expect(result).toContain('entry 200')
    })
  })
})

// ============================================================================
// Prompt Instructions
// ============================================================================

describe('generatePromptInstructions', () => {
  it('should describe the memory file and its native-tool workflow', () => {
    const instructions = generatePromptInstructions()
    expect(instructions).toContain('## Memory')
    expect(instructions).toContain('memory.md')
    // Native file tools replace the old memory_read/memory_write MCP tools
    expect(instructions).toContain('Edit')
    expect(instructions).toContain('Write')
    expect(instructions).toContain('Read')
  })

  it('should describe the # now / # History document structure', () => {
    const instructions = generatePromptInstructions()
    expect(instructions).toContain('# now')
    expect(instructions).toContain('# History')
    expect(instructions).toContain('## State')
  })

  it('should describe the # now working-memory sections', () => {
    const instructions = generatePromptInstructions()
    expect(instructions).toContain('Patterns')
    expect(instructions).toContain('Errors')
  })
})
