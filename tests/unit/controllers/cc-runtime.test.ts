import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getConfig, recordAgentEngineChoice, saveConfig } from '../../../src/main/foundation/config.service'
import { DEFAULT_MAX_TURNS } from '../../../src/shared/constants/agent-limits'
import type { EngineId } from '../../../src/shared/types/engine'
import type { RuntimeId } from '../../../src/shared/types/external-runtime'

const runtime = vi.hoisted(() => ({ install: vi.fn(), select: vi.fn(), defaultEngine: 'halo' as EngineId }))
vi.mock('../../../src/main/services/agent', () => ({ getDefaultEngine: () => runtime.defaultEngine }))
vi.mock('../../../src/main/services/external-runtime', () => ({
  installExternalRuntime: runtime.install,
  selectExternalRuntime: runtime.select,
  getExternalRuntimeStatus: async () => ({ install: { phase: 'complete' } }),
  RuntimeError: class extends Error { constructor(readonly code: string) { super(code) } },
}))
vi.mock('../../../src/main/foundation/credential-safety', () => ({ isCredentialAtRestSafe: () => false }))

import { ccRuntimeResponse, installCcRuntimeForUse, selectCcRuntimeForUse } from '../../../src/main/controllers/cc-runtime.controller'
import {
  externalRuntimeResponse, installExternalRuntimeForUse, recordExternalRuntimeIntent, selectExternalRuntimeForUse,
} from '../../../src/main/controllers/external-runtime.controller'
import { RuntimeError } from '../../../src/main/services/external-runtime'

beforeEach(() => {
  runtime.install.mockReset()
  runtime.select.mockReset()
  runtime.defaultEngine = 'halo'
  saveConfig({ agent: { maxTurns: DEFAULT_MAX_TURNS, sdkEngine: 'halo', legacySdkEngine: undefined } })
})

for (const runtimeId of ['anthropic', 'codex'] as const) describe(`${runtimeId} explicit external engine activation`, () => {
  it('activates an installed engine without relying on an open settings panel', async () => {
    runtime.install.mockResolvedValue({ path: '/owned/runtime' })
    await installExternalRuntimeForUse(runtimeId, { version: '2.1.310' })
    expect(getConfig().agent?.sdkEngine).toBe(runtimeId)
  })

  it('selects a checked local installation', async () => {
    runtime.select.mockResolvedValue({ path: '/local/runtime' })
    await selectExternalRuntimeForUse(runtimeId, '/local/runtime')
    expect(runtime.select).toHaveBeenCalledWith(runtimeId, '/local/runtime')
    expect(getConfig().agent?.sdkEngine).toBe(runtimeId)
  })

  it('pins the available previous default before the external engine becomes the default', async () => {
    saveConfig({ agent: { maxTurns: DEFAULT_MAX_TURNS, sdkEngine: 'dsh' } })
    runtime.defaultEngine = 'halo'
    runtime.select.mockResolvedValue({ path: '/local/runtime' })
    await selectExternalRuntimeForUse(runtimeId, '/local/runtime')
    expect(getConfig().agent).toMatchObject({ sdkEngine: runtimeId, legacySdkEngine: 'halo' })
  })

  it('preserves the original legacy baseline across later activations', async () => {
    saveConfig({ agent: { maxTurns: DEFAULT_MAX_TURNS, legacySdkEngine: 'codex' } })
    runtime.install.mockResolvedValue({ path: '/owned/runtime' })
    await installExternalRuntimeForUse(runtimeId, {})
    expect(getConfig().agent?.legacySdkEngine).toBe('codex')
  })

  it('does not invent a legacy transition when only the installation changes', async () => {
    saveConfig({ agent: { maxTurns: DEFAULT_MAX_TURNS, sdkEngine: runtimeId } })
    runtime.select.mockResolvedValue({ path: '/local/runtime' })
    await selectExternalRuntimeForUse(runtimeId, '/local/runtime')
    expect(getConfig().agent?.legacySdkEngine).toBeUndefined()
  })

  it.each(['dsh', 'halo'] as const)('keeps the later %s choice even if the user changes back', async finalEngine => {
    let complete!: () => void
    runtime.install.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
    const install = installExternalRuntimeForUse(runtimeId, {})
    saveConfig({ agent: { maxTurns: DEFAULT_MAX_TURNS, sdkEngine: 'dsh' } })
    saveConfig({ agent: { maxTurns: DEFAULT_MAX_TURNS, sdkEngine: finalEngine } })
    complete()
    await install
    expect(getConfig().agent?.sdkEngine).toBe(finalEngine)
  })

  it('keeps the engine on a failed or cancelled install and releases the listener', async () => {
    runtime.install.mockRejectedValueOnce(new RuntimeError('cancelled'))
    await expect(installExternalRuntimeForUse(runtimeId, {})).rejects.toMatchObject({ code: 'cancelled' })
    expect(getConfig().agent?.sdkEngine).toBe('halo')
    runtime.install.mockResolvedValueOnce({ path: '/owned/runtime' })
    await installExternalRuntimeForUse(runtimeId, {})
    expect(getConfig().agent?.sdkEngine).toBe(runtimeId)
  })

  it('keeps a newer explicit Halo choice even when its stored value never changed', async () => {
    let complete!: () => void
    runtime.install.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
    const installing = installExternalRuntimeForUse(runtimeId, {})
    recordAgentEngineChoice()
    complete()
    await installing
    expect(getConfig().agent?.sdkEngine).toBe('halo')
    expect(getConfig().agent?.legacySdkEngine).toBeUndefined()
  })

  it('captures activation intent before installation prepares preferences asynchronously', async () => {
    let prepared!: () => void
    const request = { preferences: { sourceId: 'custom', sources: [{ id: 'custom', name: 'Mirror', baseUrl: 'https://mirror.example.test' }] } }
    runtime.install.mockImplementation(() => new Promise<void>(resolve => { prepared = resolve }))
    const installing = installExternalRuntimeForUse(runtimeId, request)
    expect(runtime.install).toHaveBeenCalledWith(runtimeId, request)
    recordAgentEngineChoice()
    prepared()
    await installing
    expect(getConfig().agent?.sdkEngine).toBe('halo')
  })

  it('does not activate after preferences failed to save', async () => {
    runtime.install.mockRejectedValue(new RuntimeError('invalid-source'))
    await expect(installExternalRuntimeForUse(runtimeId, { preferences: { sourceId: 'missing' } })).rejects.toMatchObject({ code: 'invalid-source' })
    expect(getConfig().agent?.sdkEngine).toBe('halo')
  })
})

