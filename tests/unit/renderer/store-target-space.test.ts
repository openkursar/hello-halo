import { describe, it, expect } from 'vitest'
import { resolveStoreTargetSpace } from '../../../src/renderer/utils/store-target-space'
import type { Space } from '../../../src/renderer/types'

function space(id: string, isTemp = false): Space {
  return {
    id,
    name: id,
    icon: 'folder',
    path: `/test/${id}`,
    isTemp,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('store skill target space', () => {
  const haloSpace = space('halo-temp', true)
  const first = space('first')
  const current = space('current')
  const installed = space('installed')

  it.each([
    { name: 'fresh global install', spaceId: null, spaces: [], currentSpace: null, expected: haloSpace },
    { name: 'fresh explicit Halo install', spaceId: haloSpace.id, spaces: [], currentSpace: null, expected: haloSpace },
    { name: 'explicit Halo install with a current custom space', spaceId: haloSpace.id, spaces: [first, current], currentSpace: current, expected: haloSpace },
    { name: 'explicit custom install', spaceId: installed.id, spaces: [first, installed], currentSpace: current, expected: installed },
    { name: 'global install with a current space', spaceId: null, spaces: [first], currentSpace: current, expected: current },
    { name: 'global install with only custom spaces', spaceId: null, spaces: [first, installed], currentSpace: null, expected: first },
    { name: 'missing installed space with a current space', spaceId: 'missing', spaces: [first], currentSpace: current, expected: current },
    { name: 'missing installed space with only custom spaces', spaceId: 'missing', spaces: [first], currentSpace: null, expected: first },
  ])('selects the expected target for $name', ({ spaceId, spaces, currentSpace, expected }) => {
    const target = resolveStoreTargetSpace(spaceId, { spaces, currentSpace, haloSpace })

    expect(target).toBe(expected)
  })

  it('returns null when no space is available', () => {
    const target = resolveStoreTargetSpace(null, { spaces: [], currentSpace: null, haloSpace: null })

    expect(target).toBeNull()
  })

  it('prefers a matching custom space over a matching Halo space', () => {
    const custom = space(haloSpace.id)

    const target = resolveStoreTargetSpace(haloSpace.id, { spaces: [custom], currentSpace: current, haloSpace })

    expect(target).toBe(custom)
  })
})
