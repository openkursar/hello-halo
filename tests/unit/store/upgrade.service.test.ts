/**
 * upgrade.service unit tests.
 *
 * Covers checkNow dispatch: auto+patch/minor → applyUpgrade, auto+major and
 * notify/manual → emit only, per-app error isolation, concurrent coalescing,
 * and the manager-not-ready short circuit.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { getAppManagerMock, checkUpdatesMock, applyUpgradeMock, emitUpgradeAvailableMock } =
  vi.hoisted(() => ({
    getAppManagerMock: vi.fn(),
    checkUpdatesMock: vi.fn(),
    applyUpgradeMock: vi.fn(),
    emitUpgradeAvailableMock: vi.fn(),
  }))

vi.mock('../../../src/main/apps/manager', () => ({
  getAppManager: getAppManagerMock,
}))

vi.mock('../../../src/main/store/registry.service', () => ({
  checkUpdates: checkUpdatesMock,
  applyUpgrade: applyUpgradeMock,
  emitUpgradeAvailable: emitUpgradeAvailableMock,
}))

import { checkNow } from '../../../src/main/store/upgrade.service'

function update(overrides: Record<string, unknown> = {}) {
  return {
    appId: 'app-1',
    currentVersion: '1.0.0',
    latestVersion: '1.0.1',
    strategy: 'auto',
    severity: 'patch',
    ...overrides,
  }
}

function managerWith(apps: Array<{ id: string; status?: string }>) {
  return {
    listApps: () =>
      apps.map((a) => ({
        id: a.id,
        status: a.status ?? 'active',
        upgradeStrategy: 'auto',
        spec: { name: a.id, version: '1.0.0', store: {} },
      })),
  }
}

describe('upgrade.service checkNow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getAppManagerMock.mockReturnValue(managerWith([{ id: 'app-1' }]))
    applyUpgradeMock.mockResolvedValue(undefined)
  })

  it('auto + patch → applyUpgrade (silent)', async () => {
    checkUpdatesMock.mockResolvedValue([update({ strategy: 'auto', severity: 'patch' })])
    const result = await checkNow()
    expect(applyUpgradeMock).toHaveBeenCalledWith('app-1', 'patch_minor')
    expect(emitUpgradeAvailableMock).not.toHaveBeenCalled()
    expect(result.autoApplied).toBe(1)
  })

  it('auto + minor → applyUpgrade (silent)', async () => {
    checkUpdatesMock.mockResolvedValue([update({ strategy: 'auto', severity: 'minor' })])
    await checkNow()
    expect(applyUpgradeMock).toHaveBeenCalledWith('app-1', 'patch_minor')
  })

  it('auto + major → emit only', async () => {
    checkUpdatesMock.mockResolvedValue([update({ strategy: 'auto', severity: 'major' })])
    const result = await checkNow()
    expect(applyUpgradeMock).not.toHaveBeenCalled()
    expect(emitUpgradeAvailableMock).toHaveBeenCalledTimes(1)
    expect(result.notified).toBe(1)
  })

  it('notify strategy → emit only', async () => {
    checkUpdatesMock.mockResolvedValue([update({ strategy: 'notify', severity: 'patch' })])
    await checkNow()
    expect(applyUpgradeMock).not.toHaveBeenCalled()
    expect(emitUpgradeAvailableMock).toHaveBeenCalledTimes(1)
  })

  it('manual strategy → emit only', async () => {
    checkUpdatesMock.mockResolvedValue([update({ strategy: 'manual', severity: 'patch' })])
    await checkNow()
    expect(emitUpgradeAvailableMock).toHaveBeenCalledTimes(1)
  })

  it('isolates a per-app failure without aborting the rest', async () => {
    checkUpdatesMock.mockResolvedValue([
      update({ appId: 'app-1', strategy: 'auto', severity: 'patch' }),
      update({ appId: 'app-2', strategy: 'auto', severity: 'patch' }),
    ])
    applyUpgradeMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined)

    const result = await checkNow()

    expect(applyUpgradeMock).toHaveBeenCalledTimes(2)
    expect(result.autoApplied).toBe(1)
  })

  it('coalesces concurrent invocations (second returns zeros)', async () => {
    let release!: () => void
    checkUpdatesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([])
        }),
    )

    const first = checkNow()
    const second = await checkNow()
    expect(second).toEqual({ checked: 0, available: 0, autoApplied: 0, notified: 0 })

    release()
    await first
  })

  it('returns zeros when the App Manager is not ready', async () => {
    getAppManagerMock.mockReturnValue(null)
    const result = await checkNow()
    expect(result).toEqual({ checked: 0, available: 0, autoApplied: 0, notified: 0 })
    expect(checkUpdatesMock).not.toHaveBeenCalled()
  })
})
