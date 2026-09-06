/**
 * Every error envelope here closes a specific bad reaction a weak model has
 * to a terse error (see the kimi3 harness review): asking the user for a
 * token, retrying a 403 variant, or concluding Halo can't do something it
 * actually can. These tests lock the structural guarantees — a real `code`
 * on every self-API error, a real (never templated) `group` on 403, and the
 * full group enum spelled out on 404 — not the exact prose.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../../src/main/services/api-ref/resource-path', () => ({
  getApiRefPath: (file: string) => (file === 'index.txt' ? '/abs/path/to/resources/api-ref/index.txt' : null),
  readApiRefJson: (file: string) => {
    if (file === 'scope.json') {
      return [
        { method: 'GET', path: '/api/apps' },
        { method: 'GET', path: '/api/spaces/:spaceId/artifacts' },
      ]
    }
    if (file === 'routes.json') {
      return [
        { method: 'GET', path: '/api/apps' },
        { method: 'GET', path: '/api/apps/:appId', group: 'digital-human' },
        { method: 'GET', path: '/api/config' },
        { method: 'GET', path: '/api/spaces/:spaceId/artifacts', group: 'workspace' },
      ]
    }
    return null
  },
}))

import { resetScopeCache } from '../../../../src/main/http/self-api/scope'
import { resetSelfApiTokens, issueSelfApiToken } from '../../../../src/main/http/self-api/token-store'
import { selfApiAuthMiddleware, rejectNonApi } from '../../../../src/main/http/self-api/middleware'
import { API_REF_GROUP_IDS } from '../../../../src/main/services/api-ref/groups'

function fakeReqRes(method: string, path: string, token?: string) {
  const req: any = { method, path, url: path, headers: token ? { authorization: `Bearer ${token}` } : {}, query: {}, body: {} }
  const res: any = {
    statusCode: 200,
    sent: undefined,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(body: unknown) {
      res.sent = body
      return res
    },
  }
  return { req, res }
}

describe('selfApiAuthMiddleware error envelopes', () => {
  let token: string

  beforeEach(() => {
    resetScopeCache()
    resetSelfApiTokens()
    token = issueSelfApiToken('space-a')
  })

  it('401 carries a code, never asks for the token, never echoes it', () => {
    const { req, res } = fakeReqRes('GET', '/api/apps', 'wrong-token')
    selfApiAuthMiddleware(req, res, () => {})

    expect(res.statusCode).toBe(401)
    expect(res.sent.code).toBe('halo.self_api.unauthorized')
    expect(res.sent.error).not.toContain(token)
    expect(res.sent.error.toLowerCase()).toContain('do not ask the user')
  })

  it('rejects a valid token supplied as ?token= — header only, so it never lands in a command line or a log', () => {
    const { req, res } = fakeReqRes('GET', '/api/apps')
    req.query = { token }
    selfApiAuthMiddleware(req, res, () => {})

    expect(res.statusCode).toBe(401)
  })

  it('403 carries a code and the real group, never a template placeholder', () => {
    const { req, res } = fakeReqRes('GET', '/api/apps/ap_1', token)
    selfApiAuthMiddleware(req, res, () => {})

    expect(res.statusCode).toBe(403)
    expect(res.sent.code).toBe('halo.self_api.not_exposed')
    expect(res.sent.group).toBe('digital-human')
    expect(res.sent.error).toContain("halo_api_ref('digital-human')")
    expect(res.sent.error).not.toContain('<group>')
  })

  it('403 omits the group field and the redirect sentence when the route has none', () => {
    const { req, res } = fakeReqRes('GET', '/api/config', token)
    selfApiAuthMiddleware(req, res, () => {})

    expect(res.statusCode).toBe(403)
    expect(res.sent.group).toBeUndefined()
    expect(res.sent.error).not.toContain('<group>')
    expect(res.sent.error).not.toContain('halo_api_ref(')
  })

  it('404 carries a code, a real absolute path, and the full group enum spelled out', () => {
    const { req, res } = fakeReqRes('GET', '/api/does-not-exist', token)
    selfApiAuthMiddleware(req, res, () => {})

    expect(res.statusCode).toBe(404)
    expect(res.sent.code).toBe('halo.self_api.unknown_endpoint')
    expect(res.sent.error).toContain('/abs/path/to/resources/api-ref/index.txt')
    expect(res.sent.error).not.toContain('<group>')
    expect(res.sent.error).not.toContain('{{')
    for (const g of ['conversation', 'workspace', 'digital-human', 'knowledge-base', 'channels', 'settings', 'store', 'terminal']) {
      expect(res.sent.error).toContain(g)
    }
  })

  it('allows a request through to next() when scoped and authorized', () => {
    const { req, res } = fakeReqRes('GET', '/api/apps', token)
    let calledNext = false
    selfApiAuthMiddleware(req, res, () => {
      calledNext = true
    })

    expect(calledNext).toBe(true)
    expect(res.sent).toBeUndefined()
  })
})

describe('selfApiAuthMiddleware space gate', () => {
  const SPACE_ID = 'space-mine'
  const OTHER_SPACE_ID = 'space-other'
  let token: string

  beforeEach(() => {
    resetScopeCache()
    resetSelfApiTokens()
    token = issueSelfApiToken(SPACE_ID)
  })

  it("defaults an unnamed spaceId to the session's own space", () => {
    const { req, res } = fakeReqRes('GET', '/api/apps', token)
    let calledNext = false
    selfApiAuthMiddleware(req, res, () => {
      calledNext = true
    })

    expect(calledNext).toBe(true)
    expect(new URLSearchParams(req.url.split('?')[1]).get('spaceId')).toBe(SPACE_ID)
  })

  it("allows a path-scoped request naming the session's own space", () => {
    const { req, res } = fakeReqRes('GET', `/api/spaces/${SPACE_ID}/artifacts`, token)
    let calledNext = false
    selfApiAuthMiddleware(req, res, () => {
      calledNext = true
    })

    expect(calledNext).toBe(true)
  })

  it('refuses a path naming a different space with code halo.self_api.wrong_space', () => {
    const { req, res } = fakeReqRes('GET', `/api/spaces/${OTHER_SPACE_ID}/artifacts`, token)
    selfApiAuthMiddleware(req, res, () => {})

    expect(res.statusCode).toBe(403)
    expect(res.sent.code).toBe('halo.self_api.wrong_space')
  })

  it('refuses a query spaceId naming a different space', () => {
    const { req, res } = fakeReqRes('GET', '/api/apps', token)
    req.url = `/api/apps?spaceId=${OTHER_SPACE_ID}`
    req.query = { spaceId: OTHER_SPACE_ID }
    selfApiAuthMiddleware(req, res, () => {})

    expect(res.statusCode).toBe(403)
    expect(res.sent.code).toBe('halo.self_api.wrong_space')
  })

  it('refuses a body spaceId naming a different space', () => {
    const { req, res } = fakeReqRes('GET', '/api/apps', token)
    req.body = { spaceId: OTHER_SPACE_ID }
    selfApiAuthMiddleware(req, res, () => {})

    expect(res.statusCode).toBe(403)
    expect(res.sent.code).toBe('halo.self_api.wrong_space')
  })

  it('two sessions never cross: each token only ever resolves to its own space', () => {
    const otherToken = issueSelfApiToken(OTHER_SPACE_ID)

    const mine = fakeReqRes('GET', '/api/apps', token)
    selfApiAuthMiddleware(mine.req, mine.res, () => {})
    expect(new URLSearchParams(mine.req.url.split('?')[1]).get('spaceId')).toBe(SPACE_ID)

    const theirs = fakeReqRes('GET', '/api/apps', otherToken)
    selfApiAuthMiddleware(theirs.req, theirs.res, () => {})
    expect(new URLSearchParams(theirs.req.url.split('?')[1]).get('spaceId')).toBe(OTHER_SPACE_ID)
  })
})

/**
 * Every manual page footer teaches the agent: a 404 carrying a `code` means
 * the path is wrong, one without it means the id is wrong. The two call for
 * opposite recoveries, so any 404 this listener emits has to pick a side.
 */
describe('rejectNonApi', () => {
  it('carries the same code as an in-scope unknown path', () => {
    const { req, res } = fakeReqRes('GET', '/apis/apps')
    let nexted = false
    rejectNonApi(req, res, () => {
      nexted = true
    })

    expect(nexted).toBe(false)
    expect(res.statusCode).toBe(404)
    expect(res.sent.code).toBe('halo.self_api.unknown_endpoint')
  })

  it('passes /api/ through untouched', () => {
    const { req, res } = fakeReqRes('GET', '/api/apps')
    let nexted = false
    rejectNonApi(req, res, () => {
      nexted = true
    })

    expect(nexted).toBe(true)
    expect(res.sent).toBeUndefined()
  })
})

describe('group enum', () => {
  it('offers exactly the groups the manual has pages for', () => {
    // Three consumers read this list (tool enum, this middleware's 404, and
    // GroupId in the route meta contract). They were three literals once.
    const { req, res } = fakeReqRes('GET', '/api/definitely-not-a-route', issueSelfApiToken('space-a'))
    selfApiAuthMiddleware(req, res, () => {})

    expect(res.statusCode).toBe(404)
    for (const group of API_REF_GROUP_IDS) {
      expect(res.sent.error).toContain(group)
    }
  })
})
