import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../../../../src/main/platform/memory', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    isConsolidationDue: vi.fn(),
    isArchiveDue: vi.fn(),
    buildMemorySnapshot: vi.fn(),
    prepareConsolidation: vi.fn(),
    validateConsolidation: vi.fn(),
    commitConsolidation: vi.fn(),
    discardConsolidation: vi.fn(),
    assessConsolidation: vi.fn(),
    trimHistoryFallback: vi.fn(),
    recordFailedAttempt: vi.fn(),
    recordCommit: vi.fn(),
    recordArchive: vi.fn(),
  }
})
vi.mock('../../../../src/main/services/memory-consolidation/runner', () => ({
  createConsolidationAgent: vi.fn(),
}))

import * as memory from '../../../../src/main/platform/memory'
import { createConsolidationAgent } from '../../../../src/main/services/memory-consolidation/runner'
import {
  consolidateNow, requestConsolidation, suspendMemoryConsolidation, isConsolidating,
  type ConsolidationRequest, type MemoryConsolidationSuspension,
} from '../../../../src/main/services/memory-consolidation/service'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

let root: string
let req: ConsolidationRequest
let leases: MemoryConsolidationSuspension[]
const start = vi.fn()
const followUp = vi.fn()
const success = { ok: true, summary: '', turns: 1, exhausted: false }
const snapshot = { sizeBytes: 100, nowBytes: 10, topics: { topicCount: 0 } }
const committed = { status: 'committed', snapshotDir: '/snapshot' }

function suspend(layouts = [req.layout]) {
  const lease = suspendMemoryConsolidation(layouts)
  leases.push(lease)
  return lease
}

beforeEach(() => {
  vi.resetAllMocks()
  root = mkdtempSync(join(tmpdir(), 'consolidation-suspend-'))
  const layout = memory.resolveMemoryLayout({ type: 'user', spaceId: 's', spacePath: root }, 'space')
  mkdirSync(join(root, '.halo'))
  writeFileSync(layout.file, '# now\n# History\n')
  req = {
    layout, ownerKind: 'space', ownerName: 'Test', spaceId: 's', tag: 'suspension',
    settings: { autoConsolidate: true, cadence: 'diligent' },
    resolveCredentials: vi.fn(async () => ({}) as never),
  }
  leases = []
  vi.mocked(memory.isConsolidationDue).mockResolvedValue({ due: true, reasons: ['test'] } as never)
  vi.mocked(memory.isArchiveDue).mockResolvedValue({ archiveDue: true, reasons: ['test'] } as never)
  vi.mocked(memory.buildMemorySnapshot).mockResolvedValue(snapshot as never)
  vi.mocked(memory.prepareConsolidation).mockResolvedValue({ dir: '/private-workspace' } as never)
  vi.mocked(memory.discardConsolidation).mockResolvedValue(undefined)
  vi.mocked(memory.validateConsolidation).mockResolvedValue({ ok: true, notes: [] })
  vi.mocked(memory.commitConsolidation).mockResolvedValue(committed as never)
  vi.mocked(memory.assessConsolidation).mockResolvedValue({ overHistory: true } as never)
  vi.mocked(memory.trimHistoryFallback).mockResolvedValue(true)
  vi.mocked(memory.recordFailedAttempt).mockResolvedValue({} as never)
  start.mockResolvedValue(success)
  vi.mocked(createConsolidationAgent).mockImplementation(() => ({ start, followUp }))
})

afterEach(async () => {
  const final = suspend()
  await final.drain()
  for (const lease of leases) lease.release()
  rmSync(root, { force: true, recursive: true })
})

