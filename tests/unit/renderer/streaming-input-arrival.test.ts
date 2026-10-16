import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/components/chat/ThoughtProcess', () => ({ ThoughtProcess: ({ thoughts, isThinking }: any) => React.createElement('div', { 'data-process': true, 'data-thinking': isThinking }, thoughts.map((thought: any) => thought.arrival?.content ?? thought.id).join(',')) }))
vi.mock('../../../src/renderer/components/chat/ArrivalCard', () => ({ ArrivalCard: ({ message, inProcess }: any) => React.createElement('section', { 'data-arrival': inProcess ? 'process' : 'card' }, message.content) }))
vi.mock('../../../src/renderer/components/chat/StreamingBubble', () => ({ StreamingBubble: ({ content }: any) => React.createElement('p', {}, content) }))
vi.mock('../../../src/renderer/components/chat/MessageRow', () => ({ MessageRow: ({ message }: any) => React.createElement('article', { 'data-source': message.source }, message.content) }))
vi.mock('../../../src/renderer/components/chat/InjectionAnnotation', () => ({ InjectionAnnotation: ({ messages }: any) => React.createElement('aside', {}, messages.map((message: any) => message.content).join(',')) }))
vi.mock('../../../src/renderer/components/tool/BrowserTaskCard', () => ({ BrowserTaskCard: () => null }))
vi.mock('../../../src/renderer/components/tool/TerminalTaskCard', () => ({ TerminalTaskCard: () => null }))
vi.mock('../../../src/renderer/components/chat/AskUserQuestionCard', () => ({ AskUserQuestionCard: () => null }))
vi.mock('../../../src/renderer/components/chat/QueuedMessagesPanel', () => ({ QueuedMessagesPanel: () => null }))
vi.mock('../../../src/renderer/components/chat/ApiRetryNotice', () => ({ ApiRetryNotice: () => null }))

import { StreamingSection } from '../../../src/renderer/components/chat/StreamingSection'

type Source = 'team-message' | 'injection' | 'cross-conversation' | 'person'

function markup(...sources: Source[]) {
  return markupWith(['tool-before', 'tool-after'], sources)
}

function markupWith(thoughtIds: string[], sources: Source[]) {
  return renderToStaticMarkup(React.createElement(StreamingSection, {
    streamingContent: 'Checking finished', isStreaming: true, isThinking: true, textBlockVersion: 2,
    thoughts: thoughtIds.map(id => ({ id, type: 'tool_use' as const, content: '', timestamp: 'now' })),
    liveInputs: sources.map((source, index) => ({
      message: {
        id: `pending-live-input-${index}`, role: source === 'injection' || source === 'person' ? 'user' as const : 'system' as const,
        ...(source === 'person' ? {} : { source }), content: 'Arrived report', timestamp: 'now',
        metadata: source === 'team-message' ? { teamId: 'team', inputMode: 'live' as const } : source === 'cross-conversation' ? { fromConversationId: 'other', inputMode: 'live' as const } : undefined,
      },
      afterThoughtId: 'tool-before', textBlockVersion: 2, textOffset: 8, textSnapshot: 'Checking',
    })),
  }))
}

describe('live transcript rendering', () => {
  it('keeps team reports inside one process without splitting or duplicating the reply', () => {
    const html = markup('team-message')
    expect(html).toContain('Arrived report')
    expect(html.match(/data-process/g)).toHaveLength(1)
    expect(html).toContain('<p>Checking finished</p>')
    expect(html.match(/Checking/g)).toHaveLength(1)
    expect(html).not.toContain('<article')
  })

  it('keeps one running process and the whole reply when a person adds to the turn', () => {
    const html = markup('injection')
    expect(html).toContain('<aside>Arrived report</aside>')
    expect(html).not.toContain('data-source="injection"')
    expect(html.match(/data-process/g)).toHaveLength(1)
    expect(html).toContain('data-thinking="true"')
    expect(html).not.toContain('data-thinking="false"')
    expect(html).toContain('tool-before,tool-after')
    expect(html).toContain('<p>Checking finished</p>')
    expect(html.match(/<p>/g)).toHaveLength(1)
    expect(html.indexOf('<aside>')).toBeGreaterThan(html.indexOf('</p>'))
  })

  it('does not accumulate reply partitions for repeated additions or mixed team traffic', () => {
    for (const html of [markup('injection', 'injection'), markup('injection', 'team-message', 'injection')]) {
      expect(html.match(/data-process/g)).toHaveLength(1)
      expect(html.match(/<p>/g)).toHaveLength(1)
      expect(html).toContain('<p>Checking finished</p>')
      expect(html.match(/<aside>/g)).toHaveLength(1)
      expect(html).toContain('<aside>Arrived report,Arrived report</aside>')
      expect(html).not.toContain('<article')
    }
  })

  it('draws another conversation’s message in the process where it arrived, like a teammate’s', () => {
    const html = markup('cross-conversation')
    expect(html.match(/data-process/g)).toHaveLength(1)
    expect(html).toContain('Arrived report')
    expect(html.match(/Checking/g)).toHaveLength(1)
    expect(html).not.toContain('<article')
  })

  it('still splits the reply where a person’s message arrived', () => {
    const html = markup('person')
    expect(html).toContain('<article>Arrived report</article>')
    expect(html.match(/data-process/g)).toHaveLength(2)
  })

  it('shows an arrival before any work as its own card after the reply, never as the whole process', () => {
    const html = markupWith([], ['team-message'])
    expect(html).toContain('<div data-process="true" data-thinking="true"></div>')
    expect(html).toContain('<section data-arrival="card">Arrived report</section>')
    expect(html.indexOf('data-arrival')).toBeGreaterThan(html.indexOf('<p>Checking finished</p>'))
  })

  it('treats the reply after its last split the same: an arrival with no work beside it is a card until work joins it', () => {
    const at = (second: number) => `2026-10-13T10:00:0${second}.000Z`
    const render = (thoughtSeconds: number[], isThinking: boolean) => renderToStaticMarkup(React.createElement(StreamingSection, {
      streamingContent: 'Checking finished', isStreaming: true, isThinking, textBlockVersion: 2,
      thoughts: thoughtSeconds.map(second => ({ id: `t${second}`, type: 'tool_use' as const, content: '', timestamp: at(second) })),
      liveInputs: [
        { message: { id: 'pending-live-push', role: 'assistant' as const, source: 'push' as const, content: 'On it', timestamp: at(3) }, afterThoughtId: 't2', textBlockVersion: 2, textOffset: 8, textSnapshot: 'Checking' },
        { message: { id: 'pending-live-team', role: 'system' as const, source: 'team-message' as const, content: 'Teammate report', timestamp: at(5), metadata: { teamId: 'team', inputMode: 'live' as const } }, afterThoughtId: 't2', textBlockVersion: 2, textOffset: 8, textSnapshot: 'Checking' },
      ],
    }))

    for (const isThinking of [true, false]) {
      const html = render([1, 2], isThinking)
      expect(html).toContain('t1,t2')
      expect(html).not.toMatch(/data-process[^>]*>[^<]*Teammate report/)
      expect(html).toContain('<section data-arrival="card">Teammate report</section>')
      expect(html.indexOf('data-arrival')).toBeGreaterThan(html.indexOf('<p> finished</p>'))
    }
    expect(render([1, 2], false).match(/data-process/g)).toHaveLength(1)

    const joined = render([1, 2, 6], true)
    expect(joined).toContain('Teammate report,t6')
    expect(joined).not.toContain('data-arrival="card"')
  })
})
