import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getConfig, recordAgentEngineChoice, saveConfig } from '../../../src/main/foundation/config.service'
import { DEFAULT_MAX_TURNS } from '../../../src/shared/constants/agent-limits'
import type { EngineId } from '../../../src/shared/types/engine'

const runtime = vi.hoisted(() => ({ install: vi.fn(), select: vi.fn(), configure: vi.fn(), defaultEngine: 'halo' as EngineId }))
vi.mock('../../../src/main/services/agent', () => ({ getDefaultEngine: () => runtime.defaultEngine }))
vi.mock('../../../src/main/services/cc-runtime', () => ({
  installCcRuntime: runtime.install,
  selectCcInstallation: runtime.select,
  configureCcRuntime: runtime.configure,
  getCcRuntimeStatus: async () => ({ install: { phase: 'complete' } }),
  CcRuntimeError: class extends Error { constructor(readonly code: string) { super(`cc-runtime:${code}`) } },
}))
vi.mock('../../../src/main/foundation/credential-safety', () => ({ isCredentialAtRestSafe: () => false }))

import { ccRuntimeResponse, installCcRuntimeForUse, selectCcRuntimeForUse } from '../../../src/main/controllers/cc-runtime.controller'
import { CcRuntimeError } from '../../../src/main/services/cc-runtime'

beforeEach(() => {
  runtime.install.mockReset()
  runtime.select.mockReset()
  runtime.configure.mockReset().mockResolvedValue({})
  runtime.defaultEngine = 'halo'
  saveConfig({ agent: { maxTurns: DEFAULT_MAX_TURNS, sdkEngine: 'halo', legacySdkEngine: undefined } })
})

describe('explicit external engine activation', () => {
  it('activates an installed engine without relying on an open settings panel', async () => {
    runtime.install.mockResolvedValue({ path: '/owned/claude' })
    await installCcRuntimeForUse({ version: '2.1.310' })
    expect(getConfig().agent?.sdkEngine).toBe('anthropic')
  })

  it('selects a checked local installation', async () => {
    runtime.select.mockResolvedValue({ path: '/local/claude' })
    await selectCcRuntimeForUse('/local/claude')
    expect(runtime.select).toHaveBeenCalledWith('/local/claude')
    expect(getConfig().agent?.sdkEngine).toBe('anthropic')
  })

  it('pins the available previous default before CC becomes the default', async () => {
    saveConfig({ agent: { maxTurns: DEFAULT_MAX_TURNS, sdkEngine: 'codex' } })
    runtime.defaultEngine = 'halo'
    runtime.select.mockResolvedValue({ path: '/local/claude' })
    await selectCcRuntimeForUse('/local/claude')
    expect(getConfig().agent).toMatchObject({ sdkEngine: 'anthropic', legacySdkEngine: 'halo' })
  })

  it('preserves the original legacy baseline across later activations', async () => {
    saveConfig({ agent: { maxTurns: DEFAULT_MAX_TURNS, legacySdkEngine: 'codex' } })
    runtime.install.mockResolvedValue({ path: '/owned/claude' })
    await installCcRuntimeForUse({ version: '2.1.310' })
    expect(getConfig().agent?.legacySdkEngine).toBe('codex')
  })

  it('does not invent a legacy transition when only the CC installation changes', async () => {
    saveConfig({ agent: { maxTurns: DEFAULT_MAX_TURNS, sdkEngine: 'anthropic' } })
    runtime.select.mockResolvedValue({ path: '/local/claude' })
    await selectCcRuntimeForUse('/local/claude')
    expect(getConfig().agent?.legacySdkEngine).toBeUndefined()
  })

  it.each(['codex', 'halo'] as const)('keeps the later %s choice even if the user changes back', async finalEngine => {
    let complete!: () => void
    runtime.install.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
    const install = installCcRuntimeForUse({})
    saveConfig({ agent: { maxTurns: DEFAULT_MAX_TURNS, sdkEngine: 'codex' } })
    saveConfig({ agent: { maxTurns: DEFAULT_MAX_TURNS, sdkEngine: finalEngine } })
    complete()
    await install
    expect(getConfig().agent?.sdkEngine).toBe(finalEngine)
  })

  it('keeps the engine on a failed or cancelled install and releases the listener', async () => {
    runtime.install.mockRejectedValueOnce(new Error('cancelled'))
    await expect(installCcRuntimeForUse({})).rejects.toThrow('cancelled')
    expect(getConfig().agent?.sdkEngine).toBe('halo')
    runtime.install.mockResolvedValueOnce({ path: '/owned/claude' })
    await installCcRuntimeForUse({})
    expect(getConfig().agent?.sdkEngine).toBe('anthropic')
  })

  it('keeps a newer explicit Halo choice even when its stored value never changed', async () => {
    let complete!: () => void
    runtime.install.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
    const installing = installCcRuntimeForUse({ version: '2.1.310' })
    recordAgentEngineChoice()
    expect(getConfig().agent?.sdkEngine).toBe('halo')
    complete()
    await installing
    expect(getConfig().agent?.sdkEngine).toBe('halo')
    expect(getConfig().agent?.legacySdkEngine).toBeUndefined()
  })

  it('captures activation intent before asynchronous preference preparation', async () => {
    let configured!: () => void
    runtime.configure.mockImplementation(() => new Promise<void>(resolve => { configured = resolve }))
    runtime.install.mockResolvedValue({ path: '/owned/claude' })
    const preferences = { sourceId: 'custom', sources: [{ id: 'custom', name: 'Mirror', baseUrl: 'https://mirror.example.test' }] }
    const request = { version: '2.1.310', sourceId: 'custom', preferences }
    const installing = installCcRuntimeForUse(request)
    expect(runtime.configure).toHaveBeenCalledWith(preferences)
    expect(runtime.install).not.toHaveBeenCalled()
    recordAgentEngineChoice()
    configured()
    await installing
    expect(runtime.install).toHaveBeenCalledWith(request)
    expect(getConfig().agent?.sdkEngine).toBe('halo')
  })

  it('does not start a download after preferences failed to save', async () => {
    runtime.configure.mockRejectedValue(new CcRuntimeError('invalid-source'))
    await expect(installCcRuntimeForUse({ preferences: { sourceId: 'missing' } })).rejects.toMatchObject({ code: 'invalid-source' })
    expect(runtime.install).not.toHaveBeenCalled()
    expect(getConfig().agent?.sdkEngine).toBe('halo')
  })
})

describe('CC operation responses', () => {
  it('preserves structured domain issues and the compatible error message', async () => {
    expect(await ccRuntimeResponse('lookup', () => { throw new CcRuntimeError('version-not-found') })).toEqual({
      success: false, issue: 'version-not-found', error: 'cc-runtime:version-not-found'
    })
  })

  it('does not expose unexpected exception details to the client', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await ccRuntimeResponse('lookup', () => { throw new Error('private-path-or-credential') })).toEqual({
        success: false, error: 'Claude Code operation failed'
      })
      expect(log).toHaveBeenCalledWith('[CcRuntime] lookup failed unexpectedly:', expect.any(Error))
    } finally { log.mockRestore() }
  })
})