describe('shared external engine choice ordering', () => {
  it.each([
    ['anthropic', 'codex'], ['codex', 'anthropic'],
  ] as const)('keeps the newer %s → %s install intent when the older request finishes last', async (older, newer) => {
    const completions = new Map<RuntimeId, () => void>()
    runtime.install.mockImplementation((runtimeId: RuntimeId) => new Promise<void>(resolve => completions.set(runtimeId, resolve)))
    const first = installExternalRuntimeForUse(older, {})
    const second = installExternalRuntimeForUse(newer, {})
    completions.get(newer)!()
    await second
    expect(getConfig().agent?.sdkEngine).toBe(newer)
    completions.get(older)!()
    await first
    expect(getConfig().agent?.sdkEngine).toBe(newer)
  })

  it('records an unconfigured card choice without changing the working default', async () => {
    let complete!: () => void
    runtime.install.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
    const first = installExternalRuntimeForUse('anthropic', {})
    recordExternalRuntimeIntent('codex')
    expect(getConfig().agent?.sdkEngine).toBe('halo')
    complete()
    await first
    expect(getConfig().agent?.sdkEngine).toBe('halo')
  })

  it('does not let an older local check override a newer same-engine selection', async () => {
    let complete!: () => void
    runtime.select.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve })).mockResolvedValueOnce({})
    const first = selectExternalRuntimeForUse('codex', '/old')
    await selectExternalRuntimeForUse('codex', '/new')
    saveConfig({ agent: { maxTurns: DEFAULT_MAX_TURNS, sdkEngine: 'halo' } })
    complete()
    await first
    expect(getConfig().agent?.sdkEngine).toBe('halo')
  })

  it('retains the CC compatibility entry points over the same controller', async () => {
    runtime.install.mockResolvedValue({})
    runtime.select.mockResolvedValue({})
    await installCcRuntimeForUse({})
    await selectCcRuntimeForUse('/cc')
    expect(runtime.install).toHaveBeenCalledWith('anthropic', {})
    expect(runtime.select).toHaveBeenCalledWith('anthropic', '/cc')
  })
})

describe('operation responses', () => {
  it('preserves structured domain issues and the CC-compatible error message', async () => {
    expect(await ccRuntimeResponse('lookup', () => { throw new RuntimeError('version-not-found') })).toEqual({
      success: false, issue: 'version-not-found', error: 'cc-runtime:version-not-found',
    })
  })

  it('does not expose unexpected exception details to the client', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await ccRuntimeResponse('lookup', () => { throw new Error('private-path-or-credential') })).toEqual({ success: false, error: 'Claude Code operation failed' })
      expect(await externalRuntimeResponse('lookup', () => { throw new Error('private-path-or-credential') })).toEqual({ success: false, error: 'Runtime operation failed' })
      expect(log).toHaveBeenCalledWith('[ExternalRuntime] Operation failed unexpectedly', { activity: 'lookup', name: 'Error' })
    } finally { log.mockRestore() }
  })
})
