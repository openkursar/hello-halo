import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CcRuntimeConfig } from '../../../src/shared/types/cc-runtime'
import type { AISourcesConfig } from '../../../src/shared/types/ai-sources'

const state = vi.hoisted(() => ({
  config: { agent: { sdkEngine: 'halo', ccRuntime: {} as CcRuntimeConfig }, aiSources: undefined as AISourcesConfig | undefined },
  check: vi.fn(), launch: vi.fn(),
}))
vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: () => state.config,
  getHaloDir: () => join(globalThis.__HALO_TEST_DIR__, '.halo'),
  saveConfig: (patch: typeof state.config) => { state.config = { ...state.config, ...patch } },
  getAgentEngineChoiceRevision: () => 0,
  onAgentConfigChange: () => () => {},
}))
vi.mock('../../../src/main/foundation/product-config', () => ({ getClaudeCodeDownloadSource: () => undefined }))
vi.mock('../../../src/main/services/agent', () => ({ getDefaultEngine: () => 'halo' }))
vi.mock('../../../src/main/services/proxy-fetch', () => ({ proxyFetch: vi.fn() }))
vi.mock('../../../src/main/services/cc-runtime/probe', () => ({
  checkInstallation: state.check, launchForInstallation: state.launch, readKnownInstallation: () => null,
}))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))

import { getCcRuntimeStatus } from '../../../src/main/services/cc-runtime'
import { selectCcRuntimeForUse } from '../../../src/main/controllers/cc-runtime.controller'
import { getEngineAvailability } from '../../../src/main/services/agent/engine-availability'
import { CcInstallationList } from '../../../src/renderer/components/settings/cc-runtime/InstallationList'
import { CcDownloadPanel } from '../../../src/renderer/components/settings/cc-runtime/DownloadPanel'

beforeEach(() => {
  vi.clearAllMocks()
  state.config = { agent: { sdkEngine: 'halo', ccRuntime: { selectedPath: '/legacy/claude', discoveryCompleted: true } }, aiSources: undefined }
  state.check.mockImplementation(async path => ({ path, version: '2.1.310', kind: 'native', compatibility: 'verified', managed: false, recommended: true }))
  state.launch.mockResolvedValue({ path: '/legacy/claude', version: '2.1.310' })
})

describe('explicit reselection of an automatic Claude Code path', () => {
  it('keeps the same installation selectable, validates it and activates the default without relaxing availability', async () => {
    const before = await getCcRuntimeStatus()
    expect(before.selectedPath).toBeUndefined()
    expect(before.selected).toBeNull()
    expect(before.installations).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/legacy/claude' })]))
    expect((await getEngineAvailability(['anthropic']))[0]).toMatchObject({ available: false, reason: expect.stringContaining('Select an installation once in the Halo desktop app under Settings > Advanced') })
    expect(state.check).not.toHaveBeenCalled()
    expect(state.launch).not.toHaveBeenCalled()
    const list = renderToStaticMarkup(createElement(CcInstallationList, { installations: before.installations, selectedPath: before.selectedPath, onSelect: vi.fn(), onCheck: vi.fn() }))
    expect(list).toContain('Use this version')
    expect(list).not.toContain('disabled=""')
    const download = renderToStaticMarkup(createElement(CcDownloadPanel, {
      status: { ...before, installations: [{ ...before.installations[0], version: before.recommendedVersion }] },
      busy: false, installing: false, onSelect: vi.fn(), onInstall: vi.fn(), onRefresh: vi.fn(), onFindLocal: vi.fn(),
    }))
    expect(download).toContain('Use installed version')
    expect(download).not.toContain('>Selected<')

    const after = await selectCcRuntimeForUse('/legacy/claude')
    expect(state.check).toHaveBeenCalledWith('/legacy/claude')
    expect(state.config.agent).toMatchObject({ sdkEngine: 'anthropic', ccRuntime: { selectedPath: '/legacy/claude', selectionOrigin: 'user' } })
    expect(after.selectedPath).toBe('/legacy/claude')
    expect(after.selected?.path).toBe('/legacy/claude')
    expect((await getEngineAvailability(['anthropic']))[0].available).toBe(true)
    expect(state.launch).toHaveBeenCalledWith('/legacy/claude', expect.any(Object))
  })

  it('does not mark a failed same-path check as user selection or change the default', async () => {
    state.check.mockResolvedValue({ path: '/legacy/claude', compatibility: 'unavailable', issue: 'not-found', managed: false, recommended: false })
    await expect(selectCcRuntimeForUse('/legacy/claude')).rejects.toMatchObject({ code: 'not-found' })
    expect(state.config.agent).toMatchObject({ sdkEngine: 'halo', ccRuntime: { selectedPath: '/legacy/claude' } })
    expect(state.config.agent.ccRuntime.selectionOrigin).toBeUndefined()
    expect((await getEngineAvailability(['anthropic']))[0].available).toBe(false)
    expect(state.launch).not.toHaveBeenCalled()
  })

  it.each(['user', 'delegated', 'unselected-delegated'] as const)('uses the existing explicit-selection rule for %s', async choice => {
    if (choice === 'user') state.config.agent.ccRuntime.selectionOrigin = 'user'
    else state.config.aiSources = { version: 2, currentId: choice === 'delegated' ? 'cli' : 'other', sources: [{ id: 'cli', provider: 'claude-cli', authType: 'delegated' }] } as AISourcesConfig
    expect((await getCcRuntimeStatus()).selectedPath).toBe(choice === 'unselected-delegated' ? undefined : '/legacy/claude')
    expect(state.check).not.toHaveBeenCalled()
    expect(state.launch).not.toHaveBeenCalled()
  })
})
