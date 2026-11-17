import { describe, expect, it, vi } from 'vitest'
import type { ExecutionEnvironment } from '../../../../src/shared/apps/app-types'
import { WORKSPACE_NOTICE_TEXT } from '../../../../src/shared/transcript'
import { prepareWorkspaceNotice } from '../../../../src/main/apps/runtime/workspace-notice'

function environment(): ExecutionEnvironment {
  return { spaceId: 'current', spacePath: '/current', workDir: '/current', memoryDir: '/current/person', pendingWorkspaceNotice: { kind: 'deleted' } }
}

describe('workspace notice checkpoints', () => {
  it('does nothing on ordinary turns', () => {
    const env = environment()
    delete env.pendingWorkspaceNotice
    const record = vi.fn()
    const save = vi.fn()
    const notice = prepareWorkspaceNotice(env, record, save)
    expect(notice.context).toBe('')
    notice.delivered()
    expect(record).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('records once across failed preparation and restart, retaining model context until accepted', () => {
    const env = environment()
    const record = vi.fn(() => true)
    const save = vi.fn()
    const failed = prepareWorkspaceNotice(env, record, save)
    expect(record).toHaveBeenCalledWith(WORKSPACE_NOTICE_TEXT.deleted)
    expect(failed.context).toContain('[Workspace changed]')
    expect(env.pendingWorkspaceNotice).toEqual({ kind: 'deleted', recorded: true })

    const restarted = JSON.parse(JSON.stringify(env)) as ExecutionEnvironment
    const retry = prepareWorkspaceNotice(restarted, record, save)
    expect(record).toHaveBeenCalledTimes(1)
    expect(retry.context).toBe(failed.context)
    retry.delivered()
    retry.delivered()
    expect(restarted.pendingWorkspaceNotice).toBeUndefined()
    expect(save).toHaveBeenCalledTimes(2)
    expect(prepareWorkspaceNotice(restarted, record, save).context).toBe('')
  })

  it('keeps the pending record when the transcript write fails, even after model acceptance', () => {
    const env = environment()
    const record = vi.fn(() => false)
    const save = vi.fn()
    prepareWorkspaceNotice(env, record, save).delivered()
    expect(env.pendingWorkspaceNotice).toEqual({ kind: 'deleted' })
    expect(save).not.toHaveBeenCalled()
    record.mockReturnValue(true)
    const retry = prepareWorkspaceNotice(env, record, save)
    retry.delivered()
    expect(record).toHaveBeenCalledTimes(2)
    expect(env.pendingWorkspaceNotice).toBeUndefined()
  })

  it('leaves a notice available after a command does not deliver model context', () => {
    const env = environment()
    const record = vi.fn(() => true)
    const save = vi.fn()
    prepareWorkspaceNotice(env, record, save)
    const nextTurn = prepareWorkspaceNotice(env, record, save)
    expect(nextTurn.context).toContain('[Workspace changed]')
    expect(record).toHaveBeenCalledTimes(1)
    nextTurn.delivered()
    expect(env.pendingWorkspaceNotice).toBeUndefined()
  })

  it('does not consume a newer workspace change through an older acceptance callback', () => {
    const env = environment()
    const prepared = prepareWorkspaceNotice(env, () => true, vi.fn())
    env.pendingWorkspaceNotice = { kind: 'missing' }
    prepared.delivered()
    expect(env.pendingWorkspaceNotice).toEqual({ kind: 'missing' })
  })

  it('restores the pending context if saving acceptance fails', () => {
    const env = environment()
    const save = vi.fn()
    const prepared = prepareWorkspaceNotice(env, () => true, save)
    save.mockImplementationOnce(() => { throw new Error('database unavailable') })
    expect(() => prepared.delivered()).toThrow('database unavailable')
    expect(env.pendingWorkspaceNotice).toEqual({ kind: 'deleted', recorded: true })
  })

  it('does not equate an unavailable old location with permanently deleted data', () => {
    const env = environment()
    env.pendingWorkspaceNotice = { kind: 'missing' }
    const prepared = prepareWorkspaceNotice(env, () => true, vi.fn())
    expect(prepared.context).toContain('may be unavailable')
    expect(prepared.context).toContain('do not assume they were deleted')
  })
})
