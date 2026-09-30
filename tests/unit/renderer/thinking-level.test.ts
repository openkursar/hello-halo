/**
 * The last-used thinking level that seeds new conversations.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { useThinkingLevelStore } from '../../../src/renderer/stores/thinking-level.store'

describe('useThinkingLevelStore', () => {
  beforeEach(() => useThinkingLevelStore.setState({ level: null }))

  it('is unset until the user picks a level', () => {
    expect(useThinkingLevelStore.getState().level).toBeNull()
  })

  it('keeps the level picked last, off included', () => {
    useThinkingLevelStore.getState().setLevel('low')
    expect(useThinkingLevelStore.getState().level).toBe('low')
    useThinkingLevelStore.getState().setLevel('off')
    expect(useThinkingLevelStore.getState().level).toBe('off')
  })
})
