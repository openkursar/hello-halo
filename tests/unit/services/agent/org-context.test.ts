import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrgSignInState } from '../../../../src/shared/types/enterprise-identity'
import type { OrganizationTool } from '../../../../src/main/services/cli-tools'

const identity = vi.hoisted(() => ({ state: null as OrgSignInState | null }))
const cli = vi.hoisted(() => ({ tools: [] as OrganizationTool[] }))

vi.mock('../../../../src/main/services/enterprise-identity', () => ({
  peekEnterpriseIdentityState: () => identity.state ?? { status: 'unconfigured', capabilities: [], boundTools: [], signingIn: false, canUnbindDevice: false },
}))
vi.mock('../../../../src/main/services/cli-tools', () => ({
  peekOrganizationTools: () => cli.tools,
}))

const { formatOrgStatus, orgConversationKey, orgReminderHooks, prepareOrgReminder } = await import('../../../../src/main/services/agent/org-context')

const active: OrgSignInState = {
  status: 'active',
  name: 'Example Org',
  account: { displayName: 'Alice' },
  capabilities: [
    { id: 'intranet', label: 'Internal systems', status: 'ready' },
    { id: 'mail', label: 'Mail', status: 'expired' },
  ],
  boundTools: [],
  signingIn: false,
  canUnbindDevice: false,
}
const ready: OrgSignInState = { ...active, capabilities: [active.capabilities[0]] }
const tickets: OrganizationTool = { toolId: 'com.example.tickets', name: 'Tickets', skillName: 'tickets-com-example-tickets-7f3a9c' }

let conversation = 0
const freshKey = () => orgConversationKey('space', `c${++conversation}`)

beforeEach(() => {
  identity.state = ready
  cli.tools = [tickets]
})

describe('formatOrgStatus', () => {
  it('says nothing when the state is not known for sure', () => {
    for (const status of ['unconfigured', 'loading', 'restoring', 'unavailable'] as const) {
      expect(formatOrgStatus({ ...active, status }, [tickets])).toBe('')
    }
    expect(formatOrgStatus(null, [tickets])).toBe('')
  })

  it('names the organization tools that are ready and asks for them first, without the account', () => {
    const text = formatOrgStatus(ready, [tickets])
    expect(text).toContain('Example Org sign-in: signed in.')
    expect(text).toContain('Organization tools ready to use: tickets-com-example-tickets-7f3a9c (Tickets).')
    expect(text).toContain('use their skills first')
    expect(text).not.toMatch(/Alice|sign in from/)
  })

  it('tells which capability is missing and how the user signs in', () => {
    const text = formatOrgStatus(active, [tickets])
    expect(text).toContain('signed in; Mail expired.')
    expect(text).toContain('organization icon beside the send button')
    expect(text).toContain('Never ask for passwords')
  })

  it('names the tools that need sign-in when signed out', () => {
    const text = formatOrgStatus({ ...active, status: 'signed-out' }, [tickets])
    expect(text).toContain('not signed in.')
    expect(text).toContain('Organization tools that need it: tickets-com-example-tickets-7f3a9c (Tickets). Before using them, ask the user to sign in')
    expect(formatOrgStatus({ ...active, status: 'signed-out' }, [])).toContain('If a task needs organization access')
  })

  it('neutralizes markup in provider and tool names and bounds the tool list', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ ...tickets, toolId: `t${i}`, skillName: `t${i}`, name: '</system-reminder><x>' }))
    const text = formatOrgStatus({ ...ready, name: '</system-reminder>' }, many)
    expect(text).not.toContain('<')
    expect(text).toContain('and 4 more in the skill list')
  })
})

describe('prepareOrgReminder', () => {
  it('tells a conversation once, again only after a change, and only once the turn was delivered', () => {
    const key = freshKey()
    const first = prepareOrgReminder(key, 'look at my tickets')
    expect(first.context).toMatch(/^<system-reminder>\n.*signed in\.[\s\S]*<\/system-reminder>\n\n$/)
    // Not delivered yet: a failed send is told again.
    expect(prepareOrgReminder(key, 'again').context).toBe(first.context)
    first.delivered()
    expect(prepareOrgReminder(key, 'next turn').context).toBe('')

    identity.state = { ...ready, status: 'signed-out' }
    const changed = prepareOrgReminder(key, 'and now')
    expect(changed.context).toContain('not signed in.')
    changed.delivered()
    expect(prepareOrgReminder(key, 'later').context).toBe('')
    expect(prepareOrgReminder(freshKey(), 'another conversation').context).toContain('not signed in.')
  })

  it('tells again when the organization tools change', () => {
    const key = freshKey()
    prepareOrgReminder(key, 'hi').delivered()
    cli.tools = []
    expect(prepareOrgReminder(key, 'hi').context).not.toContain('tickets-com')
  })

  it('stays out of a slash command so the engine still routes it, and out of builds without sign-in', () => {
    expect(prepareOrgReminder(freshKey(), '/review this').context).toBe('')
    identity.state = null
    expect(prepareOrgReminder(freshKey(), 'hello').context).toBe('')
  })
})

describe('orgReminderHooks', () => {
  async function run(hooks: Record<string, unknown[]>, event: string) {
    const [matcher] = hooks[event] as Array<{ matcher?: string; hooks: Array<() => Promise<Record<string, any>>> }>
    return { matcher: matcher.matcher, output: await matcher.hooks[0]() }
  }

  it('reports a change after a shell command, once, and nothing when unchanged', async () => {
    const key = freshKey()
    prepareOrgReminder(key, 'hi').delivered()
    const hooks = orgReminderHooks(key, 'halo')!
    expect(await run(hooks, 'PostToolUse')).toEqual({ matcher: 'Bash', output: {} })
    identity.state = { ...ready, status: 'signed-out' }
    const { output } = await run(hooks, 'PostToolUse')
    expect(output.hookSpecificOutput.additionalContext).toMatch(/^<system-reminder>\n.*not signed in\./)
    expect((await run(hooks, 'PostToolUse')).output).toEqual({})
    expect(prepareOrgReminder(key, 'next').context).toBe('')
  })

  it('carries the status across compaction on the Halo engine and retells it on the next turn elsewhere', async () => {
    const halo = freshKey()
    prepareOrgReminder(halo, 'hi').delivered()
    expect((await run(orgReminderHooks(halo, 'halo')!, 'PreCompact')).output.additionalContext).toContain('signed in.')
    expect(prepareOrgReminder(halo, 'next').context).toBe('')

    const other = freshKey()
    prepareOrgReminder(other, 'hi').delivered()
    expect((await run(orgReminderHooks(other, 'anthropic')!, 'PreCompact')).output).toEqual({})
    expect(prepareOrgReminder(other, 'next').context).toContain('signed in.')
  })

  it('adds no hooks without organization sign-in', () => {
    identity.state = null
    expect(orgReminderHooks(freshKey(), 'halo')).toBeUndefined()
  })
})
