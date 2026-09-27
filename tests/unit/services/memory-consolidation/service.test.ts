/**
 * services/memory-consolidation: the harness around the agent.
 *
 * - Runs only when due by cadence, one at a time per memory, deferred while in
 *   use (but not forever).
 * - A rejected result or a conflict goes back to the SAME agent with what to
 *   fix; the memory changes only when a result passes.
 * - Out of rounds: History is trimmed without the agent, and automatic attempts
 *   wait until the memory has grown.
 * - Auto-consolidation off: History is only trimmed.
 * - "Consolidate now" ignores thresholds and busy state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

type Round = { ok: true; summary: string; turns: number; exhausted: boolean } | { ok: false; reason: string }
type Ws = { memoryFile: string; topicsDir: string }
const start = vi.fn<[Ws], Promise<Round>>()
const followUp = vi.fn<[Ws, string], Promise<Round>>()
vi.mock('../../../../src/main/services/memory-consolidation/runner', () => ({
  createConsolidationAgent: (input: { ws: Ws }) => ({
    start: () => start(input.ws),
    followUp: (feedback: string[]) => followUp(input.ws, feedback.join('\n\n')),
  }),
}))

import {
  requestConsolidation,
  consolidateNow,
  type ConsolidationRequest,
} from '../../../../src/main/services/memory-consolidation/service'
import { isConsolidationDue, resolveMemoryLayout, type MemoryLayout } from '../../../../src/main/platform/memory'
import { insertHistoryHeading } from '../../../../src/main/platform/memory/file-ops'

let space = ''
let layout: MemoryLayout

const ok: Round = { ok: true, summary: 'done', turns: 2, exhausted: false }
const exhausted: Round = { ok: true, summary: '', turns: 60, exhausted: true }
const topic = (description: string, body: string) => `---\ndescription: ${description}\n---\n${body}\n`

function history(n: number): string {
  return Array.from({ length: n }, (_, i) => `## 2026-01-01-${1000 + n - i} | e${n - i}\n`).join('\n')
}

/** Due under the diligent cadence by History length. */
const DUE = `# now\n## State | big\n\n# History\n${history(40)}`

function request(overrides: Partial<ConsolidationRequest> = {}): ConsolidationRequest {
  return {
    layout,
    ownerKind: 'space',
    ownerName: 'Test',
    spaceId: 's',
    tag: 't',
    settings: { autoConsolidate: true, cadence: 'diligent' },
    resolveCredentials: async () => ({}) as never,
    ...overrides,
  }
}

const flush = () => new Promise(r => setTimeout(r, 50))

function tidy(ws: { memoryFile: string }): void {
  writeFileSync(ws.memoryFile, `# now\n## State | tidy\n\n# History\n${history(3)}`)
}

beforeEach(() => {
  start.mockReset()
  followUp.mockReset()
  space = mkdtempSync(join(tmpdir(), 'consolidation-svc-'))
  layout = resolveMemoryLayout({ type: 'user', spaceId: 's', spacePath: space }, 'space')
  mkdirSync(join(space, '.halo'), { recursive: true })
})

afterEach(() => rmSync(space, { recursive: true, force: true }))

