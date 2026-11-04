import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ config: { agent: { ccRuntime: { selectedPath: '/legacy/claude' } } }, openSettings: vi.fn() }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/api', () => ({ api: { isRemoteMode: () => false } }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: (select: any) => select({ config: state.config, openClaudeCodeSettings: state.openSettings }) }))
vi.mock('../../../src/renderer/stores/engine.store', () => ({ useEngineId: (id: string) => id }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: vi.fn() }))
vi.mock('../../../src/renderer/hooks/useActiveModelTarget', () => ({ useActiveModelTarget: () => ({ kind: 'digital-human', appId: 'person' }) }))
vi.mock('../../../src/renderer/hooks/useEngineAvailability', () => ({ useEngineAvailability: () => ({ engines: [{ engineId: 'anthropic', available: false }] }) }))
vi.mock('../../../src/renderer/hooks/useConversationEngine', () => ({ saveConversationEngineOverride: vi.fn() }))
vi.mock('../../../src/renderer/utils/people-navigation', () => ({ openPersonModelSettings: vi.fn() }))
vi.mock('../../../src/renderer/components/ai-config/ModelSelector', () => ({ ModelSelectSheet: () => null }))

import { EngineRecoveryNotice } from '../../../src/renderer/components/settings/EngineRecoveryNotice'

describe('Claude Code reselection recovery notice', () => {
  it('explains same-installation reselection to an explicitly selected digital human and retains the settings action', () => {
    const html = renderToStaticMarkup(createElement(EngineRecoveryNotice, { engineId: 'anthropic' }))
    expect(html).toContain('Select a Claude Code installation once in Settings')
    expect(html).toContain('same installation is already listed')
    expect(html).toContain('Your history and engine choice are kept')
    expect(html).toContain('Select Claude Code in Settings')
    expect(state.openSettings).not.toHaveBeenCalled()
  })
})
