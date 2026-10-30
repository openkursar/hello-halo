/** Capability descriptors are cached per engine; sessions never inherit another engine's flags. */
import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '../api'
import type { EngineCapabilities } from '../types'
import { isEngineId, type EngineId } from '../../shared/types/engine'

interface EngineStoreState {
  capabilities: EngineCapabilities | null
  byEngine: Partial<Record<EngineId, EngineCapabilities>>
  loading: boolean
  load: (engineId?: EngineId) => Promise<void>
  reload: (engineId?: EngineId) => Promise<void>
}

const requests = new Map<EngineId | 'default', Promise<void>>()
const revisions = new Map<EngineId | 'default', number>()

export const useEngineStore = create<EngineStoreState>((set, get) => {
  const load = (engineId?: EngineId, force = false): Promise<void> => {
    const key = engineId ?? 'default'
    if (!force) {
      if (engineId ? get().byEngine[engineId] : get().capabilities) return Promise.resolve()
      if (requests.has(key)) return requests.get(key)!
    }
    const revision = (revisions.get(key) ?? 0) + 1
    revisions.set(key, revision)
    if (!engineId) set({ loading: true })
    const request = (async () => {
      try {
        const result = await api.getEngineCapabilities(engineId)
        if (revisions.get(key) !== revision) return
        const capabilities = result?.data as EngineCapabilities | undefined
        if (!result?.success || !capabilities || !isEngineId(capabilities.engineId) || (engineId && capabilities.engineId !== engineId)) {
          console.warn('[engine.store] Engine capabilities could not be loaded', { engineId: key, error: result?.error })
          return
        }
        set(state => ({
          byEngine: { ...state.byEngine, [capabilities.engineId]: capabilities },
          ...(!engineId ? { capabilities } : {}),
        }))
      } catch (error) {
        console.warn('[engine.store] Engine capabilities request failed', { engineId: key, error })
      } finally {
        if (revisions.get(key) === revision) {
          requests.delete(key)
          if (!engineId) set({ loading: false })
        }
      }
    })()
    requests.set(key, request)
    return request
  }
  return {
    capabilities: null, byEngine: {}, loading: false,
    load: engineId => load(engineId),
    reload: engineId => load(engineId, true),
  }
})

export function useEngineCapabilities(engineId?: EngineId): EngineCapabilities | null {
  const capabilities = useEngineStore(state => engineId ? state.byEngine[engineId] ?? null : state.capabilities)
  const load = useEngineStore(state => state.load)
  useEffect(() => { void load(engineId) }, [engineId, load])
  return capabilities
}

export function useEngineId(engineId?: EngineId): EngineId | null {
  return useEngineCapabilities(engineId)?.engineId ?? engineId ?? null
}
