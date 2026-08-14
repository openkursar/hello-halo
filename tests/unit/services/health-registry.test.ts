/**
 * The registry file is the only health state that survives a restart, so its
 * growth is the invariant worth guarding: entries left by a dead instance are
 * orphan candidates for one cleanup pass, never persistent rows. Persisting them
 * grows the file with every launch and pins health to 'degraded'.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { HealthRegistry } from '../../../src/main/services/health/types'

let haloDir = ''

vi.mock('../../../src/main/foundation/config.service', () => ({
  getHaloDir: () => haloDir
}))

type RegistryModule = typeof import('../../../src/main/services/health/process-guardian/registry')

/** Simulate an app launch: fresh module state over the same registry file. */
async function launch(): Promise<RegistryModule> {
  vi.resetModules()
  const registry = await import('../../../src/main/services/health/process-guardian/registry')
  registry.markInstanceStart()
  return registry
}

function readPersisted(): HealthRegistry {
  return JSON.parse(readFileSync(join(haloDir, '.health-registry.json'), 'utf-8'))
}

function register(registry: RegistryModule, id: string, pid: number): void {
  registry.registerProcess({
    id,
    pid,
    type: 'v2-session',
    instanceId: registry.getCurrentInstanceId(),
    startedAt: Date.now()
  })
}

describe('health registry', () => {
  beforeEach(() => {
    haloDir = mkdtempSync(join(tmpdir(), 'halo-registry-'))
  })

  afterEach(() => {
    rmSync(haloDir, { recursive: true, force: true })
  })

  it('hands the previous run entries to cleanup instead of persisting them', async () => {
    const first = await launch()
    register(first, 'conv-a', 101)
    register(first, 'conv-b', 102)
    expect(readPersisted().processes).toHaveLength(2)

    const second = await launch()
    expect(readPersisted().processes).toEqual([])
    expect(second.getOrphanProcesses().map(p => p.pid)).toEqual([101, 102])
    expect(second.getRegistryStats()).toMatchObject({ currentProcesses: 0, orphanProcesses: 2 })
  })

  it('keeps the file bounded when sessions are never unregistered', async () => {
    for (let i = 0; i < 5; i++) {
      const registry = await launch()
      register(registry, `conv-${i}`, 200 + i)
      expect(readPersisted().processes).toHaveLength(1)
    }
  })

  it('drops the inherited entries once cleanup has handled them', async () => {
    const first = await launch()
    register(first, 'conv-a', 101)

    const second = await launch()
    second.clearOrphanEntries()

    expect(second.getOrphanProcesses()).toEqual([])
    expect(second.getRegistryStats().orphanProcesses).toBe(0)
  })

  it('tracks only live entries of the current instance', async () => {
    const registry = await launch()
    register(registry, 'conv-a', 101)
    register(registry, 'conv-a', 103)  // same session, new process
    expect(registry.getCurrentProcesses().map(p => p.pid)).toEqual([103])

    registry.unregisterProcess('conv-a', 'v2-session')
    expect(registry.getCurrentProcesses()).toEqual([])
    expect(readPersisted().processes).toEqual([])
  })
})