describe('scoped consolidation suspension', () => {
  it('fences synchronous admission, reference-counts overlapping scopes, and resumes after release', async () => {
    const first = suspend([req.layout, req.layout])
    const second = suspend()
    requestConsolidation(req)
    expect(consolidateNow(req)).toEqual({ started: false, reason: 'suspended' })
    await first.drain()
    expect(memory.isConsolidationDue).not.toHaveBeenCalled()
    first.release()
    first.release()
    expect(consolidateNow(req)).toEqual({ started: false, reason: 'suspended' })
    second.release()
    expect(consolidateNow(req)).toEqual({ started: true })
    await vi.waitFor(() => expect(isConsolidating(req.layout)).toBe(false))
    expect(memory.commitConsolidation).toHaveBeenCalledOnce()
  })

  it.each([true, false])('drains a paused due check without launching model or archive work (automatic=%s)', async autoConsolidate => {
    const due = deferred<any>()
    const check = autoConsolidate ? vi.mocked(memory.isConsolidationDue) : vi.mocked(memory.isArchiveDue)
    check.mockReturnValueOnce(due.promise)
    requestConsolidation({ ...req, settings: { ...req.settings, autoConsolidate } })
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce())
    const lease = suspend()
    let drained = false
    const drain = lease.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    due.resolve({ due: true, archiveDue: true, reasons: ['test'] })
    await drain
    expect(start).not.toHaveBeenCalled()
    expect(memory.trimHistoryFallback).not.toHaveBeenCalled()
    expect(memory.recordFailedAttempt).not.toHaveBeenCalled()
  })

  it('cancels both an automatic check and the manual run that overtook it', async () => {
    const due = deferred<any>()
    const credentials = deferred<any>()
    vi.mocked(memory.isConsolidationDue).mockReturnValueOnce(due.promise)
    req.resolveCredentials = () => credentials.promise
    requestConsolidation(req)
    await vi.waitFor(() => expect(memory.isConsolidationDue).toHaveBeenCalledOnce())
    consolidateNow(req)
    await vi.waitFor(() => expect(memory.buildMemorySnapshot).toHaveBeenCalledOnce())
    const lease = suspend()
    due.resolve({ due: true, reasons: ['test'] })
    credentials.resolve({})
    await lease.drain()
    expect(memory.prepareConsolidation).not.toHaveBeenCalled()
    expect(memory.trimHistoryFallback).not.toHaveBeenCalled()
    expect(isConsolidating(req.layout)).toBe(false)
  })

  it('does not treat a credential rejection after cancellation as model failure', async () => {
    const credentials = deferred<any>()
    req.resolveCredentials = vi.fn(() => credentials.promise)
    consolidateNow(req)
    await vi.waitFor(() => expect(req.resolveCredentials).toHaveBeenCalledOnce())
    const lease = suspend()
    credentials.reject(new Error('credentials unavailable'))
    await lease.drain()
    expect(memory.assessConsolidation).not.toHaveBeenCalled()
    expect(memory.recordFailedAttempt).not.toHaveBeenCalled()
  })

  it('awaits prepare and cleanup without starting a query on the old layout', async () => {
    const prepared = deferred<any>()
    const cleanup = deferred<void>()
    vi.mocked(memory.prepareConsolidation).mockReturnValueOnce(prepared.promise)
    vi.mocked(memory.discardConsolidation).mockReturnValueOnce(cleanup.promise)
    consolidateNow(req)
    await vi.waitFor(() => expect(memory.prepareConsolidation).toHaveBeenCalledOnce())
    const lease = suspend()
    prepared.resolve({ dir: '/private-workspace' })
    await vi.waitFor(() => expect(memory.discardConsolidation).toHaveBeenCalledOnce())
    let drained = false
    const drain = lease.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    cleanup.resolve()
    await drain
    expect(start).not.toHaveBeenCalled()
  })

  it('aborts a running query and awaits its shutdown before cleanup, without fallback or commit', async () => {
    const stopped = deferred<any>()
    start.mockReturnValueOnce(stopped.promise)
    consolidateNow(req)
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    const signal = vi.mocked(createConsolidationAgent).mock.calls[0][0].signal!
    const lease = suspend()
    expect(signal.aborted).toBe(true)
    expect(memory.discardConsolidation).not.toHaveBeenCalled()
    stopped.resolve({ ok: false, reason: 'aborted' })
    await lease.drain()
    expect(memory.discardConsolidation).toHaveBeenCalledOnce()
    expect(memory.commitConsolidation).not.toHaveBeenCalled()
    expect(memory.trimHistoryFallback).not.toHaveBeenCalled()
    expect(memory.recordFailedAttempt).not.toHaveBeenCalled()
  })

  it('awaits a commit already in its critical section and its bookkeeping and cleanup', async () => {
    const commit = deferred<any>()
    const record = deferred<void>()
    vi.mocked(memory.commitConsolidation).mockReturnValueOnce(commit.promise)
    vi.mocked(memory.recordCommit).mockReturnValueOnce(record.promise)
    consolidateNow(req)
    await vi.waitFor(() => expect(memory.commitConsolidation).toHaveBeenCalledOnce())
    const lease = suspend()
    let drained = false
    const drain = lease.drain().then(() => { drained = true })
    commit.resolve(committed)
    await vi.waitFor(() => expect(memory.recordCommit).toHaveBeenCalledOnce())
    expect(drained).toBe(false)
    record.resolve()
    await drain
    expect(memory.discardConsolidation).toHaveBeenCalledOnce()
    expect(memory.recordFailedAttempt).not.toHaveBeenCalled()
  })

  it('does not commit or start feedback after a validation awaited during suspension', async () => {
    const validation = deferred<any>()
    vi.mocked(memory.validateConsolidation).mockReturnValueOnce(validation.promise)
    consolidateNow(req)
    await vi.waitFor(() => expect(memory.validateConsolidation).toHaveBeenCalledOnce())
    const lease = suspend()
    validation.resolve({ ok: false, reason: 'missing History' })
    await lease.drain()
    expect(followUp).not.toHaveBeenCalled()
    expect(memory.commitConsolidation).not.toHaveBeenCalled()
    expect(memory.recordFailedAttempt).not.toHaveBeenCalled()
  })

  it.each(['conflict', 'rejected'])('does not retry or fall back after an in-flight commit returns %s during suspension', async status => {
    const commit = deferred<any>()
    vi.mocked(memory.commitConsolidation).mockReturnValueOnce(commit.promise)
    consolidateNow(req)
    await vi.waitFor(() => expect(memory.commitConsolidation).toHaveBeenCalledOnce())
    const lease = suspend()
    if (status === 'conflict') commit.resolve({ status: 'conflict', reason: 'changed' })
    else commit.reject(new Error('disk unavailable'))
    await lease.drain()
    expect(followUp).not.toHaveBeenCalled()
    expect(memory.trimHistoryFallback).not.toHaveBeenCalled()
    expect(memory.recordFailedAttempt).not.toHaveBeenCalled()
    expect(memory.discardConsolidation).toHaveBeenCalledOnce()
  })

  it('prevents fallback trim when suspension arrives during fallback assessment', async () => {
    const assessment = deferred<any>()
    start.mockResolvedValueOnce({ ok: false, reason: 'model down' })
    vi.mocked(memory.assessConsolidation).mockReturnValueOnce(assessment.promise)
    consolidateNow(req)
    await vi.waitFor(() => expect(memory.assessConsolidation).toHaveBeenCalledOnce())
    const lease = suspend()
    assessment.resolve({ overHistory: true })
    await lease.drain()
    expect(memory.trimHistoryFallback).not.toHaveBeenCalled()
    expect(memory.recordFailedAttempt).not.toHaveBeenCalled()
  })

  it.each([true, false])('awaits an existing trim but does not record cancellation as failure (automatic=%s)', async autoConsolidate => {
    const trim = deferred<boolean>()
    vi.mocked(memory.trimHistoryFallback).mockReturnValueOnce(trim.promise)
    start.mockResolvedValueOnce({ ok: false, reason: 'model down' })
    requestConsolidation({ ...req, settings: { ...req.settings, autoConsolidate } })
    await vi.waitFor(() => expect(memory.trimHistoryFallback).toHaveBeenCalledOnce())
    const lease = suspend()
    let drained = false
    const drain = lease.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    trim.resolve(true)
    await drain
    expect(memory.recordFailedAttempt).not.toHaveBeenCalled()
    expect(memory.recordArchive).not.toHaveBeenCalled()
  })

  it('does not suspend unrelated memory layouts', async () => {
    const other = memory.resolveMemoryLayout({ type: 'user', spaceId: 'other', spacePath: join(root, 'other') }, 'space')
    mkdirSync(join(root, 'other', '.halo'), { recursive: true })
    writeFileSync(other.file, '# now\n# History\n')
    suspend()
    expect(consolidateNow({ ...req, layout: other })).toEqual({ started: true })
    await vi.waitFor(() => expect(isConsolidating(other)).toBe(false))
    expect(memory.commitConsolidation).toHaveBeenCalledOnce()
  })
})
