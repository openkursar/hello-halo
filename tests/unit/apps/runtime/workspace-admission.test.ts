import { describe, expect, it, vi } from 'vitest'
import { beginWorkspaceRecovery, acquireAppWorkspaceChange, awaitWorkspaceDrain, onWorkspaceChangeReleased, pendingWorkspaceChange, pendingWorkspaceRecovery, pendingWorkspaceInitialization, setWorkspaceInitialization, setWorkspaceRecovery, withWorkspaceChange } from '../../../../src/main/apps/runtime/workspace-admission'

function deferred() {
  let resolve!: () => void
  const done = new Promise<void>(settle => { resolve = settle })
  return { done, resolve }
}

describe('full workspace service initialization', () => {
  it('remains separate from data readiness and clears only its owned initialization', async () => {
    const first = deferred()
    const second = deferred()
    const clearFirst = setWorkspaceInitialization(first.done)
    const data = beginWorkspaceRecovery()
    data.complete()
    await data.ready
    expect(pendingWorkspaceRecovery()).toBeUndefined()
    expect(pendingWorkspaceInitialization()).toBe(first.done)
    const clearSecond = setWorkspaceInitialization(second.done)
    clearFirst()
    expect(pendingWorkspaceInitialization()).toBe(second.done)
    clearSecond()
    expect(pendingWorkspaceInitialization()).toBeUndefined()
    first.resolve()
    second.resolve()
  })
})

describe('startup workspace data recovery', () => {
  it('releases data readiness before later startup work completes and ignores later startup failure', async () => {
    const gate = beginWorkspaceRecovery()
    expect(pendingWorkspaceRecovery()).toBe(gate.ready)
    gate.complete()
    expect(pendingWorkspaceRecovery()).toBeUndefined()
    await gate.ready
    gate.fail(new Error('Later team initialization failed'))
    expect(pendingWorkspaceRecovery()).toBeUndefined()
  })

  it('keeps failed repair closed until a replacement repair succeeds', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = beginWorkspaceRecovery()
    const rejected = expect(failed.ready).rejects.toThrow('repair failed')
    failed.fail(new Error('repair failed'))
    await rejected
    expect(pendingWorkspaceRecovery()).toBe(failed.ready)
    const replacement = beginWorkspaceRecovery()
    failed.complete()
    expect(pendingWorkspaceRecovery()).toBe(replacement.ready)
    replacement.complete()
    await replacement.ready
    expect(pendingWorkspaceRecovery()).toBeUndefined()
    expect(log).toHaveBeenCalledOnce()
    log.mockRestore()
  })

  it('clears only its own repair promise without affecting a newer recovery', () => {
    const first = deferred()
    const second = deferred()
    const clearFirst = setWorkspaceRecovery(first.done)
    expect(pendingWorkspaceRecovery()).toBe(first.done)
    const clearSecond = setWorkspaceRecovery(second.done)
    clearFirst()
    expect(pendingWorkspaceRecovery()).toBe(second.done)
    clearSecond()
    expect(pendingWorkspaceRecovery()).toBeUndefined()
    first.resolve()
    second.resolve()
  })
})

describe('scoped workspace admission', () => {
  it('holds only the affected apps until commit or rollback and releases once', async () => {
    const observed = vi.fn()
    const unsubscribe = onWorkspaceChangeReleased(observed)
    const release = await acquireAppWorkspaceChange(['one', 'two', 'one'])
    const first = pendingWorkspaceChange('one')
    expect(first).toBeDefined()
    expect(pendingWorkspaceChange('two')).toBe(first)
    expect(pendingWorkspaceChange('other')).toBeUndefined()
    release()
    release()
    await first
    expect(pendingWorkspaceChange('one')).toBeUndefined()
    expect(observed.mock.calls).toEqual([['one'], ['two']])
    unsubscribe()
  })

  it('takes overlapping app sets atomically without holding a free app while waiting', async () => {
    const release = await acquireAppWorkspaceChange(['one'])
    let acquired = false
    const next = acquireAppWorkspaceChange(['one', 'two']).then(unlock => { acquired = true; return unlock })
    await Promise.resolve()
    expect(acquired).toBe(false)
    expect(pendingWorkspaceChange('two')).toBeUndefined()
    release()
    const unlock = await next
    expect(pendingWorkspaceChange('one')).toBe(pendingWorkspaceChange('two'))
    unlock()
  })

  it('releases admission after rollback throws', async () => {
    const failed = withWorkspaceChange('failed', async () => { throw new Error('rollback complete') })
    await expect(failed).rejects.toThrow('rollback complete')
    expect(pendingWorkspaceChange('failed')).toBeUndefined()
  })

  it('does not mistake a drain deadline for successful quiescence', async () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pending = deferred()
    const drained = awaitWorkspaceDrain('slow', 'runs', pending.done, 100)
    const failed = expect(drained).rejects.toThrow('workspace was not moved')
    await vi.advanceTimersByTimeAsync(100)
    await failed
    expect(error).toHaveBeenCalledOnce()
    pending.resolve()
    error.mockRestore()
    vi.useRealTimers()
  })
})
