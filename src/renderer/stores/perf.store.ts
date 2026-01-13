/**
 * Performance Monitoring Store
 *
 * Manages performance monitoring state in the renderer process.
 * Provides real-time metrics display and history tracking.
 *
 * Usage:
 *   const { isRunning, latestSnapshot, start, stop } = usePerfStore()
 */

import { create } from 'zustand'
import { api } from '../api'
import { rendererPerfCollector } from '../lib/perf-collector'

// ============================================
// Types (mirror from main process)
// ============================================

export interface MemoryMetrics {
  heapUsed: number
  heapTotal: number
  external: number
  rss: number
  arrayBuffers: number
}

export interface CpuMetrics {
  percentCPU: number
}

export interface BrowserViewMetrics {
  count: number
  viewIds: string[]
}

export interface IpcMetrics {
  callCount: number
  slowCalls: number
}

export interface RendererMetrics {
  fps: number
  frameTime: number
  renderCount: number
  domNodes: number
  eventListeners: number
  jsHeapUsed: number
  jsHeapLimit: number
  longTasks: number
}

export interface PerfSnapshot {
  timestamp: number
  memory: MemoryMetrics
  cpu: CpuMetrics
  browserViews: BrowserViewMetrics
  ipc: IpcMetrics
  renderer?: RendererMetrics
}

export interface PerfWarning {
  timestamp: number
  type: 'heap' | 'rss' | 'cpu' | 'browserView' | 'slowIpc' | 'fps' | 'longTasks' | 'rendererHeap'
  message: string
  value: number
  threshold: number
}

export interface PerfConfig {
  enabled: boolean
  sampleInterval: number
  maxSamples: number
  logToFile: boolean
  warnOnThreshold: boolean
}

// ============================================
// Store Interface
// ============================================

interface PerfState {
  // State
  isRunning: boolean
  config: PerfConfig | null
  latestSnapshot: PerfSnapshot | null
  recentSnapshots: PerfSnapshot[] // Last N snapshots for charts
  warnings: PerfWarning[]
  sampleCount: number

  // UI state
  isPanelOpen: boolean

  // Actions
  start: (config?: Partial<PerfConfig>) => Promise<void>
  stop: () => Promise<void>
  refresh: () => Promise<void>
  clearHistory: () => Promise<void>
  exportData: () => Promise<string | null>
  togglePanel: () => void

  // Internal
  _addSnapshot: (snapshot: PerfSnapshot) => void
  _addWarning: (warning: PerfWarning) => void
  _setRunning: (isRunning: boolean) => void
}

// ============================================
// Store Implementation
// ============================================

const MAX_RECENT_SNAPSHOTS = 60 // 2 minutes at 2s interval

export const usePerfStore = create<PerfState>((set, get) => ({
  // Initial state
  isRunning: false,
  config: null,
  latestSnapshot: null,
  recentSnapshots: [],
  warnings: [],
  sampleCount: 0,
  isPanelOpen: false,

  // Start monitoring
  start: async (config) => {
    const result = await api.perfStart(config)
    if (result.success) {
      set({ isRunning: true })
      // Start renderer-side metrics collection
      rendererPerfCollector.start(config?.sampleInterval || 2000)
      // Refresh state from backend
      await get().refresh()
    }
  },

  // Stop monitoring
  stop: async () => {
    const result = await api.perfStop()
    if (result.success) {
      set({ isRunning: false })
      // Stop renderer-side metrics collection
      rendererPerfCollector.stop()
    }
  },

  // Refresh state from backend
  refresh: async () => {
    const result = await api.perfGetState()
    if (result.success && result.data) {
      const state = result.data as {
        isRunning: boolean
        config: PerfConfig
        latestSnapshot: PerfSnapshot | null
        sampleCount: number
        warnings: PerfWarning[]
      }
      set({
        isRunning: state.isRunning,
        config: state.config,
        latestSnapshot: state.latestSnapshot,
        sampleCount: state.sampleCount,
        warnings: state.warnings,
      })
    }
  },

  // Clear history
  clearHistory: async () => {
    const result = await api.perfClearHistory()
    if (result.success) {
      set({
        recentSnapshots: [],
        warnings: [],
        sampleCount: 0,
        latestSnapshot: null,
      })
    }
  },

  // Export data as JSON
  exportData: async () => {
    const result = await api.perfExport()
    if (result.success && result.data) {
      return result.data as string
    }
    return null
  },

  // Toggle panel visibility
  togglePanel: () => {
    set((state) => ({ isPanelOpen: !state.isPanelOpen }))
  },

  // Internal: add snapshot from IPC event
  _addSnapshot: (snapshot) => {
    set((state) => {
      const recentSnapshots = [...state.recentSnapshots, snapshot]
      if (recentSnapshots.length > MAX_RECENT_SNAPSHOTS) {
        recentSnapshots.shift()
      }
      return {
        latestSnapshot: snapshot,
        recentSnapshots,
        sampleCount: state.sampleCount + 1,
      }
    })
  },

  // Internal: add warning from IPC event
  _addWarning: (warning) => {
    set((state) => ({
      warnings: [...state.warnings, warning].slice(-100), // Keep last 100
    }))
  },

  // Internal: set running state
  _setRunning: (isRunning) => {
    set({ isRunning })
  },
}))

// ============================================
// Event Listeners Initialization
// ============================================

let listenersInitialized = false

/**
 * Initialize IPC event listeners for perf store
 * Call this once during app initialization
 */
export function initPerfStoreListeners(): () => void {
  if (listenersInitialized) {
    return () => {}
  }
  listenersInitialized = true

  const store = usePerfStore.getState()
  let rendererCollectorStarted = false

  // Listen for snapshots - also auto-start renderer collector when we receive snapshots
  const unsubSnapshot = api.onPerfSnapshot((data) => {
    // Auto-start renderer collector if not started yet
    if (!rendererCollectorStarted) {
      rendererCollectorStarted = true
      rendererPerfCollector.start(2000)
      store._setRunning(true)
    }
    store._addSnapshot(data as PerfSnapshot)
  })

  // Listen for warnings
  const unsubWarning = api.onPerfWarning((data) => {
    store._addWarning(data as PerfWarning)
  })

  return () => {
    unsubSnapshot()
    unsubWarning()
    listenersInitialized = false
  }
}

// ============================================
// Selectors
// ============================================

/**
 * Get formatted memory string
 */
export function formatMemory(bytes: number): string {
  const mb = bytes / 1024 / 1024
  return `${mb.toFixed(1)} MB`
}

/**
 * Get memory usage percentage
 */
export function getMemoryPercent(snapshot: PerfSnapshot): number {
  if (!snapshot.memory.heapTotal) return 0
  return (snapshot.memory.heapUsed / snapshot.memory.heapTotal) * 100
}

/**
 * Check if any metric is in warning state
 */
export function hasWarningState(snapshot: PerfSnapshot): boolean {
  const heapMB = snapshot.memory.heapUsed / 1024 / 1024
  return (
    heapMB > 500 ||
    snapshot.cpu.percentCPU > 80 ||
    snapshot.browserViews.count > 10 ||
    snapshot.ipc.slowCalls > 5
  )
}
