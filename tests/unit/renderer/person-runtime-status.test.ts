import { describe, expect, it } from 'vitest'
import { describePersonStatus, personRuntimeStatus } from '../../../src/renderer/utils/automation-status'

const t = (text: string) => text

describe('a person’s live status', () => {
  it('reads a team turn as working while it otherwise stands by', () => {
    expect(personRuntimeStatus({ status: 'idle', teamWorking: true })).toBe('running')
    expect(personRuntimeStatus({ status: 'paused', teamWorking: true })).toBe('running')
    expect(personRuntimeStatus({ status: 'idle' })).toBe('idle')
    expect(personRuntimeStatus(undefined)).toBeUndefined()
  })

  it('keeps stronger states than a team turn', () => {
    expect(personRuntimeStatus({ status: 'waiting_user', teamWorking: true })).toBe('waiting_user')
    expect(personRuntimeStatus({ status: 'queued', teamWorking: true })).toBe('queued')
  })

  it('labels a team member at work as Working in the switcher and directory', () => {
    const state = { status: 'idle' as const, automaticEnabled: true, pendingDecisionCount: 0, teamWorking: true }
    expect(describePersonStatus('active', state, t)).toMatchObject({ effective: 'running', label: 'Working' })
    expect(describePersonStatus('paused', { ...state, status: 'paused', automaticEnabled: false }, t))
      .toMatchObject({ effective: 'running', label: 'Working' })
  })
})
