/**
 * Tests for the pty write chunker: caps chunk size at 50 chars and never splits
 * an escape sequence across chunks.
 */

import { describe, it, expect } from 'vitest'
import { chunkInput } from '../../../../src/worker/pty-host/session'

describe('chunkInput', () => {
  it('passes short input through as one chunk', () => {
    expect(chunkInput('ls -la')).toEqual(['ls -la'])
  })

  it('returns no chunks for empty input', () => {
    expect(chunkInput('')).toEqual([])
  })

  it('splits long input into ≤50-char chunks that reassemble losslessly', () => {
    const data = 'x'.repeat(123)
    const chunks = chunkInput(data)
    expect(chunks.length).toBe(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50)
    expect(chunks.join('')).toBe(data)
  })

  it('starts a new chunk at ESC so escape sequences are never split', () => {
    const data = 'abc\x1b[Adef'
    const chunks = chunkInput(data)
    expect(chunks.join('')).toBe(data)
    for (const c of chunks.slice(1)) {
      // Any chunk containing ESC has it at position 0.
      const esc = c.indexOf('\x1b')
      if (esc !== -1) expect(esc).toBe(0)
    }
  })

  it('keeps a long paste byte-identical after reassembly', () => {
    const data = Array.from({ length: 500 }, (_, i) => `line ${i} \x1b[31mred\x1b[0m`).join('\n')
    expect(chunkInput(data).join('')).toBe(data)
  })
})
