/**
 * email_send asks its caller before attaching a local file, so a restricted
 * turn can keep the workspace's internal data from leaving by email.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (_name: string, _description: string, _schema: unknown, handler: unknown) => ({ handler }),
}))

import { createEmailSendTool } from '../../../../src/main/services/email-mcp/tools/email-send'

type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

describe('email_send attachments', () => {
  const base = { to: 'a@example.com', subject: 's', body: 'b', is_html: false }

  it('refuses the whole send when any attachment is refused', async () => {
    const send = vi.fn()
    const { handler } = createEmailSendTool({ send } as never, p => (p.includes('/.halo/') ? 'Closed here.' : null)) as unknown as { handler: Handler }
    const result = await handler({ ...base, attachments: ['/ws/report.pdf', '/ws/.halo/apps/dh/runs/chat-alice.jsonl'] })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Closed here.')
    expect(send).not.toHaveBeenCalled()
  })

  it('sends as before when nothing is refused, or nobody asks', async () => {
    const send = vi.fn(async () => ({ messageId: 'm', sentTo: ['a@example.com'], sentAt: 'now' }))
    for (const refuse of [() => null, undefined]) {
      const { handler } = createEmailSendTool({ send } as never, refuse) as unknown as { handler: Handler }
      const result = await handler({ ...base, attachments: ['/ws/report.pdf'] })
      expect(result.isError).toBeFalsy()
    }
    expect(send).toHaveBeenCalledTimes(2)
  })
})
