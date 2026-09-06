/**
 * classify() is what turns "does this path+method appear in scope.json /
 * routes.json" into the 401/403/404 split the middleware serves. Backed by
 * a fixture instead of the real generated files so this stays correct
 * independent of how many routes are currently annotated.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../../src/main/services/api-ref/resource-path', () => ({
  readApiRefJson: (file: string) => {
    if (file === 'scope.json') return [{ method: 'GET', path: '/api/apps' }]
    if (file === 'routes.json') {
      return [
        { method: 'GET', path: '/api/apps' },
        { method: 'GET', path: '/api/apps/:appId', group: 'digital-human' },
        { method: 'GET', path: '/api/config' },
      ]
    }
    return null
  },
}))

import { classify, resetScopeCache } from '../../../../src/main/http/self-api/scope'

describe('classify', () => {
  beforeEach(() => resetScopeCache())

  it('allows a path+method listed in scope.json', () => {
    expect(classify('GET', '/api/apps')).toEqual({ decision: 'allowed' })
  })

  it('forbids a path that exists in routes.json but not scope.json, and names its real group', () => {
    expect(classify('GET', '/api/apps/ap_1')).toEqual({ decision: 'forbidden', group: 'digital-human' })
  })

  it('forbids without a group when the route has none (e.g. internal)', () => {
    expect(classify('GET', '/api/config')).toEqual({ decision: 'forbidden', group: undefined })
  })

  it('treats an unregistered path as unknown', () => {
    expect(classify('GET', '/api/does-not-exist')).toEqual({ decision: 'unknown' })
  })

  it('is method-sensitive', () => {
    expect(classify('DELETE', '/api/apps')).toEqual({ decision: 'unknown' })
  })
})
