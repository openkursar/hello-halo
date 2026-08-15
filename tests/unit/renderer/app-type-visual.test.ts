/**
 * Unit tests for the app-type icon shape/color resolution.
 * Guards the per-type shape (hexagon only for MCP) and non-empty class output.
 */

import { describe, it, expect } from 'vitest'
import { appTypeIconShape } from '../../../src/renderer/utils/app-type-visual'
import type { AppType } from '../../../src/shared/apps/spec-types'

describe('app-type-visual / appTypeIconShape', () => {
  it('marks only MCP as a hexagon', () => {
    expect(appTypeIconShape('mcp').hexagon).toBe(true)
    for (const type of ['automation', 'skill', 'extension'] as AppType[]) {
      expect(appTypeIconShape(type).hexagon).toBe(false)
    }
  })

  it('returns a non-empty container class for every type', () => {
    for (const type of ['automation', 'skill', 'mcp', 'extension'] as AppType[]) {
      expect(appTypeIconShape(type).className.length).toBeGreaterThan(0)
    }
  })

  it('uses the type-color token classes for skill and mcp', () => {
    expect(appTypeIconShape('skill').className).toContain('app-skill')
    expect(appTypeIconShape('mcp').className).toContain('app-mcp')
  })

  it('uses the primary token for the agent (digital human)', () => {
    expect(appTypeIconShape('automation').className).toContain('primary')
  })
})