describe('requestConsolidation', () => {
  it('does nothing while the memory is not due', async () => {
    writeFileSync(layout.file, '# now\n\n# History\n')
    requestConsolidation(request())
    await flush()
    expect(start).not.toHaveBeenCalled()
  })

  it('commits what the agent produced and records when', async () => {
    writeFileSync(layout.file, DUE)
    start.mockImplementation(async ws => { tidy(ws); return ok })
    requestConsolidation(request())
    await vi.waitFor(() => expect(readFileSync(layout.file, 'utf-8')).toContain('## State | tidy'))
    await vi.waitFor(() => expect(JSON.parse(readFileSync(layout.stateFile, 'utf-8')).lastConsolidatedAt).toBeTruthy())
  })

  it('runs one consolidation per memory even when two turns end together', async () => {
    writeFileSync(layout.file, DUE)
    start.mockImplementation(async ws => { await flush(); tidy(ws); return ok })
    requestConsolidation(request())
    requestConsolidation(request())
    await vi.waitFor(() => expect(readFileSync(layout.file, 'utf-8')).toContain('tidy'))
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('hands a rejected result back to the same agent with the reason, then commits the fix', async () => {
    writeFileSync(layout.file, DUE)
    start.mockImplementation(async ws => { writeFileSync(ws.memoryFile, '# now\n## State | lost history\n'); return ok })
    followUp.mockImplementation(async ws => { tidy(ws); return ok })
    requestConsolidation(request())
    await vi.waitFor(() => expect(readFileSync(layout.file, 'utf-8')).toContain('## State | tidy'))
    expect(followUp).toHaveBeenCalledTimes(1)
    expect(followUp.mock.calls[0][1]).toContain('# History')
  })

  it('hands changes made meanwhile to the agent, and commits once merged', async () => {
    writeFileSync(layout.file, DUE)
    start.mockImplementation(async ws => {
      tidy(ws)
      writeFileSync(layout.file, readFileSync(layout.file, 'utf-8').replace('## State | big', '## State | big\n- decided: ship friday'))
      return ok
    })
    followUp.mockImplementation(async ws => {
      writeFileSync(ws.memoryFile, `# now\n## State | tidy\n- decided: ship friday\n\n# History\n${history(3)}`)
      return ok
    })
    requestConsolidation(request())
    await vi.waitFor(() => expect(readFileSync(layout.file, 'utf-8')).toContain('## State | tidy'))
    expect(followUp.mock.calls[0][1]).toContain('- decided: ship friday')
    expect(readFileSync(layout.file, 'utf-8')).toContain('- decided: ship friday')
  })

  describe('a true conflict stays in every round until a result is accepted', () => {
    /** The agent tidies x.md while another conversation adds a fact to it live. */
    function conflictOnX(): void {
      mkdirSync(layout.topicsDir, { recursive: true })
      writeFileSync(join(layout.topicsDir, 'x.md'), topic('x', 'base'))
      writeFileSync(layout.file, DUE)
      start.mockImplementation(async ws => {
        tidy(ws)
        writeFileSync(join(ws.topicsDir, 'x.md'), topic('x', 'base tidied'))
        writeFileSync(join(layout.topicsDir, 'x.md'), topic('x', 'base\n- LIVE FACT'))
        return ok
      })
    }
    const mergeX = (ws: Ws) => writeFileSync(join(ws.topicsDir, 'x.md'), topic('x', 'base tidied\n- LIVE FACT'))

    it('a validation failure after the conflict still carries the merge instructions', async () => {
      conflictOnX()
      // Starts a split, forgets its description — without merging yet.
      followUp.mockImplementationOnce(async ws => { writeFileSync(join(ws.topicsDir, 'y.md'), 'no front matter\n'); return ok })
      // Does what the message asks: fixes y.md, and merges x.md only if still told to.
      followUp.mockImplementationOnce(async (ws, message) => {
        writeFileSync(join(ws.topicsDir, 'y.md'), topic('y', 'split'))
        if (message.includes('.incoming') && message.includes('x.md')) mergeX(ws)
        return ok
      })
      requestConsolidation(request())
      await vi.waitFor(() => expect(readFileSync(layout.file, 'utf-8')).toContain('## State | tidy'))

      const messages = followUp.mock.calls.map(c => c[1])
      expect(messages[0]).toContain('.incoming')
      expect(messages[1]).toContain('.incoming')
      expect(messages[1]).toContain('topics/x.md')
      expect(messages[1]).toContain('description')
      expect(readFileSync(join(layout.topicsDir, 'x.md'), 'utf-8')).toContain('LIVE FACT')
    })

    it('a round that runs out of turns while merging is not committed', async () => {
      conflictOnX()
      followUp.mockImplementationOnce(async () => exhausted)
      followUp.mockImplementationOnce(async ws => { mergeX(ws); return ok })
      requestConsolidation(request())
      await vi.waitFor(() => expect(readFileSync(layout.file, 'utf-8')).toContain('## State | tidy'))

      expect(followUp).toHaveBeenCalledTimes(2)
      expect(followUp.mock.calls[1][1]).toContain('ran out of steps')
      expect(followUp.mock.calls[1][1]).toContain('.incoming')
      expect(readFileSync(join(layout.topicsDir, 'x.md'), 'utf-8')).toContain('LIVE FACT')
    })

    it('a round that leaves the conflicting file untouched is not committed, and is told so', async () => {
      conflictOnX()
      // Says it is done without touching x.md; meanwhile # now changes live too.
      followUp.mockImplementationOnce(async () => {
        writeFileSync(layout.file, readFileSync(layout.file, 'utf-8').replace('## State | big', '## State | big\n- LIVE NOW'))
        return ok
      })
      // Does what the latest message asks, nothing more.
      followUp.mockImplementation(async (ws, message) => {
        if (message.includes('topics/x.md')) mergeX(ws)
        if (message.includes('- LIVE NOW')) {
          writeFileSync(ws.memoryFile, readFileSync(ws.memoryFile, 'utf-8').replace('## State | tidy', '## State | tidy\n- LIVE NOW'))
        }
        return ok
      })
      requestConsolidation(request())
      await vi.waitFor(() => expect(readFileSync(layout.file, 'utf-8')).toContain('## State | tidy'))

      const messages = followUp.mock.calls.map(c => c[1])
      expect(messages[1]).toContain('nothing was merged into `topics/x.md`')
      expect(readFileSync(join(layout.topicsDir, 'x.md'), 'utf-8')).toContain('LIVE FACT')
      expect(readFileSync(layout.file, 'utf-8')).toContain('- LIVE NOW')
    })

    it('never touched: gives up rather than overwrite the live change', async () => {
      conflictOnX()
      followUp.mockImplementation(async () => ok)
      requestConsolidation(request())
      await vi.waitFor(() => expect(JSON.parse(readFileSync(layout.stateFile, 'utf-8')).lastAttempt?.outcome).toBe('trimmed'))
      expect(followUp).toHaveBeenCalledTimes(3)
      expect(readFileSync(join(layout.topicsDir, 'x.md'), 'utf-8')).toContain('LIVE FACT')
    })

    it('never merged: gives up rather than overwrite the live change', async () => {
      conflictOnX()
      followUp.mockImplementation(async () => exhausted)
      requestConsolidation(request())
      await vi.waitFor(() => expect(JSON.parse(readFileSync(layout.stateFile, 'utf-8')).lastAttempt?.outcome).toBe('trimmed'))
      expect(readFileSync(join(layout.topicsDir, 'x.md'), 'utf-8')).toContain('LIVE FACT')
      expect(readFileSync(layout.file, 'utf-8')).not.toContain('## State | tidy')
    })
  })

  it('out of rounds: trims History without the agent, keeps # now, and cools down', async () => {
    writeFileSync(layout.file, DUE)
    start.mockResolvedValue({ ok: false, reason: 'model down' })
    requestConsolidation(request())
    await vi.waitFor(() => {
      const content = readFileSync(layout.file, 'utf-8')
      expect(content).toContain('## State | big')
      expect(content.match(/^## 2026/gm)).toHaveLength(10)
    })
    await vi.waitFor(() => expect(existsSync(layout.stateFile)).toBe(true))
    const state = JSON.parse(readFileSync(layout.stateFile, 'utf-8'))
    expect(state.lastAttempt.outcome).toBe('trimmed')
  })

  it('gives up after its feedback rounds rather than looping', async () => {
    writeFileSync(layout.file, DUE)
    const broken: Round = ok
    start.mockImplementation(async ws => { writeFileSync(ws.memoryFile, 'no headings'); return broken })
    followUp.mockImplementation(async () => broken)
    requestConsolidation(request())
    await vi.waitFor(() => expect(readFileSync(layout.file, 'utf-8').match(/^## 2026/gm)).toHaveLength(10))
    expect(followUp).toHaveBeenCalledTimes(3)
  })

  it('defers while the memory is in use, then goes ahead anyway', async () => {
    writeFileSync(layout.file, DUE)
    start.mockResolvedValue({ ok: false, reason: 'test' })
    for (let i = 0; i < 4; i++) {
      requestConsolidation(request({ isBusy: () => true }))
      await flush()
    }
    expect(start).not.toHaveBeenCalled()
    // A trigger still checking drops the next one, so under load it may take more.
    await vi.waitFor(async () => {
      requestConsolidation(request({ isBusy: () => true }))
      await flush()
      expect(start).toHaveBeenCalledTimes(1)
    }, { timeout: 5000 })
  })

  it('with auto-consolidation off, a large # now alone archives nothing, turn after turn', async () => {
    writeFileSync(layout.file, `# now\n${'- fact: value\n'.repeat(1000)}\n# History\n${history(5)}`)
    for (let i = 0; i < 5; i++) {
      requestConsolidation(request({ settings: { autoConsolidate: false, cadence: 'diligent' } }))
      await flush()
    }
    expect(existsSync(layout.archiveDir)).toBe(false)
    expect(readFileSync(layout.file, 'utf-8').match(/^## 2026/gm)).toHaveLength(5)
  })

  it('with auto-consolidation off, archives long History once, then waits for growth', async () => {
    writeFileSync(layout.file, DUE)
    for (let i = 0; i < 5; i++) {
      requestConsolidation(request({ settings: { autoConsolidate: false, cadence: 'diligent' } }))
      await flush()
    }
    expect(readdirSync(layout.archiveDir)).toHaveLength(1)
  })

  it('with auto-consolidation off, archiving is no failed attempt and holds History at its limit', async () => {
    const off = request({ settings: { autoConsolidate: false, cadence: 'diligent' } })
    // `# now` over its threshold: what made every archive count as a failure before.
    writeFileSync(layout.file, `# now\n## State\n${'- k: v\n'.repeat(1400)}\n# History\n${history(30)}`)
    let most = 0
    for (let turn = 0; turn < 120; turn++) {
      await insertHistoryHeading(layout.file, `2026-02-01-${String(1000 + turn)}`, `chat#n${turn}`)
      most = Math.max(most, readFileSync(layout.file, 'utf-8').match(/^## 20/gm)?.length ?? 0)
      requestConsolidation(off)
      await vi.waitFor(() => expect(readFileSync(layout.file, 'utf-8').match(/^## 20/gm)!.length).toBeLessThanOrEqual(30))
      await flush()
    }
    expect(most).toBeLessThanOrEqual(31)
    const state = JSON.parse(readFileSync(layout.stateFile, 'utf-8'))
    expect(state.lastArchivedAt).toBeTruthy()
    expect(state.lastAttempt).toBeUndefined()
    expect(state.consecutiveFailures).toBeUndefined()
    expect(state.cooldownUntilBytes).toBeUndefined()

    // Turned back on: due at once, not held back by the archiving.
    const due = await isConsolidationDue(layout, 'diligent', { nowCapBytes: 8192 })
    expect(due).toMatchObject({ due: true, coolingDown: false, tooSoon: false })
  })

  it('over its size limit alone, archives once, then waits for the file to grow', async () => {
    const off = request({ settings: { autoConsolidate: false, cadence: 'diligent' } })
    // Over the diligent 100KB total with History well under its entry limit.
    writeFileSync(layout.file, `# now\n${'- fact: value value value value\n'.repeat(4000)}\n# History\n${history(20)}`)
    for (let i = 0; i < 5; i++) {
      requestConsolidation(off)
      await flush()
    }
    expect(readdirSync(layout.archiveDir)).toHaveLength(1)
    expect(JSON.parse(readFileSync(layout.stateFile, 'utf-8')).archiveCooldownUntilBytes).toBeGreaterThan(100 * 1024)
  })

  it('with auto-consolidation off, only archives old History', async () => {
    writeFileSync(layout.file, DUE)
    requestConsolidation(request({ settings: { autoConsolidate: false, cadence: 'diligent' } }))
    await vi.waitFor(() => expect(readFileSync(layout.file, 'utf-8').match(/^## 2026/gm)).toHaveLength(10))
    expect(start).not.toHaveBeenCalled()
  })
})

describe('consolidateNow', () => {
  it('a failed run on a memory within its limits leaves it as it was', async () => {
    const small = `# now\n## State | small\n\n# History\n${history(12)}`
    writeFileSync(layout.file, small)
    start.mockResolvedValue({ ok: false, reason: 'model down' })
    consolidateNow(request())
    await vi.waitFor(() => expect(existsSync(layout.stateFile)).toBe(true))
    expect(readFileSync(layout.file, 'utf-8')).toBe(small)
  })

  it('is not blocked by an automatic trigger that is only checking', async () => {
    writeFileSync(layout.file, '# now\n## State | small\n\n# History\n')
    start.mockImplementation(async ws => { tidy(ws); return ok })
    requestConsolidation(request())
    expect(consolidateNow(request())).toEqual({ started: true })
    await vi.waitFor(() => expect(readFileSync(layout.file, 'utf-8')).toContain('tidy'))
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('runs whatever the thresholds and busy state, and says when there is nothing', async () => {
    expect(consolidateNow(request())).toEqual({ started: false, reason: 'empty' })

    writeFileSync(layout.file, '# now\n## State | small\n\n# History\n')
    start.mockImplementation(async ws => { tidy(ws); return ok })
    expect(consolidateNow(request({ isBusy: () => true }))).toEqual({ started: true })
    expect(consolidateNow(request())).toEqual({ started: false, reason: 'already-running' })
    await vi.waitFor(() => expect(readFileSync(layout.file, 'utf-8')).toContain('tidy'))
  })
})
