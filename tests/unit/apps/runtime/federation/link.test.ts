/**
 * Unit tests for apps/runtime/federation -- link seam.
 *
 * Covers the InMemoryFederationHub/Link (the in-process LAN simulation used by
 * coordinator tests) and the LanMeshLink WS seam the Lead wires: outbound frames
 * reach the WsSender (to=null → broadcast) and inbound deliver() reaches the
 * registered handler.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  InMemoryFederationHub,
  InMemoryFederationLink,
} from '../../../../../src/main/apps/runtime/federation/link'
import { LanMeshLink } from '../../../../../src/main/apps/runtime/federation/lan-mesh-provider'
import type { FederationMessage, NodeId } from '../../../../../src/main/apps/runtime/federation'

const hb = (fromNode: NodeId): FederationMessage => ({
  kind: 'heartbeat',
  officeId: 'office-1',
  fromNode,
  ts: 1,
})

describe('InMemoryFederationHub', () => {
  it('routes a directed send to the target node only', () => {
    const hub = new InMemoryFederationHub()
    const a = new InMemoryFederationLink('a', hub)
    const b = new InMemoryFederationLink('b', hub)
    const c = new InMemoryFederationLink('c', hub)
    const bReceived: FederationMessage[] = []
    const cReceived: FederationMessage[] = []
    b.onMessage((_from, m) => bReceived.push(m))
    c.onMessage((_from, m) => cReceived.push(m))

    a.send('b', hb('a'))

    expect(bReceived).toHaveLength(1)
    expect(cReceived).toHaveLength(0)
  })

  it('broadcast reaches all peers except the sender', () => {
    const hub = new InMemoryFederationHub()
    const a = new InMemoryFederationLink('a', hub)
    const b = new InMemoryFederationLink('b', hub)
    const c = new InMemoryFederationLink('c', hub)
    const seen: Record<string, number> = { a: 0, b: 0, c: 0 }
    a.onMessage(() => (seen.a += 1))
    b.onMessage(() => (seen.b += 1))
    c.onMessage(() => (seen.c += 1))

    a.broadcast(hb('a'))

    expect(seen).toEqual({ a: 0, b: 1, c: 1 })
  })

  it('a closed link neither sends nor receives', () => {
    const hub = new InMemoryFederationHub()
    const a = new InMemoryFederationLink('a', hub)
    const b = new InMemoryFederationLink('b', hub)
    const received: FederationMessage[] = []
    b.onMessage((_from, m) => received.push(m))

    b.close()
    a.send('b', hb('a'))
    expect(received).toHaveLength(0)

    a.close()
    expect(() => a.broadcast(hb('a'))).not.toThrow()
  })
})

describe('LanMeshLink', () => {
  it('forwards send to the WsSender with the target node', () => {
    const wsSend = vi.fn()
    const link = new LanMeshLink(wsSend)
    link.send('peer', hb('self'))
    expect(wsSend).toHaveBeenCalledWith('peer', hb('self'))
  })

  it('forwards broadcast to the WsSender with to=null', () => {
    const wsSend = vi.fn()
    const link = new LanMeshLink(wsSend)
    link.broadcast(hb('self'))
    expect(wsSend).toHaveBeenCalledWith(null, hb('self'))
  })

  it('deliver() routes an inbound frame to the registered handler', () => {
    const link = new LanMeshLink(vi.fn())
    const received: Array<{ from: string; msg: FederationMessage }> = []
    link.onMessage((from, msg) => received.push({ from, msg }))

    link.deliver('peer', hb('peer'))

    expect(received).toEqual([{ from: 'peer', msg: hb('peer') }])
  })

  it('after close, send/broadcast/deliver are inert', () => {
    const wsSend = vi.fn()
    const link = new LanMeshLink(wsSend)
    const received: FederationMessage[] = []
    link.onMessage((_from, m) => received.push(m))

    link.close()
    link.send('peer', hb('self'))
    link.broadcast(hb('self'))
    link.deliver('peer', hb('peer'))

    expect(wsSend).not.toHaveBeenCalled()
    expect(received).toHaveLength(0)
  })
})
