/**
 * The reminder tools a digital human has in a conversation are bound to it:
 * what is set comes back there, attributed to whoever the calling turn answers
 * to at that moment, and only that conversation's reminders can be listed or
 * cancelled from it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

const service = vi.hoisted(() => ({ set: vi.fn(), listForConversation: vi.fn(), cancel: vi.fn() }))

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, _schema: unknown, handler: Handler) => ({ name, description, handler }),
  createSdkMcpServer: (options: unknown) => options,
}))
vi.mock('../../../../src/main/apps/runtime/reminders', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../src/main/apps/runtime/reminders')>()),
  getConversationReminders: () => service,
}))

const { createRemindersMcpServer } = await import('../../../../src/main/apps/runtime/reminders/tool')
const { ReminderError } = await import('../../../../src/main/apps/runtime/reminders')

const NOW = new Date(2026, 9, 6, 10, 30).getTime()
const CONVERSATION = 'app-chat:app-1:wecom-bot:group:g-1'
let setter: { id: string; name: string } | undefined

function tools() {
  const server = createRemindersMcpServer({ appId: 'app-1', conversationId: CONVERSATION, currentSetter: () => setter }) as unknown as {
    name: string
    tools: Array<{ name: string; description: string; handler: Handler }>
  }
  const byName = (name: string) => server.tools.find(t => t.name === name)!
  return { server, set: byName('set_reminder'), list: byName('list_reminders'), cancel: byName('cancel_reminder') }
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  service.set.mockReset()
  service.listForConversation.mockReset()
  service.cancel.mockReset()
  setter = undefined
  return () => vi.useRealTimers()
})

describe('reminder tools', () => {
  it('are one server, named so the guest filter keeps it from IM guests', () => {
    expect(tools().server.name).toBe('halo-reminders')
  })

  it('set a reminder for this conversation, from whoever the calling turn answers to now, and say when it is due', async () => {
    const { set } = tools()
    service.set.mockImplementation(input => ({ ...input, id: 'r-1', schedule: { kind: 'once', at: NOW + 3_600_000 }, nextAt: NOW + 3_600_000, createdAt: NOW }))
    setter = { id: 'u-2', name: 'Wang' }

    const result = await set.handler({ message: 'Hour is up.', after_minutes: 60 })

    expect(service.set).toHaveBeenCalledWith({
      appId: 'app-1', conversationId: CONVERSATION, message: 'Hour is up.',
      when: { afterMinutes: 60, at: undefined, every: undefined, cron: undefined },
      setBy: { id: 'u-2', name: 'Wang' },
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe('Reminder set (id r-1): once at 2026-10-06 11:30, first due 2026-10-06 11:30 local time (now 2026-10-06 10:30).')
  })

  it('hand a refusal back to the model as something it can correct', async () => {
    service.set.mockImplementation(() => { throw new ReminderError('A repeating reminder must be at least 5 minutes apart.') })

    const result = await tools().set.handler({ message: 'ping', every: '1m' })

    expect(result).toEqual({ content: [{ type: 'text', text: 'A repeating reminder must be at least 5 minutes apart.' }], isError: true })
  })

  it('list and cancel only this conversation’s reminders', async () => {
    const { list, cancel } = tools()
    service.listForConversation.mockReturnValue([
      { id: 'r-1', message: 'Water', schedule: { kind: 'every', every: '2h' }, nextAt: NOW + 7_200_000 },
    ])
    service.cancel.mockReturnValueOnce(true).mockReturnValueOnce(false)

    expect((await list.handler({})).content[0].text).toBe('Now: 2026-10-06 10:30 local time.\n- r-1: every 2h (next 2026-10-06 12:30) — Water')
    expect(service.listForConversation).toHaveBeenCalledWith('app-1', CONVERSATION)
    expect((await cancel.handler({ id: ' r-1 ' })).content[0].text).toBe('Reminder cancelled.')
    expect(service.cancel).toHaveBeenCalledWith('app-1', 'r-1', CONVERSATION)
    expect((await cancel.handler({ id: 'r-9' })).isError).toBe(true)
  })

  it('steer a one-off request away from creating a digital human', () => {
    expect(tools().set.description).toContain('Never create a digital human for a reminder')
  })
})
