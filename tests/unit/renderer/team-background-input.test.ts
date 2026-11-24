import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const { session } = vi.hoisted(() => ({ session: {
  isGenerating: true, streamingContent: 'PRIVATE_BACKGROUND_OUTPUT', isStreaming: true,
  thoughts: [{ id: 'private-thought', type: 'thinking', content: 'PRIVATE_BACKGROUND_THOUGHT' }],
  isThinking: false, textBlockVersion: 1, liveInputs: [] as any[], pendingQuestion: undefined as any,
} }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }), default: { t: (text: string) => text } }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: Object.assign((selector: (state: any) => unknown) => selector({
    getSession: () => session, resetSession: () => {}, answerQuestion: () => {},
  }), { getState: () => ({ getSession: () => session }) }),
}))
vi.mock('../../../src/renderer/stores/people-view.store', () => ({
  usePeopleViewStore: { getState: () => ({ transcriptPositions: {} }) },
}))
vi.mock('../../../src/renderer/hooks/useConversationDetail', () => ({ useConversationDetail: () => {} }))
vi.mock('../../../src/renderer/components/team/session-history', () => ({
  peekTeamSessionHistory: () => [{ id: 'initial', role: 'user', content: 'background check', timestamp: 'now' }],
  invalidateTeamSessionHistory: () => {}, loadTeamSessionHistory: async () => ({}),
  retainTeamSessionHistory: () => () => {}, matchesTeamHistory: () => false,
}))
vi.mock('../../../src/renderer/components/chat/transcript', () => ({
  useStickToBottom: () => ({ scrollerRef: { current: null }, contentRef: { current: null },
    scroller: null, scrollToBottom: () => {}, detach: () => {}, isFollowing: () => true }),
  transcriptRowClass: () => '', captureTranscriptPosition: () => null, restoreTranscriptPosition: () => false,
}))
vi.mock('../../../src/renderer/components/chat/useBrowserToolCalls', () => ({ useBrowserToolCalls: () => [] }))
vi.mock('../../../src/renderer/components/chat/MessageRow', () => ({ MessageRow: () => null }))
vi.mock('../../../src/renderer/components/chat/InputArea', () => ({ InputArea: () => null }))
vi.mock('../../../src/renderer/components/chat/CompactNotice', () => ({ CompactNotice: () => null }))
vi.mock('../../../src/renderer/components/chat/InterruptedBubble', () => ({ InterruptedBubble: () => null }))
vi.mock('../../../src/renderer/components/chat/StreamingSection', async () => {
  const { createElement } = await import('react')
  return { StreamingSection: (props: any) => createElement('section', { 'data-stream': true },
    props.streamingContent,
    props.thoughts.map((thought: any) => thought.content).join(' '),
    (props.liveInputs ?? []).map((input: any) => createElement('p', {
      key: input.message.id, 'data-source': input.message.source,
    }, input.textSnapshot, input.message.content)),
    props.pendingQuestion ? 'OWNER_QUESTION' : null) }
})

import { TeamSessionChat } from '../../../src/renderer/components/team/TeamSessionChat'

const render = (background = true) => renderToStaticMarkup(createElement(TeamSessionChat, {
  appId: 'member', spaceId: 'space', teamId: 'team', epochId: 'epoch', isRemote: false,
  isBackgroundTurn: () => background, renderMessages: () => null,
}))

beforeEach(() => {
  session.streamingContent = 'PRIVATE_BACKGROUND_OUTPUT'
  session.thoughts = [{ id: 'private-thought', type: 'thinking', content: 'PRIVATE_BACKGROUND_THOUGHT' }]
  session.liveInputs = [{ message: { id: 'arrival', role: 'user', source: 'injection', content: 'OWNER_ADDITION', timestamp: 'now' },
    textBlockVersion: 1, textOffset: 25, textSnapshot: 'PRIVATE_BACKGROUND_SNAPSHOT' }]
  session.pendingQuestion = undefined
})

describe('team input during background work', () => {
  it('shows the original input while keeping background output, thoughts and captured text hidden', () => {
    const html = render()
    expect(html).toContain('OWNER_ADDITION')
    expect(html).toContain('data-source="injection"')
    expect(html).not.toContain('PRIVATE_BACKGROUND')
  })

  it('shows an arrival even before the background model emits any output', () => {
    session.streamingContent = ''
    session.thoughts = []
    expect(render()).toContain('OWNER_ADDITION')
  })

  it('keeps quiet background output hidden when no input or question needs displaying', () => {
    session.liveInputs = []
    expect(render()).not.toContain('data-stream')
  })

  it('retains the existing owner-question surface', () => {
    session.liveInputs = []
    session.pendingQuestion = { status: 'pending', questions: [] }
    expect(render()).toContain('OWNER_QUESTION')
  })

  it('preserves ordinary foreground output and arrivals', () => {
    const html = render(false)
    expect(html).toContain('OWNER_ADDITION')
    expect(html).toContain('PRIVATE_BACKGROUND_OUTPUT')
  })

  it('shows only the owner’s own additions, never a teammate’s or another chat’s arrival', () => {
    session.liveInputs = [
      ...session.liveInputs,
      { message: { id: 'teammate', role: 'system', source: 'team-message', content: 'TEAMMATE_REPORT', timestamp: 'now', metadata: { teamId: 'team', inputMode: 'live' } }, textBlockVersion: 1, textOffset: 25 },
      { message: { id: 'guest', role: 'user', content: 'IM_MESSAGE', timestamp: 'now' }, textBlockVersion: 1, textOffset: 25 },
    ]
    const html = render()
    expect(html).toContain('OWNER_ADDITION')
    expect(html).not.toContain('TEAMMATE_REPORT')
    expect(html).not.toContain('IM_MESSAGE')
    session.liveInputs = session.liveInputs.slice(1)
    expect(render()).not.toContain('data-stream')
  })
})
