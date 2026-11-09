import { beforeEach, describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AISourcesConfig } from '../../../src/shared/types/ai-sources'
import type { CcRuntimeConfig } from '../../../src/shared/types/cc-runtime'
import type { EngineId } from '../../../src/shared/types/engine'

const env = vi.hoisted(() => ({
  engine: 'anthropic' as EngineId,
  requested: 'anthropic' as EngineId,
  ccRuntime: undefined as CcRuntimeConfig | undefined,
  sources: undefined as AISourcesConfig | undefined,
  selectedSourceId: undefined as string | undefined,
  remote: false,
}))

vi.mock('../../../src/renderer/api', () => ({ api: { isRemoteMode: () => env.remote } }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/stores/app.store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({
    config: { agent: { sdkEngine: env.requested, ccRuntime: env.ccRuntime }, aiSources: env.sources },
    navigate: vi.fn(), openClaudeCodeSettings: vi.fn(),
  }),
}))
vi.mock('../../../src/renderer/stores/engine.store', () => ({ useEngineId: () => env.engine }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: {} }))
vi.mock('../../../src/renderer/hooks/useActiveModelTarget', () => ({
  useActiveModelTarget: () => ({ kind: 'digital-human', appId: 'test-app', modelSourceId: env.selectedSourceId }),
}))
vi.mock('../../../src/renderer/hooks/useEngineAvailability', () => ({
  useEngineAvailability: () => ({ engines: [{ engineId: 'anthropic', available: false }] }),
}))
vi.mock('../../../src/renderer/hooks/useConversationEngine', () => ({ saveConversationEngineOverride: vi.fn() }))
vi.mock('../../../src/renderer/utils/people-navigation', () => ({ openPersonModelSettings: vi.fn() }))
vi.mock('../../../src/renderer/components/ai-config/ModelSelector', () => ({ ModelSelectSheet: () => null }))

import { EngineRecoveryNotice } from '../../../src/renderer/components/settings/EngineRecoveryNotice'
import { resolveEngineIssue, resolveEngineNotice } from '../../../src/renderer/components/settings/engine-issue'

describe('the recovery message shown in the conversation', () => {
  beforeEach(() => {
    env.engine = 'anthropic'
    env.requested = 'anthropic'
    env.ccRuntime = undefined
    env.sources = undefined
    env.selectedSourceId = undefined
    env.remote = false
  })

  it('asks desktop users to explicitly select the listed Claude Code installation', () => {
    const html = renderToStaticMarkup(createElement(EngineRecoveryNotice))
    expect(html).toContain('Select a Claude Code installation once')
    expect(html).toContain('Select Claude Code in Settings')
    expect(html).toContain('Continue with Halo SDK')
    expect(html).not.toContain('Install or connect Claude Code')
  })

  it('directs remote users to the host desktop without offering host settings locally', () => {
    env.remote = true
    const html = renderToStaticMarkup(createElement(EngineRecoveryNotice))
    expect(html).toContain('In the Halo desktop app on the host computer')
    expect(html).toContain('Continue with Halo SDK')
    expect(html).not.toContain('Select Claude Code in Settings')
    expect(html).not.toContain('Install or connect Claude Code')
  })

  it('keeps the missing-installation explanation after an explicit selection', () => {
    env.ccRuntime = { selectedPath: '/fixture/claude', selectionOrigin: 'user' }
    const html = renderToStaticMarkup(createElement(EngineRecoveryNotice))
    expect(html).toContain('which is not available on this computer')
    expect(html).toContain('Install or connect Claude Code')
    expect(html).not.toContain('Select a Claude Code installation once')
  })

  it('retains the separate explanation for a group on Codex', () => {
    env.engine = 'codex'
    env.selectedSourceId = 'group'
    env.sources = {
      version: 2, currentId: null, sources: [],
      groups: [{ id: 'group', name: 'Daily', strategy: 'priority', members: [], createdAt: '', updatedAt: '' }],
    }
    const html = renderToStaticMarkup(createElement(EngineRecoveryNotice))
    expect(html).toContain('Codex cannot use a load-balancing group')
    expect(html).toContain('Choose another model')
    expect(html).not.toContain('Select a Claude Code installation once')
  })

  it('does not call a historical default an explicit fallback', () => {
    env.engine = 'halo'
    expect(renderToStaticMarkup(createElement(EngineRecoveryNotice))).toBe('')
  })
})

