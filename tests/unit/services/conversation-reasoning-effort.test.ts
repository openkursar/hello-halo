/**
 * A conversation's own thinking level: set at creation (the composer's
 * last-used pick) or from the slider, and only ever a ladder level.
 *
 * The service is real; only its IO boundaries (fs, space registry, config,
 * KB seed) are mocked as an in-memory disk.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('fs', () => {
  const files = new Map<string, string>()
  return {
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string) => {
      const data = files.get(p)
      if (data === undefined) throw new Error(`ENOENT: ${p}`)
      return data
    },
    writeFileSync: (p: string, data: string) => {
      files.set(p, data)
    },
    mkdirSync: () => undefined,
    readdirSync: (p: string) =>
      [...files.keys()]
        .filter((k) => k.startsWith(p))
        .map((k) => k.split('/').pop() as string),
    rmSync: (p: string) => {
      files.delete(p)
    },
    renameSync: (from: string, to: string) => {
      const data = files.get(from)
      if (data === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, data)
    },
  }
})

vi.mock('../../../src/main/services/space.service', () => ({
  getSpace: (spaceId: string) => ({ id: spaceId, path: `/spaces/${spaceId}`, isTemp: false }),
  touchSpaceActivity: () => undefined,
}))

vi.mock('../../../src/main/services/tlon', () => ({
  getSeedKBIds: () => [],
}))

vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: () => undefined,
}))

import {
  createConversation,
  getConversation,
  updateConversation,
} from '../../../src/main/services/conversation.service'

const SPACE = 'space-1'

describe('conversation reasoning effort', () => {
  it('starts at the level passed at creation', () => {
    const conv = createConversation(SPACE, undefined, 'low')

    expect(conv.reasoningEffort).toBe('low')
    expect(getConversation(SPACE, conv.id)?.reasoningEffort).toBe('low')
  })

  it('starts without a level when none, or no ladder level, is passed', () => {
    expect(createConversation(SPACE)).not.toHaveProperty('reasoningEffort')
    expect(createConversation(SPACE, undefined, 'ultra')).not.toHaveProperty('reasoningEffort')
  })

  it('drops an update that is not a ladder level', () => {
    const conv = createConversation(SPACE, undefined, 'high')
    updateConversation(SPACE, conv.id, { reasoningEffort: 'ultra' as never })

    expect(getConversation(SPACE, conv.id)?.reasoningEffort).toBe('high')
  })

  it('does not move the conversation up the list when only the level changes', () => {
    const conv = createConversation(SPACE)
    const updated = updateConversation(SPACE, conv.id, { reasoningEffort: 'max' })

    expect(updated?.reasoningEffort).toBe('max')
    expect(updated?.updatedAt).toBe(conv.updatedAt)
  })
})
