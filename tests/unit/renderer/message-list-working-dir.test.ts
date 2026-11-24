/**
 * The chat's error area: a turn that could not start because its folder is
 * gone shows the change-folder notice instead of the generic error bubble;
 * any other failure, or a surface that passes no folder, keeps the bubble.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string) => text }),
  getCurrentLanguage: () => 'en',
}))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: {} }))
vi.mock('../../../src/renderer/stores/canvas.store', () => {
  const state = {}
  return { useCanvasStore: (select: (value: typeof state) => unknown) => select(state) }
})
vi.mock('../../../src/renderer/components/chat/WorkingDirUnavailableNotice', () => ({
  WorkingDirUnavailableNotice: ({ issue }: { issue: { workDir: string } }) => createElement('aside', null, `notice:${issue.workDir}`),
}))
vi.mock('../../../src/renderer/components/chat/MessageRow', () => ({ MessageRow: () => null }))
vi.mock('../../../src/renderer/components/chat/StreamingSection', () => ({ StreamingSection: () => null }))
vi.mock('../../../src/renderer/stores/apps.store', () => {
  const state = { apps: [] }
  return { useAppsStore: (select: (value: typeof state) => unknown) => select(state) }
})
vi.mock('../../../src/renderer/stores/chat.store', () => {
  const state = { sessions: new Map() }
  return { useChatStore: (select: (value: typeof state) => unknown) => select(state) }
})

import { MessageList } from '../../../src/renderer/components/chat/MessageList'

const issue = { spaceId: 'space-1', workDir: '/Users/me/Desktop/Halo folder' }

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(MessageList, {
    messages: [], streamingContent: '', isGenerating: false, error: 'Working directory does not exist', ...props,
  } as never))
}

describe('the chat error area', () => {
  it('offers to change the folder when a turn could not start in it', () => {
    const html = render({ errorType: 'working_dir_unavailable', workDirIssue: issue })

    expect(html).toContain('notice:/Users/me/Desktop/Halo folder')
    expect(html).not.toContain('Something went wrong')
  })

  it('keeps the generic bubble for other failures and where no folder is passed', () => {
    expect(render({ errorType: null })).toContain('Something went wrong')
    expect(render({ errorType: 'working_dir_unavailable', workDirIssue: null })).toContain('Something went wrong')
  })
})
