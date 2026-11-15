import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (value: string) => value }),
}))
const remote = vi.hoisted(() => ({ value: false }))
vi.mock('../../../src/renderer/api', () => ({ api: { isRemoteMode: () => remote.value } }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: { getState: () => ({ openProxySettings: vi.fn() }) } }))

import { describeAgentError } from '../../../src/renderer/components/chat/agent-error-text'
import { TurnErrorBubble } from '../../../src/renderer/components/chat/TurnErrorBubble'
import { proxyRequiredText } from '../../../src/renderer/utils/proxy-required-text'
import { proxyRequiredMessage } from '../../../src/shared/constants/proxy-required'

const t = (key: string, options?: Record<string, unknown>) =>
  Object.entries(options ?? {}).reduce((text, [name, value]) => text.replace(`{{${name}}}`, String(value)), key)

const wrapped = (message: string) => `API Error: 503 ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}`

describe('a proxy-required refusal', () => {
  it.each(['none', 'bypassed', 'unreachable'] as const)('is read in the interface language wherever an engine wrapped it: %s', reason => {
    const error = wrapped(proxyRequiredMessage(reason, reason === 'unreachable' ? '127.0.0.1:7890' : undefined))
    const text = proxyRequiredText(error, t)
    expect(text).toContain('connect only through a proxy')
    expect(text).not.toContain('[proxy-required')
    expect(describeAgentError(error, t)).toEqual({ text, expandable: true })
  })

  it('names the proxy that could not be reached', () => {
    expect(proxyRequiredText(proxyRequiredMessage('unreachable', '127.0.0.1:7890'), t)).toContain('127.0.0.1:7890')
  })

  it('leaves every other error alone', () => {
    expect(proxyRequiredText('API Error: 503 upstream down', t)).toBeNull()
    expect(describeAgentError('plain failure', t)).toEqual({ text: 'plain failure', expandable: false })
  })

  it('offers the way to the proxy settings, on the desktop only', () => {
    const error = wrapped(proxyRequiredMessage('none'))
    remote.value = false
    expect(renderToStaticMarkup(createElement(TurnErrorBubble, { error }))).toContain('Open proxy settings')
    remote.value = true
    expect(renderToStaticMarkup(createElement(TurnErrorBubble, { error }))).not.toContain('Open proxy settings')
    expect(renderToStaticMarkup(createElement(TurnErrorBubble, { error: 'plain failure' }))).not.toContain('Open proxy settings')
  })
})
