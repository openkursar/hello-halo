/**
 * The last-used thinking level a send carries as its fallback.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { lastUsedThinkingLevel, useThinkingLevelStore } from '../../../src/renderer/stores/thinking-level.store'

describe('lastUsedThinkingLevel', () => {
  beforeEach(() => useThinkingLevelStore.setState({ level: null }))

  it('is undefined until the user picks a level', () => {
    expect(lastUsedThinkingLevel()).toBeUndefined()
  })

  it('is the level picked last, off included', () => {
    useThinkingLevelStore.getState().setLevel('low')
    expect(lastUsedThinkingLevel()).toBe('low')
    useThinkingLevelStore.getState().setLevel('off')
    expect(lastUsedThinkingLevel()).toBe('off')
  })
})
