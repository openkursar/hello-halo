import { describe, it, expect, vi } from 'vitest'

const env = vi.hoisted(() => ({ teamChatMessages: vi.fn() }))
vi.mock('../../../src/renderer/api', () => ({ api: { teamChatMessages: env.teamChatMessages } }))

const { loadTeamSessionHistory, retainTeamSessionHistory } = await import('../../../src/renderer/components/team/session-history')

const row = (seq: number, content = `m${seq}`) => ({ id: `id-${seq}`, seq, role: 'assistant', content })

describe('member transcript reads the tail once rows carry seq', () => {
  it('a local transcript is fetched whole once, then only from the last known row', async () => {
    const release = retainTeamSessionHistory('app', 'space', 'team', 'epoch')
    env.teamChatMessages.mockResolvedValueOnce({ success: true, data: [row(1), row(2), row(3)] })
    const first = await loadTeamSessionHistory('app', 'space', 'team', 'epoch')
    expect(env.teamChatMessages).toHaveBeenLastCalledWith('app', 'space', 'team', 'epoch', undefined)
    expect((first.data as unknown[]).length).toBe(3)

    // The last row changed (a provisional reply finished) and one row arrived.
    env.teamChatMessages.mockResolvedValueOnce({ success: true, data: [row(3, 'm3 final'), row(4)] })
    const second = await loadTeamSessionHistory('app', 'space', 'team', 'epoch')
    expect(env.teamChatMessages).toHaveBeenLastCalledWith('app', 'space', 'team', 'epoch', 2)
    const contents = (second.data as Array<{ content: string }>).map((m) => m.content)
    expect(contents).toEqual(['m1', 'm2', 'm3 final', 'm4'])
    release()
  })

  it('a reply followed by messages that arrived during its turn is re-read when it finishes', async () => {
    const release = retainTeamSessionHistory('app', 'space', 'team', 'arrivals')
    const input = (seq: number) => ({ id: `id-${seq}`, seq, role: 'system', content: `input ${seq}` })
    env.teamChatMessages.mockResolvedValueOnce({ success: true, data: [input(1), row(2, ''), input(3), input(4)] })
    await loadTeamSessionHistory('app', 'space', 'team', 'arrivals')

    env.teamChatMessages.mockResolvedValueOnce({ success: true, data: [row(2, 'final'), input(3), input(4)] })
    const second = await loadTeamSessionHistory('app', 'space', 'team', 'arrivals')
    expect(env.teamChatMessages).toHaveBeenLastCalledWith('app', 'space', 'team', 'arrivals', 1)
    expect((second.data as Array<{ content: string }>).map((m) => m.content)).toEqual(['input 1', 'final', 'input 3', 'input 4'])
    release()
  })
})
