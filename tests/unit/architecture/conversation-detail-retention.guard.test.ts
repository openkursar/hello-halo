/**
 * Guard: a view that renders a chat-store session's live detail retains that
 * conversation's streaming detail.
 *
 * Main forwards streaming events (messages, thoughts, tool calls) only for
 * conversations a view declared through `useConversationDetail`; everything
 * else arrives as status events. A component that reads a session from the chat
 * store and renders its streaming fields without the hook shows a blank reply
 * until the turn completes.
 *
 * Scan: a renderer file is a "live-detail reader" when it selects a session from
 * the chat store (`getSession(` / `sessions.get(`) and reads a streaming field.
 * Each must call `useConversationDetail(`, or delegate to a module that does.
 */

import { describe, it, expect } from 'vitest'
import { listSourceFiles, readSource } from './lib/source-scan'

const RENDERER = listSourceFiles('src/renderer').filter((f) => !f.startsWith('src/renderer/stores/'))
const SELECTS_SESSION = /\b(getSession|sessions\.get)\(/
const STREAMING_FIELD = /\.(streamingContent|thoughts|isThinking|isStreaming|pendingToolCalls|textBlockVersion)\b/

/**
 * Presentational components: they receive streaming fields as props from their
 * parent (their own store reads are status fields such as the queue or retry
 * notice), so the parents that render them must retain instead.
 */
const PRESENTATIONAL: Record<string, { tag: string; exemptParents: Record<string, string> }> = {
  'src/renderer/components/chat/MessageList.tsx': {
    tag: '<MessageList',
    exemptParents: {
      'src/renderer/components/apps/SessionDetailView.tsx':
        'automation run detail: polls the run transcript by design and never shows chat-store streaming',
    },
  },
}

const retains = (file: string) => readSource(file).includes('useConversationDetail(')

describe('conversation detail retention', () => {
  it('every view reading live session detail retains the conversation', () => {
    const readers = RENDERER.filter((file) => {
      const source = readSource(file)
      return SELECTS_SESSION.test(source) && STREAMING_FIELD.test(source)
    })
    expect(readers.length).toBeGreaterThan(0)
    const missing = readers.filter((file) => !retains(file) && !(file in PRESENTATIONAL))
    expect(missing).toEqual([])
  })

  it('every parent rendering a presentational live view retains', () => {
    for (const [component, { tag, exemptParents }] of Object.entries(PRESENTATIONAL)) {
      const parents = RENDERER.filter((file) => file !== component && readSource(file).includes(tag))
      expect(parents.length, component).toBeGreaterThan(0)
      const missing = parents.filter((file) => !retains(file) && !(file in exemptParents))
      expect(missing, component).toEqual([])
    }
  })

  it('views retain through the hook, not the raw api', () => {
    const raw = RENDERER.filter((file) =>
      file.startsWith('src/renderer/components/') && readSource(file).includes('retainConversationDetail('))
    expect(raw).toEqual([])
  })
})
