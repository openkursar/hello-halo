/**
 * Per-credential WS event visibility over a REAL `ws` server.
 *
 * An office-member credential must never receive a foreign office's events or
 * an arbitrary agent:* stream — only its own office's team sessions. A
 * remote-control (PIN) credential is unchanged and sees everything. This suite
 * drives the production initWebSocket through the real auth → subscribe →
 * broadcast path.
 *
 * These assertions are about events that must NOT arrive: give the server a
 * short settle window, then assert the forbidden frames never showed up.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import path from 'path'
import { WebSocket } from 'ws'
import { vi } from 'vitest'

function testHome(): string {
  return globalThis.__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
}

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => {
      const dir = testHome()
      if (name === 'userData') return path.join(dir, '.halo')
      return dir
    },
    getAppPath: () => path.join(testHome(), 'app'),
    getName: () => 'Halo',
    getVersion: () => '1.0.0-test',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

import { createDatabaseManager } from '../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../src/main/platform/store/types'
import { initFederationStore, shutdownFederationStore } from '../../../src/main/apps/federation/index'
import { initIdentity, getLocalIdentity } from '../../../src/main/http/identity/index'
import { issueOfficeCredential } from '../../../src/main/http/auth/office-credential'
import { generateAccessToken } from '../../../src/main/http/auth/token-store'
import {
  initWebSocket,
  shutdownWebSocket,
  broadcastToWebSocket,
  broadcastToAll,
} from '../../../src/main/http/websocket'
import { buildTeamSessionKey } from '../../../src/shared/apps/im-keys'

const OFFICE = 'office-scope-a'
const FOREIGN_OFFICE = 'office-scope-b'
const EPOCH = 'epoch-scope-1'

interface Recorded {
  type: string
  channel?: string
  data?: Record<string, unknown>
  error?: string
}

/** A raw `ws` client that authenticates, then records every server frame. */
class RawClient {
  private ws: WebSocket
  public received: Recorded[] = []
  public authed = false
  private constructor(ws: WebSocket) {
    this.ws = ws
  }

  static async connectAndAuth(port: number, token: string): Promise<RawClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const client = new RawClient(ws)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    ws.on('message', (buf: Buffer) => {
      const msg = JSON.parse(buf.toString()) as Recorded
      if (msg.type === 'auth:success') client.authed = true
      client.received.push(msg)
    })
    ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
    await waitFor(() => client.authed)
    return client
  }

  subscribe(conversationId: string): void {
    this.ws.send(JSON.stringify({ type: 'subscribe', payload: { conversationId } }))
  }

  events(): Recorded[] {
    return this.received.filter((m) => m.type === 'event')
  }

  errors(): Recorded[] {
    return this.received.filter((m) => m.type === 'error')
  }

  close(): void {
    this.ws.close()
  }
}

async function waitFor(predicate: () => boolean, budgetMs = 3000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 15))
  }
}

/** Let the server flush any pending sends before asserting on absence. */
async function settle(ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('AC-6.1 — WS per-credential event scoping (real ws)', () => {
  let server: http.Server
  let port: number
  let officeToken: string
  let pinToken: string
  let dbManager: DatabaseManager

  beforeEach(async () => {
    initIdentity()
    // The federation store singleton backs issueOfficeCredential's revocation ledger.
    dbManager = createDatabaseManager(':memory:')
    initFederationStore({ db: dbManager })
    officeToken = issueOfficeCredential({ officeId: OFFICE, identity: getLocalIdentity().id }).token
    pinToken = generateAccessToken()

    server = http.createServer()
    initWebSocket(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })

  afterEach(() => {
    shutdownWebSocket()
    server?.close()
    shutdownFederationStore()
    dbManager?.closeAll()
  })

  // ── Gate 1: subscribe ───────────────────────────────────────────────────────

  it('an office-member may subscribe to its OWN office team session but is refused a foreign one and an agent:* stream', async () => {
    const office = await RawClient.connectAndAuth(port, officeToken)

    const ownKey = buildTeamSessionKey('app-x', OFFICE, EPOCH)
    const foreignKey = buildTeamSessionKey('app-y', FOREIGN_OFFICE, EPOCH)
    const agentStream = 'agent:run-42' // an arbitrary non-team conversation

    office.subscribe(ownKey)
    office.subscribe(foreignKey)
    office.subscribe(agentStream)
    await settle()

    // Two refusals (foreign office + agent stream); the own-office key was accepted.
    const errs = office.errors().filter((e) => e.error === 'Subscription not permitted')
    expect(errs).toHaveLength(2)

    office.close()
  })

  // ── Gate 2: broadcastToWebSocket (conversation-scoped) ──────────────────────

  it('broadcastToWebSocket delivers an office-member only its own office stream, never a foreign office', async () => {
    const office = await RawClient.connectAndAuth(port, officeToken)
    const ownKey = buildTeamSessionKey('app-x', OFFICE, EPOCH)
    office.subscribe(ownKey)
    await settle()

    broadcastToWebSocket('agent:thinking', { conversationId: ownKey, teamId: OFFICE, text: 'mine' })
    // An event on a FOREIGN office's conversation must NOT be delivered, even though
    // the office-member never subscribed to it (defense-in-depth: the credential
    // scope check rejects it independently of the subscription set).
    const foreignKey = buildTeamSessionKey('app-y', FOREIGN_OFFICE, EPOCH)
    broadcastToWebSocket('agent:thinking', { conversationId: foreignKey, teamId: FOREIGN_OFFICE, text: 'theirs' })

    await waitFor(() => office.events().length > 0)
    await settle()

    const texts = office.events().map((e) => e.data?.text)
    expect(texts).toContain('mine')
    expect(texts).not.toContain('theirs')

    office.close()
  })

  // ── Gate 3: broadcastToAll (global) ─────────────────────────────────────────

  it('broadcastToAll gives an office-member only events for its own teamId; absent/foreign teamId is dropped; PIN sees all', async () => {
    const office = await RawClient.connectAndAuth(port, officeToken)
    const pin = await RawClient.connectAndAuth(port, pinToken)
    await settle()

    broadcastToAll('team:updated', { teamId: OFFICE, op: 'post_task' })
    broadcastToAll('team:updated', { teamId: FOREIGN_OFFICE, op: 'post_task' })
    // Global event with no teamId must also be dropped for an office-member (default-deny).
    broadcastToAll('app:installed', { appId: 'some-app' })

    await waitFor(() => office.events().length > 0)
    await settle()

    const officeData = office.events().map((e) => e.data)
    expect(officeData).toHaveLength(1)
    expect(officeData[0]).toMatchObject({ teamId: OFFICE, op: 'post_task' })

    const pinChannels = pin.events().map((e) => e.channel)
    expect(pinChannels.filter((c) => c === 'team:updated')).toHaveLength(2)
    expect(pinChannels).toContain('app:installed')

    office.close()
    pin.close()
  })
})
