/**
 * The collaboration of a conversation takes one line at the end of the chat:
 * its name, how many members and how many are working, and a way to the full
 * team. Nobody working right now does not make it finished.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollabSummary } from '../../../src/shared/apps/team-types'

const interpolate = (key: string, options?: Record<string, unknown>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name]))
let summary: CollabSummary | null | undefined
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: interpolate }) }))
vi.mock('../../../src/renderer/hooks/useCollabSummary', () => ({ useCollabSummary: () => summary }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: { openTeam: vi.fn() } }))

import { TeamCollabPanel } from '../../../src/renderer/components/chat/team-collab/TeamCollabPanel'

const member = (name: string, status: CollabSummary['members'][number]['status']) => ({ appId: name, memberName: name, role: 'Reviewer', status, currentTaskTitle: `${name}'s task` })
const render = () => renderToStaticMarkup(createElement(TeamCollabPanel, { conversationId: 'conversation' }))

describe('team summary in the chat', () => {
  beforeEach(() => {
    summary = {
      teamId: 'team', name: 'Release review', goal: 'Review the release', epochId: 'epoch', active: true, saved: false,
      members: [
        ...Array.from({ length: 10 }, (_, i) => member(`idle-${i}`, 'idle')),
        member('a', 'working'), member('b', 'working'), member('c', 'working'),
      ],
    }
  })

  it('is one line: name, member count, who is working, and the way to the team', () => {
    const html = render()
    expect(html).toContain('aria-label="Release review"')
    expect(html).toContain('13 members, 3 working')
    expect(html).toContain('View team')
    // The roster lives in the team view, not in the chat.
    expect(html).not.toContain('idle-0')
    expect(html).not.toContain('a&#x27;s task')
  })

  it('says nobody is working without calling the team finished', () => {
    summary = { ...summary!, members: summary!.members.map(m => ({ ...m, status: 'idle' as const })) }
    expect(render()).toContain('13 members, 0 working')
    expect(render()).not.toContain('finished')
  })

  it('calls it finished only once the collaboration is sealed', () => {
    summary = { ...summary!, active: false }
    expect(render()).toContain('13 members, finished')
  })

  it('shows nothing without a team', () => {
    summary = null
    expect(render()).toBe('')
  })
})
