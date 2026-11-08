import { api } from '../api'
import type { GitRepository } from '../../shared/types/git'

const MAX_PROBES = 128
const RETRY_AFTER_MS = 60_000

interface Probe {
  spaceId: string
  expiresAt: number
  pending: Promise<void> | null
}

/** File activation supplies paths; mounted consumers receive completed discoveries without waiting. */
export class GitDiscovery {
  private probes = new Map<string, Probe>()
  private pendingCount = 0
  private listeners = new Map<string, Set<(repository: GitRepository) => void>>()

  subscribe(spaceId: string, listener: (repository: GitRepository) => void): () => void {
    const listeners = this.listeners.get(spaceId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(spaceId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(spaceId)
    }
  }

  noteFile(spaceId: string, path: string): void {
    const directory = path.replace(/\\/g, '/').replace(/\/[^/]*$/, '')
    const key = JSON.stringify([spaceId, directory])
    const previous = this.probes.get(key)
    if (previous && (previous.pending || previous.expiresAt > Date.now())) return
    if (this.pendingCount >= MAX_PROBES) {
      console.warn('[GitDiscovery] Opened-file probe skipped: pending request limit reached')
      return
    }
    if (this.probes.size >= MAX_PROBES) {
      const idle = [...this.probes].find(([, probe]) => !probe.pending)
      if (!idle) {
        console.warn('[GitDiscovery] Opened-file probe skipped: pending directory limit reached')
        return
      }
      this.probes.delete(idle[0])
    }
    const probe: Probe = { spaceId, expiresAt: 0, pending: null }
    this.probes.set(key, probe)
    this.pendingCount++
    probe.pending = Promise.resolve().then(async () => {
      const response = await api.gitDiscoverRepository(spaceId, path)
      if (!response.success) {
        console.warn('[GitDiscovery] Opened-file repository could not be discovered:', response.code, response.error)
      } else if (response.data && this.probes.get(key) === probe) {
        for (const listener of this.listeners.get(spaceId) ?? []) listener(response.data)
      }
    }).catch((error: unknown) => {
      console.warn('[GitDiscovery] Opened-file repository request failed:', error)
    }).finally(() => {
      this.pendingCount--
      probe.expiresAt = Date.now() + RETRY_AFTER_MS
      probe.pending = null
    })
  }

  forget(spaceId?: string): void {
    for (const [key, probe] of this.probes) {
      if (!spaceId || probe.spaceId === spaceId) this.probes.delete(key)
    }
  }
}

export const gitDiscovery = new GitDiscovery()
