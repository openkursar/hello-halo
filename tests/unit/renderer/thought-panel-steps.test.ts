/**
 * A reply's thought steps look the same while it runs and after it ends. Only
 * a running reply shows a step as in progress: saved steps can keep a stale
 * streaming flag or miss a result (a stopped turn), and must not read as
 * still working forever.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string) => text }),
  getCurrentLanguage: () => 'en',
}))
vi.mock('../../../src/renderer/components/chat/ArrivalCard', () => ({ ArrivalCard: () => null, arrivalIcon: () => () => null }))
vi.mock('../../../src/renderer/components/chat/tool-result', () => ({ ToolResultViewer: ({ output }: { output: string }) => createElement('output', {}, output) }))
vi.mock('../../../src/renderer/components/chat/SubAgentTimeline', () => ({ SubAgentTimeline: () => null }))
vi.mock('../../../src/renderer/components/tool/TodoCard', () => ({ TodoCard: () => null }))

import { ThoughtSteps } from '../../../src/renderer/components/chat/ThoughtPanel'
import type { Thought } from '../../../src/renderer/types'

const at = '2026-10-14T02:00:00.000Z'

function steps(thoughts: Thought[], live: boolean, hasTodos = false): string {
  return renderToStaticMarkup(createElement(ThoughtSteps, { steps: thoughts, childGroups: new Map(), live, hasTodos }))
}

describe('thought panel steps', () => {
  const unfinished: Thought[] = [
    { id: 'generating', type: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls' }, content: '', timestamp: at, isReady: false },
    { id: 'thinking', type: 'thinking', content: '', timestamp: at, isStreaming: true },
    { id: 'running', type: 'tool_use', toolName: 'Read', toolInput: { file_path: '/a.ts' }, content: '', timestamp: at },
  ]

  it('shows unfinished steps as in progress only while the reply runs', () => {
    const live = steps(unfinished, true)
    expect(live).toContain('Generating')
    expect(live).toContain('Running')

    const saved = steps(unfinished, false)
    expect(saved).not.toContain('Generating')
    expect(saved).not.toContain('Running')
    expect(saved).not.toContain('>...<')
  })

  it('draws a finished step identically while running and after the reply ends', () => {
    const done: Thought[] = [{
      id: 'done', type: 'tool_use', toolName: 'Bash', toolInput: { command: 'sleep 10; echo done' }, content: '', timestamp: at,
      toolResult: { output: 'done', isError: false, timestamp: at },
    }]
    expect(steps(done, true, true)).toBe(steps(done, false, true))
    // A finished step carries no status label; only pending or failed ones do.
    expect(steps(done, false, true)).not.toContain('Running')
    expect(steps(done, false, true)).toContain('Bash')
  })
})
