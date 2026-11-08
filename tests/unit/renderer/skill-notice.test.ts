import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => `translated:${text}` }), getCurrentLanguage: () => 'en' }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ holdOpenThoughts: () => () => {} }))
vi.mock('../../../src/renderer/components/chat/ArrivalCard', () => ({ ArrivalCard: () => null, arrivalIcon: () => () => null }))
vi.mock('../../../src/renderer/components/chat/tool-result', () => ({ ToolResultViewer: () => null }))
vi.mock('../../../src/renderer/components/chat/SubAgentTimeline', () => ({ SubAgentTimeline: () => null }))
vi.mock('../../../src/renderer/components/tool/TodoCard', () => ({ TodoCard: () => null }))

import { ThoughtPanel } from '../../../src/renderer/components/chat/ThoughtPanel'
import { SkillNotice as SkillNoticeView } from '../../../src/renderer/components/chat/SkillNotice'
import { LazyCollapsedThoughtProcess } from '../../../src/renderer/components/chat/CollapsedThoughtProcess'
import { nextThoughtPanelModel } from '../../../src/renderer/components/chat/thought-utils'
import { parseSDKMessage } from '../../../src/main/services/agent/message-utils'
import { summarizeThoughts } from '../../../src/shared/transcript'
import { SKILL_NOTICE_TEXT } from '../../../src/shared/skill-notice'
import type { SkillNotice } from '../../../src/shared/types/skills'

const codes: SkillNotice[] = ['catalog-unavailable']

describe('skill notice presentation', () => {
  it.each(codes)('renders %s in the collapsed panel, without exposing a skill name or path', code => {
    const thought = parseSDKMessage({ type: 'system', subtype: 'skill_notice', skillNotice: code, content: '/private/secret-skill' })!
    const model = nextThoughtPanelModel(null, [thought])
    const markup = renderToStaticMarkup(createElement(ThoughtPanel, {
      model, todos: null, isThinking: false, isExpanded: false, onToggleExpanded: () => {},
      isMaximized: false, onToggleMaximized: () => {}, scrollRef: { current: null },
    }))
    expect(markup).toContain(`translated:${SKILL_NOTICE_TEXT[code]}`)
    expect(markup).toContain('role="status"')
    expect(markup).not.toContain('secret-skill')
    expect(model.display).toHaveLength(0)
    expect(model.notices).toHaveLength(1)
    expect(thought.type).toBe('system')
  })

  it.each(codes)('retains %s after reload without loading separated thought details', code => {
    const thought = parseSDKMessage({ type: 'system', subtype: 'skill_notice', skillNotice: code })!
    const onLoadThoughts = vi.fn()
    const markup = renderToStaticMarkup(createElement(LazyCollapsedThoughtProcess, { thoughtsSummary: summarizeThoughts([thought]), onLoadThoughts }))
    expect(markup).toContain(`translated:${SKILL_NOTICE_TEXT[code]}`)
    expect(onLoadThoughts).not.toHaveBeenCalled()
  })

  it('preserves the notice list identity as unrelated reasoning streams', () => {
    const thought = parseSDKMessage({ type: 'system', subtype: 'skill_notice', skillNotice: 'catalog-unavailable' })!
    const reasoning = { ...thought, id: 'thinking', type: 'thinking' as const, skillNotice: undefined, content: 'start' }
    const first = nextThoughtPanelModel(null, [thought, reasoning])
    const next = nextThoughtPanelModel(first, [thought, { ...reasoning, content: 'continued' }])
    expect(next.notices).toBe(first.notices)
    const added = { ...thought, id: 'next' }
    const appended = nextThoughtPanelModel(next, [...next.thoughts, added])
    expect(appended.notices).toEqual([thought, added])
    expect(nextThoughtPanelModel(appended, [added]).notices).toEqual([added])
  })

  it('renders several notices from one turn without a duplicate React key', () => {
    const first = parseSDKMessage({ type: 'system', subtype: 'skill_notice', skillNotice: 'catalog-unavailable' })!
    // A stored transcript can repeat a notice together with its id.
    const repeated = { ...first, id: first.id }
    const thoughts = [first, repeated]
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
    try {
      const live = renderToStaticMarkup(createElement(ThoughtPanel, {
        model: nextThoughtPanelModel(null, thoughts), todos: null, isThinking: false, isExpanded: false, onToggleExpanded: () => {},
        isMaximized: false, onToggleMaximized: () => {}, scrollRef: { current: null },
      }))
      expect(live.match(/role="status"/g)).toHaveLength(2)
      const collapsed = renderToStaticMarkup(createElement(LazyCollapsedThoughtProcess, { thoughtsSummary: summarizeThoughts(thoughts), onLoadThoughts: vi.fn() }))
      expect(collapsed.match(/role="status"/g)).toHaveLength(2)
    } finally { spy.mockRestore() }
    expect(errors.filter(line => /same key|duplicate key|unique "key"/i.test(line))).toEqual([])
  })

  it.each(['engine-unsupported', 'skill-unsupported', 'invented'])('shows nothing for the %s notice an earlier build stored in a transcript', code => {
    expect(renderToStaticMarkup(createElement(SkillNoticeView, { code }))).toBe('')
  })

  it('ignores unknown notice codes and does not promote arbitrary system content', () => {
    expect(parseSDKMessage({ type: 'system', subtype: 'skill_notice', skillNotice: 'invented', content: 'secret' })).toBeNull()
    expect(parseSDKMessage({ type: 'assistant', subtype: 'skill_notice', skillNotice: 'catalog-unavailable' })).toBeNull()
    expect(parseSDKMessage({ type: 'system', subtype: 'skill_notice', skillNotice: 'engine-unsupported' })).toBeNull()
  })
})
