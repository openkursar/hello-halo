/**
 * Characterization tests for apps/runtime/turn/memory-lifecycle.
 *
 * These lock the behavior extracted verbatim from execute.ts so the refactor
 * is provably behavior-preserving:
 * - prepareMemoryForTurn pre-inserts a History heading by default and skips it
 *   when preInsertHistory is false (the team-turn policy).
 * - finalizeMemoryAfterTurn skips the session summary on noop runs, honors the
 *   compact/saveSessionSummary option gates, and only reaches compaction when
 *   the store reports it is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { MemoryCallerScope, MemoryService } from '../../../../src/main/platform/memory'
import type { TriggerContext } from '../../../../src/main/apps/runtime/types'

// Control buildMemorySnapshot so prepareMemoryForTurn runs against a temp file
// while preInsertHistoryHeading exercises the real fs writes.
let snapshotFilePath = ''
let snapshotRawContent: string | null = null

vi.mock('../../../../src/main/platform/memory/snapshot', () => ({
  buildMemorySnapshot: vi.fn(async () => ({
    exists: snapshotRawContent !== null,
    totalLines: 0,
    sizeBytes: 0,
    headers: [],
    archiveTotalCount: 0,
    memoryFilePath: snapshotFilePath,
    rawContent: snapshotRawContent,
  })),
  createMemoryStatusMcpServer: vi.fn(),
}))

import {
  prepareMemoryForTurn,
  finalizeMemoryAfterTurn,
  formatRunTimestamp,
  type MemoryFinalizeContext,
  type CompactionCredentialsProvider,
} from '../../../../src/main/apps/runtime/turn/memory-lifecycle'

const scope: MemoryCallerScope = {
  type: 'app',
  spaceId: 'space-1',
  spacePath: '/tmp/space-1',
  appId: 'app-1',
}

const trigger = { type: 'manual', description: 'test' } as unknown as TriggerContext

const creds: CompactionCredentialsProvider = async () => ({
  anthropicApiKey: 'k',
  anthropicBaseUrl: 'https://example.invalid',
  sdkModel: 'test-model',
})

function makeMemory(overrides: Partial<MemoryService> = {}): MemoryService {
  return {
    saveSessionSummary: vi.fn(async () => {}),
    needsCompaction: vi.fn(async () => false),
    read: vi.fn(async () => ''),
    compact: vi.fn(async () => ({ archived: 'archive.md', needsSummary: false })),
    write: vi.fn(async () => {}),
    ...overrides,
  } as unknown as MemoryService
}

function baseCtx(overrides: Partial<MemoryFinalizeContext> = {}): MemoryFinalizeContext {
  return {
    appName: 'Test App',
    runId: 'run-1',
    trigger,
    outcome: 'useful',
    durationMs: 100,
    tokensUsed: 50,
    finalText: 'done',
    escalation: false,
    runTag: 'tag',
    ...overrides,
  }
}

describe('formatRunTimestamp', () => {
  it('formats as YYYY-MM-DD-HHmm (local, zero-padded)', () => {
    const d = new Date(2026, 0, 5, 9, 7) // Jan 5 2026 09:07 local
    expect(formatRunTimestamp(d)).toBe('2026-01-05-0907')
  })
})

describe('prepareMemoryForTurn', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mem-lifecycle-'))
    snapshotFilePath = join(dir, 'memory.md')
    snapshotRawContent = null
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('pre-inserts a History heading by default into existing content', async () => {
    snapshotRawContent = '# now\n\n## State\n\n# History\n'
    writeFileSync(snapshotFilePath, snapshotRawContent, 'utf-8')

    const { snapshot, runTimestamp } = await prepareMemoryForTurn(scope)

    expect(snapshot.memoryFilePath).toBe(snapshotFilePath)
    const written = readFileSync(snapshotFilePath, 'utf-8')
    expect(written).toContain(`## ${runTimestamp}`)
    // Heading sits right after the # History line
    expect(written).toMatch(/# History\s*\n\n## \d{4}-\d{2}-\d{2}-\d{4}/)
  })

  it('does NOT pre-insert when preInsertHistory is false (team policy)', async () => {
    snapshotRawContent = '# now\n\n## State\n\n# History\n'
    writeFileSync(snapshotFilePath, snapshotRawContent, 'utf-8')

    await prepareMemoryForTurn(scope, { preInsertHistory: false })

    const written = readFileSync(snapshotFilePath, 'utf-8')
    expect(written).toBe(snapshotRawContent) // untouched
  })
})

describe('finalizeMemoryAfterTurn', () => {
  it('skips session summary on noop runs', async () => {
    const memory = makeMemory()
    await finalizeMemoryAfterTurn(memory, scope, baseCtx({ outcome: 'noop' }), creds)
    expect(memory.saveSessionSummary).not.toHaveBeenCalled()
  })

  it('saves session summary but skips compaction when compact:false', async () => {
    const memory = makeMemory()
    await finalizeMemoryAfterTurn(memory, scope, baseCtx(), creds, {
      saveSessionSummary: true,
      compact: false,
    })
    expect(memory.saveSessionSummary).toHaveBeenCalledTimes(1)
    expect(memory.needsCompaction).not.toHaveBeenCalled()
  })

  it('checks compaction need by default and stops when not needed', async () => {
    const memory = makeMemory({ needsCompaction: vi.fn(async () => false) })
    await finalizeMemoryAfterTurn(memory, scope, baseCtx(), creds)
    expect(memory.needsCompaction).toHaveBeenCalledTimes(1)
    expect(memory.compact).not.toHaveBeenCalled()
  })

  it('compacts (archive) but skips LLM/write when compact reports no summary needed', async () => {
    const memory = makeMemory({
      needsCompaction: vi.fn(async () => true),
      read: vi.fn(async () => '# now\n\n# History\n'),
      compact: vi.fn(async () => ({ archived: 'a.md', needsSummary: false })),
    })
    await finalizeMemoryAfterTurn(memory, scope, baseCtx(), creds)
    expect(memory.compact).toHaveBeenCalledTimes(1)
    expect(memory.write).not.toHaveBeenCalled()
  })
})
