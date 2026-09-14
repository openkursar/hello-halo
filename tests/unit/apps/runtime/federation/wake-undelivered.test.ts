/**
 * A cross-machine wake that never reached its owner must stay distinguishable
 * from a turn that ran and produced nothing.
 *
 * The two look identical downstream — both arrive as "no text" — and the
 * location-aware session deps used to collapse them, reporting every completion
 * through the success path. The consequences were all silent: the team's record
 * kept the message marked delivered, the failing-fate reply act was never filed
 * (a `result` is not a recordable fate), and the lead was never told the turn had
 * not run. An operator's only way to notice was to compare two machines by hand.
 */

import { describe, it, expect } from 'vitest'
import { makeLocationAwareSessionDeps } from '../../../../../src/main/apps/runtime/federation/session-deps'
import type { TurnCompletion } from '../../../../../src/main/apps/runtime/team/message-bus'
import type { OrchestrationSessionDeps } from '../../../../../src/main/apps/runtime/team'

const SELF = 'node-self'
const OWNER = 'node-owner'
const OFFICE = 'office-1'
const REMOTE_APP = 'app-remote'

function makeDeps(sendWakeResult = true) {
  let completion: ((outcome: TurnCompletion) => void) | null = null

  const local = {
    sendAppChatMessage: async () => ({ finalMessage: 'local ran' }),
    isSessionActive: () => false,
    injectIntoSession: () => false,
    closeTeamSession: async () => {},
    getMemberSpaceId: () => 'space-local',
  } as unknown as OrchestrationSessionDeps

  const deps = makeLocationAwareSessionDeps({
    local,
    resolveOwnerNode: () => OWNER,
    selfNodeId: SELF,
    sendWake: () => sendWakeResult,
    registerTurnComplete: (_corr, cb) => {
      completion = cb
      return () => {
        completion = null
      }
    },
    getRemoteSpaceId: () => 'space-remote',
  })

  return {
    deps,
    settle: (outcome: TurnCompletion) => completion?.(outcome),
    wake: () =>
      deps.sendAppChatMessage({
        appId: REMOTE_APP,
        spaceId: 'space-remote',
        message: 'do the thing',
        conversationId: 'conv-1',
        teamContext: {
          teamId: OFFICE,
          epochId: 'epoch-1',
          correlationId: 'corr-1',
          fromAppId: 'app-sender',
          wait: false,
        },
      } as Parameters<OrchestrationSessionDeps['sendAppChatMessage']>[0]),
  }
}

describe('remote wake — an ending that means "no turn ran"', () => {
  it('surfaces an undelivered completion as undelivered, not as an empty reply', async () => {
    const h = makeDeps()
    const pending = h.wake()
    h.settle({ kind: 'undelivered', reason: 'timeout' })

    await expect(pending).resolves.toEqual({ finalMessage: null, undelivered: { reason: 'timeout' } })
  })

  it('still reports a genuine empty reply as a completion', async () => {
    const h = makeDeps()
    const pending = h.wake()
    h.settle({ kind: 'result', content: '' })

    const res = await pending
    expect(res.undelivered).toBeUndefined()
    expect(res.finalMessage).toBe('')
  })

  it('carries a real reply through unchanged', async () => {
    const h = makeDeps()
    const pending = h.wake()
    h.settle({ kind: 'result', content: 'answered' })

    await expect(pending).resolves.toEqual({ finalMessage: 'answered' })
  })

  it('reports undelivered when the wake could not be sent at all', async () => {
    const h = makeDeps(false)
    await expect(h.wake()).resolves.toEqual({
      finalMessage: null,
      undelivered: { reason: 'owner-unreachable' },
    })
  })
})
