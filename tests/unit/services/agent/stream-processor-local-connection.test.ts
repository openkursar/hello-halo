/**
 * The error a turn ends with is what chat, the digital human's chat and IM
 * replies all show: a local connection refused by security software reaches
 * them already explained, with the program to allow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }))

vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('../../../../src/main/services/agent/mcp-manager', () => ({ broadcastMcpStatus: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-probe', () => ({ probeUnhealthyServers: vi.fn() }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({ getActiveEngine: () => 'anthropic' }))
vi.mock('../../../../src/main/services/agent/helpers', () => ({ getHeadlessElectronPath: () => 'C:\\Program Files\\Halo\\Halo.exe' }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../../../src/main/foundation/logging', () => ({ isDeveloperMode: () => false }))

import { processStream } from '../../../../src/main/services/agent/stream-processor'
import type { SessionState } from '../../../../src/main/services/agent/types'

function newState(): SessionState {
  return { spaceId: 'space-1', conversationId: 'conv-1', thoughts: [], abortController: new AbortController() }
}

async function run(messages: unknown[]) {
  const sessionState = newState()
  return processStream({
    v2Session: { send: vi.fn(), stream: () => (async function* () { yield* messages })() },
    sessionState,
    spaceId: 'space-1',
    conversationId: 'conv-1',
    messageContent: 'Hi',
    displayModel: 'm',
    abortController: sessionState.abortController,
    t0: Date.now(),
    callbacks: {},
  } as unknown as Parameters<typeof processStream>[0])
}

const init = { type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [] }
const failed = (result: string) => ({ type: 'result', subtype: 'success', is_error: true, result, session_id: 's' })
const errorEvents = () => emitAgentEvent.mock.calls
  .filter(([channel]) => channel === 'agent:error')
  .map(([, , , data]) => (data as { error: string }).error)

beforeEach(() => emitAgentEvent.mockClear())

describe('a turn that ends on a refused local connection', () => {
  it('reports the explanation and the program to allow', async () => {
    const result = await run([init, failed('API Error: Unable to connect to API (EACCES)')])

    const [error] = errorEvents()
    expect(error).toContain("Security software on this computer blocked Halo's internal connection")
    expect(error).toContain('C:\\Program Files\\Halo\\Halo.exe')
    expect(error).toContain('(engine error: API Error: Unable to connect to API (EACCES))')
    expect(result.errorThought?.content).toBe(error)
  })

  it('reports any other error in the engine’s words', async () => {
    const result = await run([init, failed('API Error: 529 overloaded')])

    expect(errorEvents()).toEqual(['API Error: 529 overloaded'])
    expect(result.errorThought?.content).toBe('API Error: 529 overloaded')
  })
})
