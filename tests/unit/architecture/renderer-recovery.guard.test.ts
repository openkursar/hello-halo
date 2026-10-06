/**
 * Recovering the main window's renderer reloads it in place. A renderer that
 * hangs or crashes while the user works in another app must not show, focus,
 * maximize, resize or move the window: that pulled Halo over the user's work,
 * once per recovery.
 */

import { describe, expect, it } from 'vitest'
import { readSource } from './lib/source-scan'

describe('renderer recovery guard', () => {
  it('reloads without touching the window', () => {
    const source = readSource('src/main/index.ts')
    const start = source.indexOf('function recoverRenderer(')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}\n', start))
    expect(body).toMatch(/\.reloadIgnoringCache\(\)/)
    expect(body).not.toMatch(/\.(show|showInactive|focus|maximize|restore|moveTop|setBounds|setSize|setPosition)\(/)
  })
})
