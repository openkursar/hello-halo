import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../src/renderer/api', () => ({ api: { listToolsets: vi.fn() } }))
import { api } from '../../../src/renderer/api'
import { useToolsetsStore } from '../../../src/renderer/stores/toolsets.store'

beforeEach(() => { useToolsetsStore.setState({ byConversation: new Map(), aiRequested: new Map(), requestSignal: new Map() }) })

describe('native context controls publication', () => {
  it('does not let a pending menu read overwrite the successfully prepared mode', async () => {
    let finish!: (value: any) => void
    vi.mocked(api.listToolsets).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const pending = useToolsetsStore.getState().refresh('space', 'conversation')
    const statuses = [{ id: 'ai-terminal', displayName: 'Terminal', summary: '', open: false }]
    useToolsetsStore.getState().applyChangedEvent({ spaceId: 'space', conversationId: 'conversation', open: [], statuses })
    finish({ success: true, data: [] })
    await pending
    expect(useToolsetsStore.getState().byConversation.get('conversation')).toEqual(statuses)
  })

  it('replaces obsolete switches and clears requests for automatically available capabilities', () => {
    useToolsetsStore.setState({
      byConversation: new Map([['conversation', [{ id: 'ai-browser', displayName: 'Browser', summary: '', open: false }]]]),
      aiRequested: new Map([['conversation', new Set(['ai-browser'])]]),
      requestSignal: new Map([['conversation', 1]]),
    })
    const statuses = [
      { id: 'ai-browser', displayName: 'Browser', summary: '', open: true, configurable: false },
      { id: 'ai-terminal', displayName: 'Terminal', summary: '', open: true, configurable: false },
      { id: 'halo-api-ref', displayName: 'Operate Halo', summary: '', open: false },
    ]
    useToolsetsStore.getState().applyChangedEvent({ spaceId: 'space', conversationId: 'conversation', open: [], statuses })
    expect(useToolsetsStore.getState().byConversation.get('conversation')).toEqual(statuses)
    expect(useToolsetsStore.getState().aiRequested.get('conversation')?.size).toBe(0)
    expect(useToolsetsStore.getState().requestSignal.has('conversation')).toBe(false)
    useToolsetsStore.getState().applyChangedEvent({ spaceId: 'space', conversationId: 'conversation', open: ['halo-api-ref'], action: 'open', toolsetId: 'halo-api-ref' })
    const updated = useToolsetsStore.getState().byConversation.get('conversation')!
    expect(updated.find(status => status.id === 'ai-terminal')).toMatchObject({ open: true, configurable: false })
    expect(updated.find(status => status.id === 'halo-api-ref')?.open).toBe(true)
  })
})
