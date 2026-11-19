import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { Message } from '../../../src/renderer/types'
import { WORKSPACE_NOTICE_TEXT } from '../../../src/shared/transcript'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
import { ContinuityNotice, isContinuityNotice } from '../../../src/renderer/components/chat/ContinuityNotice'

it.each(['deleted', 'missing'] as const)('renders the %s change as a system timeline notice', kind => {
  const message = { id: 'notice', role: 'system', source: 'workspace-notice', content: WORKSPACE_NOTICE_TEXT[kind] } as Message
  expect(isContinuityNotice(message)).toBe(true)
  const html = renderToStaticMarkup(createElement(ContinuityNotice, { message }))
  expect(html).toContain('data-message-id="notice"')
  expect(html).toContain(kind === 'deleted' ? 'with its memory and history' : 'may be unavailable')
  expect(html).not.toContain('message-assistant')
  expect(isContinuityNotice({ ...message, role: 'user' })).toBe(false)
})
