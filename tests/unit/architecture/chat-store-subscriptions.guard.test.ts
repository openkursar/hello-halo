/**
 * A chat session object is replaced on every streamed token. A component that
 * subscribes to the whole session re-renders per token, together with
 * everything it renders; high-frequency fields belong to the smallest
 * component that shows them (the chat page reads low-frequency fields, the
 * transcript reads tokens and steps).
 */

import { describe, expect, it } from 'vitest'
import { findMatches, formatMatches, listSourceFiles } from './lib/source-scan'

const WHOLE_SESSION = /useChatStore\(\s*\(?s\)?\s*=>\s*s\.(sessions\.get\([^)]*\)|getSession\([^)]*\))\s*\)/

/**
 * Existing whole-session subscribers outside the chat page, each a live view
 * of one IM or team conversation that renders nothing but that conversation.
 * Splitting them follows the chat page's pattern (`LiveTranscript`).
 */
const ALLOWED = new Set([
  'src/renderer/components/apps/ImChatView.tsx',
  'src/renderer/components/team/TeamSessionChat.tsx',
])

describe('chat store subscription guard', () => {
  it('no component subscribes to a whole chat session', () => {
    const files = listSourceFiles('src/renderer').filter(file => !ALLOWED.has(file))
    expect(formatMatches(findMatches(files, WHOLE_SESSION))).toBe('')
  })

  it('the allowlist only names files that still need it', () => {
    for (const file of ALLOWED) expect(findMatches([file], WHOLE_SESSION).length).toBeGreaterThan(0)
  })
})
