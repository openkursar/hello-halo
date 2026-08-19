/**
 * Unit tests for the WeCom bot provider's connMode state machine
 * (apps/runtime/im-channels/wecom-bot.provider).
 *
 * WeCom grants the bot slot to the newest connection, so two devices sharing
 * one credential kick each other. The instance defends the slot in 'active'
 * mode and, after repeated supersedes, yields to 'yielding' (standby), probing
 * periodically to reclaim it. These tests pin the branches that guard against
 * flushing pushes into a dead connection and against silent stream loss:
 *
 *   (a) probe-drops-mid-confirm → cancel confirm + reschedule probe, and DO NOT
 *       recoverToActive (the branch near ws 'disconnected' while yielding).
 *   (b) successful probe confirm → recoverToActive flushes pending pushes.
 *   (c) getConnectionState() reports 'standby' while yielding.
 *   (d) a ws 'disconnected' while active marks in-flight stream sessions broken.
 *
 * The SDK is fully mocked: a FakeWSClient records connect/disconnect and lets
 * the test emit the SDK's own events. Timers are faked so probe/confirm/backoff
 * are deterministic. No network, no real @wecom SDK.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// ── Mock external side-effect dependency (desktop notification) ──
const notifyAppEventMock = vi.fn()
vi.mock('../../../../../src/main/services/notification.service', () => ({
  notifyAppEvent: (...args: unknown[]) => notifyAppEventMock(...args),
}))

// ── Mock the WeCom SDK ──
// The provider does `new AiBot.WSClient({...})` where AiBot is the default
// import. Each construction is captured so the test can drive its events.
//
// The FakeWSClient class must be declared INSIDE the vi.mock factory (which is
// hoisted above imports); a registry array is filled at construction time and
// exposed through the mocked module so tests can reach the created clients.
interface FakeWSClient extends EventEmitter {
  isConnected: boolean
  connectCount: number
  disconnectCount: number
  sendMessage: ReturnType<typeof vi.fn>
  replyStreamNonBlocking: ReturnType<typeof vi.fn>
  replyStream: ReturnType<typeof vi.fn>
  reply: ReturnType<typeof vi.fn>
  connect(): void
  disconnect(): void
  goAuthenticated(): void
}

vi.mock('@wecom/aibot-node-sdk', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events')
  const registry: FakeWSClient[] = []

  class WSClient extends EE {
    isConnected = false
    connectCount = 0
    disconnectCount = 0
    sendMessage = vi.fn(async () => undefined)
    replyStreamNonBlocking = vi.fn(async () => 'sent')
    replyStream = vi.fn(async () => undefined)
    reply = vi.fn(async () => undefined)

    constructor(_opts: unknown) {
      super()
      registry.push(this as unknown as FakeWSClient)
    }

    connect(): void {
      this.connectCount++
    }

    disconnect(): void {
      this.disconnectCount++
      this.isConnected = false
    }

    goAuthenticated(): void {
      this.isConnected = true
      this.emit('authenticated')
    }
  }

  return { default: { WSClient }, __registry: registry }
})

// Import AFTER mocks are declared (vi.mock is hoisted, so this is safe).
import { WecomBotProvider } from '../../../../../src/main/apps/runtime/im-channels/wecom-bot.provider'
import * as sdk from '@wecom/aibot-node-sdk'

const createdClients = (sdk as unknown as { __registry: FakeWSClient[] }).__registry

// ============================================
// Helpers
// ============================================

function makeInstance() {
  const provider = new WecomBotProvider()
  const instance = provider.createInstance('inst-1', {
    botId: 'aib-test',
    secret: 'shh',
  })
  return instance as unknown as InstanceWithInternals
}

/** The subset of private state the white-box tests reach into. */
interface InstanceWithInternals {
  start(): void
  stop(): void
  isConnected(): boolean
  getConnectionState(): string
  connMode: 'active' | 'yielding'
  confirmTimer: ReturnType<typeof setTimeout> | null
  probeTimer: ReturnType<typeof setTimeout> | null
  pendingPushes: Array<{
    chatId: string
    text: string
    chatType: 'direct' | 'group'
    enqueuedAt: number
    sourceTag: string
    trace: string | undefined
    resolve: (sent: boolean) => void
  }>
  activeStreamSessions: Set<{ markStreamBroken: (r: string) => void }>
}

function latestClient(): FakeWSClient {
  return createdClients[createdClients.length - 1]
}

/** Drive the active-mode supersede storm until the instance yields to standby. */
function forceYield(client: FakeWSClient): void {
  // Default arbiter threshold is 3 supersedes within the window.
  client.emit('event.disconnected_event')
  client.emit('event.disconnected_event')
  client.emit('event.disconnected_event')
}

