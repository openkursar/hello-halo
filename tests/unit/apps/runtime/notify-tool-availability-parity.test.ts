/**
 * Parity guard: resolveNotifyAvailability() vs createNotifyToolServer()
 *
 * notify-tool.ts's own header names the exact failure mode this guards
 * against: "The MCP injection (notify-tool.ts), the automation prompt
 * (prompt.ts), the interactive-chat prompt (app-chat.ts), and the IM entry
 * (im-channels/im-prompt.ts) must all agree on these facts [...] or drift."
 * A drift means the AI is told (via the system prompt's notifyToolsAvailable
 * guidance) that it can notify, then calls a tool the MCP server never
 * registered — the exact "no such MCP" failure this project has hit before.
 *
 * This test does not re-verify resolveNotifyAvailability's own logic (see
 * notify-availability.test.ts) or notify-tool.ts's send behavior. It only
 * asserts the two independently-implemented conditions agree, across the
 * input combinations execute.ts/app-chat.ts actually feed them:
 * resolveNotifyAvailability's `channelsConfigured`/`notifyBotAvailable`
 * against createNotifyToolServer's real, unmocked tool registration.
 */

import { describe, it, expect, vi } from 'vitest'

// getEnabledChannels lives in a module that transitively pulls electron/proxy
// deps; stub it with the same "which channels are enabled" logic it really
// has (mirrors notify-availability.test.ts's own precedent for this stub).
vi.mock('../../../../src/main/services/notify-channels', () => ({
  getEnabledChannels: (c: Record<string, { enabled?: boolean }> | undefined) => {
    if (!c) return []
    return ['email', 'wecom', 'dingtalk', 'feishu', 'webhook'].filter((k) => c[k]?.enabled)
  },
}))

// vi.hoisted: vi.mock factories run before module-scope `let`s are
// initialized, so the mutable holder itself must be created inside a hoisted
// block for the factory to safely close over it.
const configHolder = vi.hoisted(() => ({
  channels: undefined as Record<string, { enabled?: boolean }> | undefined,
}))
vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn(() => ({ notificationChannels: configHolder.channels })),
  // No-ops: satisfy the logging subsystem's module-load-time subscription
  // (foundation/logging/index.ts calls onAgentConfigChange at import time).
  onNetworkConfigChange: vi.fn(),
  onAgentConfigChange: vi.fn(),
}))

// resolved-sdk.ts requires initSdk() to have run before tool()/
// createSdkMcpServer() work, which no test bootstraps — mock resolved-sdk
// directly instead (mirrors runtime.test.ts's identical mock for the same
// reason, proven there for createReportToolServer).
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  createSession: vi.fn(),
  tool: vi.fn((name: string, description: string, schema: any, handler: any) => ({
    name,
    description,
    schema,
    handler,
    _isTool: true,
  })),
  createSdkMcpServer: vi.fn((opts: any) => ({
    name: opts.name,
    version: opts.version,
    tools: opts.tools,
    _isMcpServer: true,
  })),
}))

import { resolveNotifyAvailability } from '../../../../src/main/apps/runtime/notify-availability'
import { createNotifyToolServer } from '../../../../src/main/apps/runtime/notify-tool'
import type { NotificationChannelsConfig } from '../../../../src/shared/types/notification-channels'

type App = Parameters<typeof resolveNotifyAvailability>[0]

function makeApp(denied: string[] = []): App {
  return { permissions: { granted: [], denied }, spec: {} } as unknown as App
}

function sessions(n: number) {
  return Array.from({ length: n }, (_, i) => ({ appId: 'a', channel: 'wecom-bot', source: 'im', instanceId: `inst-${i}`, chatId: `chat-${i}` })) as any
}

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    appId: 'app-1',
    appName: 'Test App',
    runId: 'run-1',
    usesImPush: false,
    exportGate: {} as any,
    relay: { sessionKey: 'run-1' },
    ...overrides,
  }
}

describe('notify tool availability parity (resolveNotifyAvailability vs createNotifyToolServer)', () => {
  it('agrees: nothing configured -> availability says false, server has zero tools', () => {
    configHolder.channels = undefined
    const availability = resolveNotifyAvailability(makeApp(), configHolder.channels, [])
    const server = createNotifyToolServer(baseContext({ usesImPush: false, imSessions: [] }))

    expect(availability.channelsConfigured).toBe(false)
    expect(availability.notifyBotAvailable).toBe(false)
    expect((server as any).tools).toHaveLength(0)
  })

  it('agrees: an enabled channel -> availability says true, server registers notify_channel', () => {
    configHolder.channels = { email: { enabled: true } } as unknown as NotificationChannelsConfig
    const availability = resolveNotifyAvailability(makeApp(), configHolder.channels, [])
    const server = createNotifyToolServer(baseContext({ usesImPush: false, imSessions: [] }))

    expect(availability.channelsConfigured).toBe(true)
    const toolNames = (server as any).tools.map((t: any) => t.name)
    expect(toolNames).toContain('notify_channel')
  })

  it('agrees: im-push granted + a pushable contact -> availability says true, server registers notify_bot', () => {
    configHolder.channels = undefined
    const imSessions = sessions(1)
    const availability = resolveNotifyAvailability(makeApp(), configHolder.channels, imSessions)
    const server = createNotifyToolServer(baseContext({ usesImPush: true, imSessions }))

    expect(availability.notifyBotAvailable).toBe(true)
    const toolNames = (server as any).tools.map((t: any) => t.name)
    expect(toolNames).toContain('notify_bot')
  })

  it('agrees: im-push granted but zero pushable contacts -> both say notify_bot is unavailable', () => {
    configHolder.channels = undefined
    const availability = resolveNotifyAvailability(makeApp(), configHolder.channels, [])
    const server = createNotifyToolServer(baseContext({ usesImPush: true, imSessions: [] }))

    expect(availability.notifyBotAvailable).toBe(false)
    const toolNames = (server as any).tools.map((t: any) => t.name)
    expect(toolNames).not.toContain('notify_bot')
  })

  it('agrees: im-push denied even with contacts present -> both say notify_bot is unavailable', () => {
    configHolder.channels = undefined
    const imSessions = sessions(2)
    const availability = resolveNotifyAvailability(makeApp(['im-push']), configHolder.channels, imSessions)
    // Mirrors execute.ts's actual wiring: usesImPush is resolvePermission(app, 'im-push'),
    // computed the same way — denied here means false at the real call site too.
    const server = createNotifyToolServer(baseContext({ usesImPush: false, imSessions }))

    expect(availability.notifyBotAvailable).toBe(false)
    const toolNames = (server as any).tools.map((t: any) => t.name)
    expect(toolNames).not.toContain('notify_bot')
  })

  it('agrees: both channel and bot available -> availability.anyNotifyToolAvailable and both tools registered', () => {
    configHolder.channels = { webhook: { enabled: true } } as unknown as NotificationChannelsConfig
    const imSessions = sessions(1)
    const availability = resolveNotifyAvailability(makeApp(), configHolder.channels, imSessions)
    const server = createNotifyToolServer(baseContext({ usesImPush: true, imSessions }))

    expect(availability.anyNotifyToolAvailable).toBe(true)
    const toolNames = (server as any).tools.map((t: any) => t.name)
    expect(toolNames).toEqual(expect.arrayContaining(['notify_channel', 'notify_bot']))
  })
})
