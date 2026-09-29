import { describe, expect, it } from 'vitest'
import { DEFAULT_SPACE_ID, resolveInstallSpaceId } from '../../../src/shared/apps/install-scope'

describe('resolveInstallSpaceId', () => {
  it('keeps an explicit space for every app type', () => {
    for (const type of ['automation', 'skill', 'mcp', 'extension'] as const) {
      expect(resolveInstallSpaceId('space-1', type)).toBe('space-1')
    }
  })

  it('puts a digital human without a space in the Halo space', () => {
    expect(resolveInstallSpaceId(null, 'automation')).toBe(DEFAULT_SPACE_ID)
    expect(resolveInstallSpaceId(undefined, 'automation')).toBe(DEFAULT_SPACE_ID)
    expect(resolveInstallSpaceId('', 'automation')).toBe(DEFAULT_SPACE_ID)
  })

  it('leaves skills and MCP servers global', () => {
    expect(resolveInstallSpaceId(null, 'skill')).toBeNull()
    expect(resolveInstallSpaceId(null, 'mcp')).toBeNull()
  })
})