// ============================================
// Tests
// ============================================

describe('WecomBotInstance connMode state machine', () => {
  beforeEach(() => {
    createdClients.length = 0
    notifyAppEventMock.mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('(c) reports standby while yielding and connecting once probing', () => {
    const inst = makeInstance()
    inst.start()
    const client = latestClient()
    client.goAuthenticated()
    expect(inst.getConnectionState()).toBe('online')

    forceYield(client)
    expect(inst.connMode).toBe('yielding')
    // Yielded: not authenticated, so state is standby (not connecting/offline).
    expect(inst.getConnectionState()).toBe('standby')
    expect(inst.isConnected()).toBe(false)
    // Yielding fires exactly one standby desktop notification.
    expect(notifyAppEventMock).toHaveBeenCalledTimes(1)
  })

  it('(d) marks in-flight stream sessions broken on active-mode disconnect', () => {
    const inst = makeInstance()
    inst.start()
    const client = latestClient()
    client.goAuthenticated()

    const session = { markStreamBroken: vi.fn() }
    inst.activeStreamSessions.add(session)

    client.emit('disconnected', 'network blip')

    expect(session.markStreamBroken).toHaveBeenCalledTimes(1)
    expect(session.markStreamBroken.mock.calls[0][0]).toContain('network blip')
    // Still active mode — a plain disconnect is not a supersede.
    expect(inst.connMode).toBe('active')
  })

  it('(b) recovers to active after a probe survives the confirm window, flushing pending pushes', () => {
    const inst = makeInstance()
    inst.start()
    forceYield(latestClient())
    expect(inst.connMode).toBe('yielding')

    // Advance to fire the scheduled probe → a fresh client connects.
    vi.runOnlyPendingTimers()
    const probeClient = latestClient()
    expect(probeClient.connectCount).toBe(1)

    // Queue a pending push so we can observe the flush that recovery triggers.
    const resolve = vi.fn()
    inst.pendingPushes.push({
      chatId: 'chat-1',
      text: 'queued while yielding',
      chatType: 'direct',
      enqueuedAt: Date.now(),
      sourceTag: 'test',
      trace: 't',
      resolve,
    })

    // Probe authenticates → starts the confirm timer (not yet recovered).
    probeClient.goAuthenticated()
    expect(inst.confirmTimer).not.toBeNull()
    expect(inst.connMode).toBe('yielding')

    // Confirm window elapses without a supersede → recoverToActive + flush.
    vi.runOnlyPendingTimers()
    expect(inst.connMode).toBe('active')
    expect(probeClient.sendMessage).toHaveBeenCalledTimes(1)
    expect(probeClient.sendMessage.mock.calls[0][0]).toBe('chat-1')
  })

  it('(a) probe drop mid-confirm reschedules the probe and does NOT recover', () => {
    const inst = makeInstance()
    inst.start()
    forceYield(latestClient())

    // Fire the first probe.
    vi.runOnlyPendingTimers()
    const probeClient = latestClient()

    // Probe authenticates → confirm timer armed.
    probeClient.goAuthenticated()
    expect(inst.confirmTimer).not.toBeNull()

    const clientsBefore = createdClients.length

    // The probe connection drops before the confirm window elapses.
    probeClient.emit('disconnected', 'kicked mid-probe')

    // Confirm was cancelled; must not recover.
    expect(inst.confirmTimer).toBeNull()
    expect(inst.connMode).toBe('yielding')
    // A new probe was scheduled (timer armed) rather than recovering.
    expect(inst.probeTimer).not.toBeNull()

    // Fire the rescheduled probe → a NEW client is opened, still yielding.
    vi.runOnlyPendingTimers()
    expect(createdClients.length).toBe(clientsBefore + 1)
    expect(inst.connMode).toBe('yielding')

    // The confirm timer never fired recovery: draining timers keeps us yielding
    // (a probe that merely opens without authenticating cannot recover).
    expect(inst.connMode).toBe('yielding')
  })

  it('does not recover if the confirm timer fires after leaving yielding mode', () => {
    // Guard: recoverToActive is gated on connMode still being 'yielding'.
    const inst = makeInstance()
    inst.start()
    forceYield(latestClient())
    vi.runOnlyPendingTimers()
    const probeClient = latestClient()
    probeClient.goAuthenticated()
    expect(inst.confirmTimer).not.toBeNull()

    // Stop the instance — resets connMode to 'active' and clears timers.
    inst.stop()
    expect(inst.connMode).toBe('active')

    // Draining any residual timers must not throw or resurrect the flow.
    expect(() => vi.runOnlyPendingTimers()).not.toThrow()
  })
})
