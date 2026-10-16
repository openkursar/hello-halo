import { beforeEach, describe, expect, it, vi } from 'vitest'

const { inject } = vi.hoisted(() => ({ inject: vi.fn() }))
vi.mock('../../../src/renderer/api', () => ({ api: { appChatInject: inject } }))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (text: string) => text } }))

import { injectTeamSessionMessage } from '../../../src/renderer/components/team/session-input'

const input = { appId: 'member', conversationId: 'app-chat:member:team:team:epoch', message: 'Please use the new evidence' }

beforeEach(() => inject.mockReset())

describe('local team session supplements', () => {
  it('uses app-chat live delivery for a team key without the unsupported virtual backend', async () => {
    inject.mockResolvedValue({ success: true, data: { delivered: true } })
    const fallback = vi.fn(async () => true)
    const references = [{ id: 'ref', content: 'evidence' }] as never
    expect(await injectTeamSessionMessage({ ...input, references }, fallback)).toBe(true)
    expect(inject).toHaveBeenCalledWith({ ...input, references })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('uses the normal owner-send path when the current turn cannot accept the input', async () => {
    inject.mockResolvedValue({ success: true, data: { delivered: false } })
    const fallback = vi.fn(async () => true)
    expect(await injectTeamSessionMessage(input, fallback)).toBe(true)
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('returns the draft when the owner stopped without restarting the work', async () => {
    inject.mockResolvedValue({ success: true, data: { delivered: false, stopped: true } })
    const fallback = vi.fn(async () => true)
    expect(await injectTeamSessionMessage(input, fallback)).toBe(false)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('keeps an authority refusal visible instead of falling back to a new privileged turn', async () => {
    inject.mockResolvedValue({ success: false, error: 'The target is not locally owned' })
    const fallback = vi.fn(async () => true)
    await expect(injectTeamSessionMessage(input, fallback)).rejects.toThrow('not locally owned')
    expect(fallback).not.toHaveBeenCalled()
  })
})
