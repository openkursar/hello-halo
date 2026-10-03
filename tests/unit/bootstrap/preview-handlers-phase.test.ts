/**
 * The HTML preview IPC is registered in the essential phase: a restored HTML
 * tab asks for its preview origin on first render, before the extended phase.
 */

import { describe, it, expect } from 'vitest'
import { readSource } from '../architecture/lib/source-scan'

describe('canvas preview handlers', () => {
  it('are registered in the essential bootstrap and nowhere later', () => {
    expect(readSource('src/main/bootstrap/essential.ts')).toMatch(/^\s*registerCanvasPreviewHandlers\(\)/m)
    expect(readSource('src/main/bootstrap/extended.ts')).not.toContain('registerCanvasPreviewHandlers')
  })
})
