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
})
