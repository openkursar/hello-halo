/**
 * A request refused for want of a required proxy never reached the model:
 * a group moves on to its next member and holds nothing against this one.
 */

import { describe, expect, it } from 'vitest'
import { createBalancer } from '../../../src/main/openai-compat-router/balancing'
import type { GroupShape, MemberRef } from '../../../src/main/openai-compat-router/balancing'
import { judgeFailure } from '../../../src/main/openai-compat-router/balancing/failure-verdict'
import { failureReason, toFailureEvidence } from '../../../src/main/openai-compat-router/server/group-evidence'

const BODY = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'A proxy is required for this account, but none is configured. [proxy-required:none]' } })
const ref = (sourceId: string): MemberRef => ({ key: `${sourceId}\u0000m`, sourceId, modelId: 'm' })
const group: GroupShape = { id: 'g', strategy: 'priority', members: [ref('a'), ref('b')] }

describe('a refusal for want of a proxy', () => {
  it('is recognized from the reply a member left behind', () => {
    const evidence = toFailureEvidence({ cause: 'http', status: 503 }, { status: 503, headers: {}, body: BODY })
    expect(evidence).toMatchObject({ kind: 'blocked' })
    expect(failureReason(evidence)).toContain('proxy')
  })

  it('leaves an ordinary 503 as the member\'s own failure', () => {
    const evidence = toFailureEvidence({ cause: 'http', status: 503 }, { status: 503, headers: {}, body: 'Service Unavailable' })
    expect(evidence).toMatchObject({ kind: 'http', status: 503 })
  })

  it('is no judgment on the member', () => {
    expect(judgeFailure({ kind: 'blocked', message: 'x' }, 0)).toEqual({ blame: 'none' })
  })

  it('puts nothing to rest however often it happens, so the member serves again the moment it can', () => {
    const balancer = createBalancer()
    for (let round = 0; round < 10; round++) {
      const run = balancer.start(group, null)
      const first = run.next()!
      expect(first.member.sourceId).toBe('a')
      expect(run.failed(first, { kind: 'blocked', message: 'x' })).toEqual({ rest: null, blame: 'none' })
      expect(run.next()?.member.sourceId).toBe('b')
      run.finish()
    }
    const run = balancer.start(group, null)
    expect(run.next()?.member.sourceId).toBe('a')
    run.finish()
  })
})
