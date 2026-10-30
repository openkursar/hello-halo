import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

vi.mock('../../../src/main/services/space.service', () => ({
  getSpace: (id: string) => ({ id, path: join(globalThis.__HALO_TEST_DIR__, id), isTemp: false }),
  touchSpaceActivity: () => undefined,
}))
vi.mock('../../../src/main/services/tlon', () => ({ getSeedKBIds: () => [] }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getConfig: () => ({ agent: { sdkEngine: 'anthropic' } }) }))
import { addMessage, createConversation, getConversation, saveSessionId } from '../../../src/main/services/conversation.service'

describe('conversation engine origin', () => {
  it('records the running engine even when the saved preference names a missing CC', () => {
    const conversation = createConversation('space', undefined, undefined, { engineId: 'halo' })
    expect(conversation.engineId).toBe('halo')
    expect(createConversation('space').engineId).toBe('halo')
    expect(createConversation('space', undefined, undefined, { engineId: 'anthropic' }).engineId).toBe('anthropic')
  })
  it('corrects a conversation opened before bootstrap when its first actual session finishes', () => {
    const conversation = createConversation('space')
    saveSessionId('space', conversation.id, 'cc-session', 'anthropic')
    expect(getConversation('space', conversation.id)?.engineId).toBe('anthropic')
  })
  it('retains the origin badge when compatible history later runs on another engine', () => {
    const conversation = createConversation('space', undefined, undefined, { engineId: 'anthropic' })
    addMessage('space', conversation.id, { role: 'assistant', content: 'earlier answer' })
    saveSessionId('space', conversation.id, 'continued-session', 'halo')
    expect(getConversation('space', conversation.id)?.engineId).toBe('anthropic')
  })
})
