/**
 * The question a digital human asks is Markdown like the rest of what it
 * writes: a single question, each of several, and the answered record all go
 * through the Markdown renderer instead of showing `**` and `-` as typed.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityEntry } from '../../../src/shared/apps/app-types'

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string) => text, i18n: { language: 'en' } }),
}))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/stores/apps.store', () => {
  const state = { activityEntries: {} }
  const useAppsStore = (select: (value: typeof state) => unknown) => select(state)
  useAppsStore.getState = () => state
  return { useAppsStore }
})
vi.mock('../../../src/renderer/stores/people-view.store', () => {
  const state = { drafts: {}, saveDraft: vi.fn(), clearDraft: vi.fn() }
  const usePeopleViewStore = (select: (value: typeof state) => unknown) => select(state)
  usePeopleViewStore.getState = () => state
  return { usePeopleViewStore }
})
vi.mock('../../../src/renderer/hooks/useDataContent', () => ({ useDataContent: () => undefined }))
vi.mock('../../../src/renderer/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => createElement('div', { 'data-markdown': content }),
}))

import { EscalationCard } from '../../../src/renderer/components/apps/EscalationCard'

function render(content: ActivityEntry['content'], userResponse?: ActivityEntry['userResponse']): string {
  const entry: ActivityEntry = { id: 'q-1', appId: 'app-1', runId: 'run-1', type: 'escalation', ts: 0, content, userResponse }
  return renderToStaticMarkup(createElement(EscalationCard, { entry, appId: 'app-1' }))
}

describe('EscalationCard question text', () => {
  it('renders a single question as Markdown', () => {
    const html = render({ summary: 'Ship **v2** today?', question: 'Ship **v2** today?', choices: ['Yes', 'No'] })

    expect(html).toContain('data-markdown="Ship **v2** today?"')
  })

  it('renders each of several questions as Markdown', () => {
    const html = render({
      summary: 'Two things before I go on:',
      questions: [{ question: '- Keep **A**?', choices: ['Yes'] }, { question: 'Use `B`?' }],
    })

    expect(html).toContain('data-markdown="Two things before I go on:"')
    expect(html).toContain('data-markdown="- Keep **A**?"')
    expect(html).toContain('data-markdown="Use `B`?"')
  })

  it('renders the answered record as Markdown too', () => {
    const html = render({ summary: 'Ship **v2** today?', question: 'Ship **v2** today?' }, { ts: 1, choice: 'Yes' })

    expect(html).toContain('data-markdown="Ship **v2** today?"')
  })
})
