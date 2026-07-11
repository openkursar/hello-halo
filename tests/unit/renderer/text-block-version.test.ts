/**
 * Unit tests for the StreamingBubble text-block version coalescing.
 *
 * The renderer chat store bumps `textBlockVersion` on a new-text-block signal;
 * StreamingBubble resets its snapshot state on every change. A flood of EMPTY
 * new-text-block signals (isNewTextBlock=true, contentLen=0) — which a malformed
 * or duplicated cross-node relay stream can emit — must NOT keep bumping the
 * version, or the reset effect enters an unbounded React update cycle ("Maximum
 * update depth exceeded") and freezes the UI. nextTextBlockVersion encodes the
 * coalescing rule, tested here in isolation (no React/zustand harness needed).
 */

import { describe, it, expect } from 'vitest'
import { nextTextBlockVersion } from '../../../src/renderer/stores/chat/text-block-version'

describe('nextTextBlockVersion (empty new-text-block storm guard)', () => {
  it('does NOT bump on an empty new-text-block (no content to reset)', () => {
    expect(nextTextBlockVersion(0, true, 0)).toBe(0)
    expect(nextTextBlockVersion(5, true, 0)).toBe(5)
  })

  it('bumps on a new-text-block only when content has already streamed', () => {
    expect(nextTextBlockVersion(0, true, 12)).toBe(1)
    expect(nextTextBlockVersion(3, true, 1)).toBe(4)
  })

  it('never bumps when the signal is absent, regardless of content', () => {
    expect(nextTextBlockVersion(7, false, 100)).toBe(7)
    expect(nextTextBlockVersion(7, undefined, 100)).toBe(7)
  })

  it('a storm of empty new-text-block signals leaves the version pinned (no unbounded climb)', () => {
    let version = 0
    for (let i = 0; i < 1000; i++) {
      version = nextTextBlockVersion(version, true, 0)
    }
    expect(version).toBe(0) // pinned — the storm cannot drive an update cycle
  })

  it('a real mid-stream block still advances exactly once per content-bearing signal', () => {
    let version = 0
    // First text streams (no bump on its start since prior content was empty)…
    version = nextTextBlockVersion(version, true, 0)
    expect(version).toBe(0)
    // …then a tool_use, then a new text block AFTER content exists → one bump.
    version = nextTextBlockVersion(version, true, 40)
    expect(version).toBe(1)
    // A redundant empty re-signal does not double-bump.
    version = nextTextBlockVersion(version, true, 0)
    expect(version).toBe(1)
  })
})
