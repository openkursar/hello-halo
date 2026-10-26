import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ engine: 'halo', credentials: vi.fn(), resolveCredentials: vi.fn(), query: vi.fn() }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../src/main/services/agent', () => ({
  resolveDefaultEngine: async () => state.engine,
  getApiCredentials: () => state.credentials(),
  resolveCredentialsForSdk: (...args: unknown[]) => state.resolveCredentials(...args),
  getWorkingDir: () => '/tmp/team-proposal',
  getHeadlessElectronPath: () => '/electron',
  buildInternalTaskSdkOptions: async (params: unknown) => ({ ...params as object }),
  query: (...args: unknown[]) => state.query(...args),
}))

import { proposeMembersViaSdk } from '../../../../src/main/apps/team/service'

describe('internal team proposal engine', () => {
  it('retains the chosen engine while account preparation awaits a refresh', async () => {
    let ready!: (value: unknown) => void
    const prepared = new Promise(done => { ready = done })
    state.engine = 'halo'
    state.credentials.mockReturnValueOnce(prepared)
    state.resolveCredentials.mockImplementation(async (credentials, _effort, engineId) => ({ ...credentials, engineId }))
    state.query.mockImplementation(async function* () {
      yield { type: 'result', result: '[{"memberName":"Ada","role":"Writer","responsibility":"Write the proposal."}]' }
    })
    const pending = proposeMembersViaSdk('Prepare a proposal', 'team-space')
    await vi.waitFor(() => expect(state.credentials).toHaveBeenCalledOnce())
    state.engine = 'anthropic'
    ready({ sourceId: 'account', sdkModel: 'model' })
    expect(await pending).toHaveLength(1)
    expect(state.resolveCredentials).toHaveBeenCalledWith(expect.any(Object), undefined, 'halo')
    expect(state.query.mock.calls[0][0].options).toMatchObject({ engineId: 'halo', credentials: { engineId: 'halo' } })
  })
})
