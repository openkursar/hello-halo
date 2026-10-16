/**
 * Text boxes that grow with their text are measured off-screen
 * (`utils/textarea-height`), never by collapsing them first. A collapsed box
 * makes every scroller around it larger for a moment; the browser clamps the
 * scroll position and it stays clamped, so typing near the end of a transcript
 * or page moved the view on every key.
 */

import { describe, expect, it } from 'vitest'
import { findMatches, formatMatches, listSourceFiles } from './lib/source-scan'

describe('auto-growing text boxes', () => {
  it('are never collapsed to height auto to be measured', () => {
    const offenders = findMatches(listSourceFiles('src/renderer'), /\.style\.height\s*=\s*['"`]auto['"`]/)
    expect(offenders, `Use fitTextareaHeight / useAutoResize instead:\n${formatMatches(offenders)}`).toEqual([])
  })
})
