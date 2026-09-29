/**
 * Whose model the header shows: a regular conversation's own pin, or — with a
 * digital human on screen — that digital human's configured model, never a
 * conversation's.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: {} }))
vi.mock('../../../../src/renderer/stores/team.store', () => ({ isRemoteMemberAppId: () => false }))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (s: string) => s }, getCurrentLanguage: () => 'en', useTranslation: () => ({ t: (s: string) => s }) }))

import { resolveActiveModelTarget } from '../../../../src/renderer/hooks/useActiveModelTarget'
import type { Conversation } from '../../../../src/renderer/types'

const app = {
  spec: { name: 'Analyst', spec_version: '1', version: '1', type: 'automation' },
  userOverrides: { modelSourceId: 'src-1', modelId: 'model-x' },
} as never

describe('resolveActiveModelTarget', () => {
  it('targets the digital human when one is on screen, with its own settings', () => {
    const target = resolveActiveModelTarget('app-chat:a1', null, app)
    expect(target).toMatchObject({ kind: 'digital-human', appId: 'a1', appName: 'Analyst', modelSourceId: 'src-1', modelId: 'model-x' })
  })

  it('targets a local session of a digital human the same way', () => {
    expect(resolveActiveModelTarget('app-chat:a1:local:direct:u1', null, app).kind).toBe('digital-human')
  })

  it('falls back to the global model when the digital human sets none', () => {
    const target = resolveActiveModelTarget('app-chat:a1', null, { ...(app as object), userOverrides: {} } as never)
    expect(target).toMatchObject({ kind: 'digital-human', modelSourceId: undefined, modelId: undefined })
  })

  it('targets the regular conversation otherwise, with the id the pin is written to', () => {
    const conversation = { id: 'c1', modelSourceId: 's', modelId: 'm' } as Conversation
    expect(resolveActiveModelTarget('c1', conversation, undefined)).toEqual({ kind: 'conversation', conversationId: 'c1', conversation })
  })

  it('has nothing to write to when no conversation is active', () => {
    expect(resolveActiveModelTarget(null, null, undefined)).toEqual({ kind: 'conversation', conversationId: null, conversation: null })
  })
})