describe('why a conversation cannot run as configured', () => {
  it('asks a Claude Code login account to connect Claude Code while it is missing', () => {
    expect(resolveEngineIssue({ engine: 'halo', delegated: true, accountCompatible: false, ccAvailable: false })).toBe('account-needs-cc')
    expect(resolveEngineIssue({ engine: 'halo', delegated: true, accountCompatible: false })).toBe('account-needs-cc')
    expect(resolveEngineIssue({ engine: 'anthropic', delegated: true, accountCompatible: true, ccAvailable: false })).toBe('account-needs-cc')
  })

  it('offers to move a Claude Code login account onto Claude Code once it is there', () => {
    expect(resolveEngineIssue({ engine: 'halo', delegated: true, accountCompatible: false, ccAvailable: true })).toBe('account-cc-ready')
    expect(resolveEngineIssue({ engine: 'anthropic', delegated: true, accountCompatible: true, ccAvailable: true })).toBeNull()
  })

  it('tells a conversation on Claude Code that it is missing, only once that is known', () => {
    expect(resolveEngineIssue({ engine: 'anthropic', delegated: false, accountCompatible: true, ccAvailable: false })).toBe('cc-missing')
    expect(resolveEngineIssue({ engine: 'anthropic', delegated: false, accountCompatible: true })).toBeNull()
    expect(resolveEngineIssue({ engine: 'halo', delegated: false, accountCompatible: true, ccAvailable: false })).toBeNull()
  })

  it('keeps the Codex account explanation', () => {
    expect(resolveEngineIssue({ engine: 'codex', delegated: false, accountCompatible: false })).toBe('codex-account')
  })

  it('tells a load-balancing group apart from an account Codex cannot use', () => {
    expect(resolveEngineIssue({ engine: 'codex', delegated: false, accountCompatible: false, group: true })).toBe('codex-group')
    expect(resolveEngineIssue({ engine: 'codex', delegated: false, accountCompatible: false, group: false })).toBe('codex-account')
    expect(resolveEngineIssue({ engine: 'halo', delegated: false, accountCompatible: true, group: true })).toBeNull()
  })
})

describe('which note an engine failure gets', () => {
  it('an old conversation still on Claude Code while the chat resolves Halo SDK: the general note', () => {
    const issue = resolveEngineIssue({ engine: 'halo', delegated: false, accountCompatible: true, ccAvailable: false })
    expect(resolveEngineNotice({ issue, failed: true, fellBack: false, dismissed: false })).toEqual({ kind: 'failure' })
  })

  it('Claude Code gone after an earlier read said it was there: the reread names it, and without one the general note remains', () => {
    const stale = resolveEngineIssue({ engine: 'anthropic', delegated: false, accountCompatible: true, ccAvailable: true })
    expect(resolveEngineNotice({ issue: stale, failed: true, fellBack: false, dismissed: false })).toEqual({ kind: 'failure' })
    const reread = resolveEngineIssue({ engine: 'anthropic', delegated: false, accountCompatible: true, ccAvailable: false })
    expect(resolveEngineNotice({ issue: reread, failed: true, fellBack: false, dismissed: false })).toEqual({ kind: 'issue', issue: 'cc-missing' })
  })

  it('Claude Code passes its check but cannot be loaded: the general note, even if the fallback note was hidden', () => {
    const issue = resolveEngineIssue({ engine: 'anthropic', delegated: false, accountCompatible: true, ccAvailable: true })
    expect(resolveEngineNotice({ issue, failed: true, fellBack: true, dismissed: true })).toEqual({ kind: 'failure' })
  })

  it('shows nothing new without a failure', () => {
    expect(resolveEngineNotice({ issue: null, failed: false, fellBack: false, dismissed: false })).toBeNull()
    expect(resolveEngineNotice({ issue: null, failed: false, fellBack: true, dismissed: true })).toBeNull()
    expect(resolveEngineNotice({ issue: null, failed: false, fellBack: true, dismissed: false })).toEqual({ kind: 'fell-back' })
  })
})
