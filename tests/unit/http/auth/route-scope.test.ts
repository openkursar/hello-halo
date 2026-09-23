/**
 * Office-member route allowlist tests. This is the HTTP security boundary:
 * only the team read-only family is permitted; everything else — crucially
 * the control plane — must be denied.
 */

import { describe, it, expect } from 'vitest'
import { matchOfficeScope, OFFICE_READ_ROUTES } from '../../../../src/main/http/auth/route-scope'

describe('matchOfficeScope', () => {
  describe('allowed team read-only family', () => {
    const allowed: Array<[string, string]> = [
      ['GET', '/api/teams/abc123'],
      ['GET', '/api/teams/abc123/detail'],
      ['GET', '/api/teams/abc123/chat-messages'],
      ['GET', '/api/teams/abc123/artifacts'],
      ['GET', '/api/teams/abc123/epochs'],
      ['GET', '/api/teams/abc123/epochs/ep1/board'],
      ['GET', '/api/teams/abc123/epochs/ep1/artifacts'],
      ['POST', '/api/teams/abc123/members/m1/send'],
      ['POST', '/api/teams/abc123/members/m1/stop'],
    ]
    for (const [method, path] of allowed) {
      it(`allows ${method} ${path}`, () => {
        expect(matchOfficeScope(method, path)).toBe(true)
      })
    }

    it('matches case-insensitively on method', () => {
      expect(matchOfficeScope('get', '/api/teams/abc123/epochs')).toBe(true)
    })
  })

  describe('denied (control plane and everything else) — default deny', () => {
    const denied: Array<[string, string]> = [
      ['POST', '/api/teams'],
      ['GET', '/api/teams'],
      ['POST', '/api/teams/x/run'],
      ['POST', '/api/teams/x/pause'],
      ['GET', '/api/agent/sessions'],
      ['DELETE', '/api/teams/x/members/y'],
      ['GET', '/api/config'],
      ['PUT', '/api/teams/x/edges'],
      ['POST', '/api/teams/x/triggers'],
      ['POST', '/api/teams/abc123'],
      ['POST', '/api/teams/abc123/epochs/ep1/board'],
      // Only the dispatch sub-routes are admitted on a member; others deny.
      ['POST', '/api/teams/abc123/members/m1'],
      ['GET', '/api/teams/abc123/members/m1/send'],
      ['GET', '/api/teams/abc123/members/m1/stop'],
      ['GET', '/api/system/info'],
      ['GET', '/api/space/current'],
      ['GET', '/api/remote/status'],
      ['GET', '/api/teams/abc123/epochs/ep1'],
      ['GET', '/api/teams/abc123/members'],
    ]
    for (const [method, path] of denied) {
      it(`denies ${method} ${path}`, () => {
        expect(matchOfficeScope(method, path)).toBe(false)
      })
    }

    it('does not let a :param segment span a slash', () => {
      // ":teamId" must not swallow "/" — a deeper path is a different route.
      expect(matchOfficeScope('GET', '/api/teams/abc/extra/detail')).toBe(false)
    })
  })

  it('exposes the raw allowlist for introspection', () => {
    expect(OFFICE_READ_ROUTES.length).toBe(9)
    // The read family is GET; the writes are the member-dispatch POSTs (send,
    // and the stop that interrupts it — gated identically at the route).
    expect(OFFICE_READ_ROUTES.filter((r) => r.method === 'GET')).toHaveLength(7)
    expect(OFFICE_READ_ROUTES.filter((r) => r.method === 'POST')).toHaveLength(2)
  })
})
