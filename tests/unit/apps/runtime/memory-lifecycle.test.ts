/**
 * apps/runtime/turn/memory-lifecycle — a digital human's memory around a turn.
 *
 * - prepareMemoryForTurn pre-inserts a History heading by default and skips it
 *   when preInsertHistory is false (the team-turn policy).
 * - finalizeMemoryAfterTurn skips the run record on noop runs and requests
 *   consolidation unless told not to.
 * - memory_schema reaches the instructions as tracked items.
 * - The space's topics are offered read-only when enabled for the app and space.
 * - The guard lets the digital human write its own memory and only read the
 *   space's.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import type { MemoryCallerScope, MemoryService } from '../../../../src/main/platform/memory'
import type { TriggerContext } from '../../../../src/main/apps/runtime/types'

vi.mock('../../../../src/main/services/memory-consolidation', () => ({
  requestConsolidation: vi.fn(),
}))

let spaceMemoryEnabled = true
const teamMembers = vi.hoisted(() => ({ byApp: new Map<string, unknown[]>(), ready: true }))
vi.mock('../../../../src/main/apps/team', () => ({
  getTeamStore: () => teamMembers.ready
    ? { listMembersByAppId: (appId: string) => teamMembers.byApp.get(appId) ?? [] }
    : null,
}))

vi.mock('../../../../src/main/services/space.service', () => ({
  isSpaceMemoryEnabled: vi.fn(() => spaceMemoryEnabled),
}))

import {
  prepareMemoryForTurn,
  finalizeMemoryAfterTurn,
  memoryTracksFromSpec,
  memoryPromptOptions,
  loadSpaceTopicsForTurn,
  appMemoryGuard,
  type MemoryFinalizeContext,
  type AppConsolidationInputs,
} from '../../../../src/main/apps/runtime/turn/memory-lifecycle'
import { requestConsolidation } from '../../../../src/main/services/memory-consolidation'

const scope: MemoryCallerScope = {
  type: 'app',
  spaceId: 'space-1',
  spacePath: '/tmp/space-1',
  appId: 'app-1',
}

const trigger = { type: 'manual', description: 'test' } as unknown as TriggerContext

const consolidation: AppConsolidationInputs = {
  appName: 'Test App',
  settings: { enabled: true, autoConsolidate: true, cadence: 'diligent' },
  resolveCredentials: async () => ({}) as never,
  isBusy: () => false,
}

function makeMemory(): MemoryService {
  return {
    saveSessionSummary: vi.fn(async () => {}),
    getPromptInstructions: vi.fn(() => ''),
  }
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

describe('prepareMemoryForTurn', () => {
  let dir = ''
  let memoryFile = ''
  let prepareScope: MemoryCallerScope

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mem-lifecycle-'))
    memoryFile = join(dir, '.halo', 'apps', 'app-1', 'memory.md')
    mkdirSync(dirname(memoryFile), { recursive: true })
    prepareScope = { ...scope, spacePath: dir }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('pre-inserts a History heading by default, and the snapshot already holds it', async () => {
    writeFileSync(memoryFile, '# now\n\n## State\n\n# History\n', 'utf-8')

    const { snapshot, runTimestamp } = await prepareMemoryForTurn(prepareScope, { byLabel: 'schedule#a1b2' })

    expect(snapshot.layout.file).toBe(memoryFile)
    const written = readFileSync(memoryFile, 'utf-8')
    expect(written).toMatch(/# History\s*\n\n## \d{4}-\d{2}-\d{2}-\d{4}  \[by: schedule#a1b2\]/)
    expect(snapshot.fullContent).toContain(`## ${runTimestamp}`)
  })

  it('does NOT pre-insert when preInsertHistory is false (team policy)', async () => {
    const content = '# now\n\n## State\n\n# History\n'
    writeFileSync(memoryFile, content, 'utf-8')

    await prepareMemoryForTurn(prepareScope, { preInsertHistory: false })

    expect(readFileSync(memoryFile, 'utf-8')).toBe(content)
  })

  it('gives a chat or team turn a skeleton to edit when the digital human has no memory yet', async () => {
    const { snapshot } = await prepareMemoryForTurn(prepareScope, { preInsertHistory: false })

    expect(readFileSync(memoryFile, 'utf-8')).toBe('# now\n\n## State\n\n# History\n')
    expect(snapshot.exists).toBe(true)
    expect(snapshot.blank).toBe(true)
  })
})

describe('finalizeMemoryAfterTurn', () => {
  beforeEach(() => { vi.mocked(requestConsolidation).mockClear() })

  it('skips the run record on noop runs', async () => {
    const memory = makeMemory()
    await finalizeMemoryAfterTurn(memory, scope, baseCtx({ outcome: 'noop' }), consolidation)
    expect(memory.saveSessionSummary).not.toHaveBeenCalled()
  })

  it('records the run and requests consolidation of the app memory by default', async () => {
    const memory = makeMemory()
    await finalizeMemoryAfterTurn(memory, scope, baseCtx(), consolidation)
    expect(memory.saveSessionSummary).toHaveBeenCalledTimes(1)
    expect(requestConsolidation).toHaveBeenCalledTimes(1)
    const req = vi.mocked(requestConsolidation).mock.calls[0][0]
    expect(req.ownerKind).toBe('digital-human')
    expect(req.ownerName).toBe('Test App')
    expect(req.layout.file).toBe('/tmp/space-1/.halo/apps/app-1/memory.md')
  })

  it('does nothing at all when memory is turned off', async () => {
    const memory = makeMemory()
    await finalizeMemoryAfterTurn(memory, scope, baseCtx(), { ...consolidation, settings: { ...consolidation.settings, enabled: false } })
    expect(memory.saveSessionSummary).not.toHaveBeenCalled()
    expect(requestConsolidation).not.toHaveBeenCalled()
  })

  it('records the run but requests no consolidation when consolidate:false', async () => {
    const memory = makeMemory()
    await finalizeMemoryAfterTurn(memory, scope, baseCtx(), consolidation, {
      saveSessionSummary: true,
      consolidate: false,
    })
    expect(memory.saveSessionSummary).toHaveBeenCalledTimes(1)
    expect(requestConsolidation).not.toHaveBeenCalled()
  })
})

describe('memoryPromptOptions', () => {
  const spec = { type: 'automation', name: 'x' } as never

  it('carries team guidance only for a digital human that belongs to a team', () => {
    teamMembers.byApp.set('in-team', [{ teamId: 't1' }])
    expect(memoryPromptOptions('in-team', spec).inTeam).toBe(true)
    expect(memoryPromptOptions('solo', spec).inTeam).toBe(false)
  })

  it('keeps team guidance when membership cannot be read', () => {
    teamMembers.ready = false
    try {
      expect(memoryPromptOptions('solo', spec).inTeam).toBe(true)
    } finally {
      teamMembers.ready = true
    }
  })
})

describe('memoryTracksFromSpec', () => {
  it('turns memory_schema into tracked items', () => {
    const tracks = memoryTracksFromSpec({
      type: 'automation',
      name: 'x',
      memory_schema: { faq_cache: { type: 'object', description: 'cached answers' } },
    } as never)
    expect(tracks).toEqual([{ name: 'faq_cache', type: 'object', description: 'cached answers' }])
  })

  it('yields nothing when the spec declares none', () => {
    expect(memoryTracksFromSpec({ type: 'automation', name: 'x' } as never)).toBeUndefined()
  })
})

describe('loadSpaceTopicsForTurn', () => {
  let dir = ''
  let spaceScope: MemoryCallerScope

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mem-space-'))
    const topics = join(dir, '.halo', 'memory', 'topics')
    mkdirSync(topics, { recursive: true })
    writeFileSync(join(topics, 'release.md'), '---\nname: Release\ndescription: when shipping\n---\nbody\n')
    spaceScope = { ...scope, spacePath: dir }
    spaceMemoryEnabled = true
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('offers the space topics to every turn when allowed', async () => {
    const tree = await loadSpaceTopicsForTurn(spaceScope, { enabledForApp: true })
    expect(tree?.topicCount).toBe(1)
  })

  it('offers nothing when not allowed, or when the space turned memory off', async () => {
    expect(await loadSpaceTopicsForTurn(spaceScope, { enabledForApp: false })).toBeNull()
    spaceMemoryEnabled = false
    expect(await loadSpaceTopicsForTurn(spaceScope, { enabledForApp: true })).toBeNull()
  })
})

describe('appMemoryGuard', () => {
  it('writes its own memory and only reads the space memory', () => {
    const guard = appMemoryGuard(scope, 'run', consolidation.settings)
    expect(guard.writable.map(l => l.file)).toEqual(['/tmp/space-1/.halo/apps/app-1/memory.md'])
    expect(guard.readOnly?.map(l => l.file)).toEqual(['/tmp/space-1/.halo/memory.md'])
  })

  it('writes nothing when its memory is turned off', () => {
    const guard = appMemoryGuard(scope, 'run', { ...consolidation.settings, enabled: false })
    expect(guard.writable).toEqual([])
    expect(guard.readOnly?.map(l => l.file)).toContain('/tmp/space-1/.halo/apps/app-1/memory.md')
  })
})
