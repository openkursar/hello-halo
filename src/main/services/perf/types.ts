/**
 * Performance Monitoring Module - Type Definitions
 *
 * Provides types for the performance monitoring system.
 * This is a development/debugging feature, not analytics.
 */

// ============================================
// Configuration
// ============================================

export interface PerfConfig {
  /** Enable performance monitoring */
  enabled: boolean
  /** Sampling interval in milliseconds */
  sampleInterval: number
  /** Maximum samples to keep in memory */
  maxSamples: number
  /** Write to log file */
  logToFile: boolean
  /** Show warnings when thresholds exceeded */
  warnOnThreshold: boolean
}

export const DEFAULT_PERF_CONFIG: PerfConfig = {
  enabled: false,
  sampleInterval: 2000,
  maxSamples: 300, // 10 minutes at 2s interval
  logToFile: false,
  warnOnThreshold: true,
}

// ============================================
// Metrics
// ============================================

/** Memory metrics from process.memoryUsage() */
export interface MemoryMetrics {
  /** V8 heap used (bytes) */
  heapUsed: number
  /** V8 heap total (bytes) */
  heapTotal: number
  /** Memory used by C++ objects (bytes) */
  external: number
  /** Resident Set Size - total memory (bytes) */
  rss: number
  /** ArrayBuffers memory (bytes) */
  arrayBuffers: number
}

/** CPU metrics */
export interface CpuMetrics {
  /** CPU usage percentage (0-100+) */
  percentCPU: number
}

/** BrowserView metrics */
export interface BrowserViewMetrics {
  /** Number of active BrowserView instances */
  count: number
  /** IDs of active views */
  viewIds: string[]
}

/** IPC metrics */
export interface IpcMetrics {
  /** Number of IPC calls in the sample period */
  callCount: number
  /** Slow IPC calls (> 100ms) */
  slowCalls: number
}

/** Renderer process metrics (collected in renderer, sent to main) */
export interface RendererMetrics {
  /** Frames per second (from requestAnimationFrame) */
  fps: number
  /** Frame time in ms (time between frames) */
  frameTime: number
  /** React component render count in sample period */
  renderCount: number
  /** DOM node count */
  domNodes: number
  /** Event listener count estimate */
  eventListeners: number
  /** JS Heap used (from performance.memory, Chrome only) */
  jsHeapUsed: number
  /** JS Heap limit (from performance.memory, Chrome only) */
  jsHeapLimit: number
  /** Long tasks count (> 50ms, from PerformanceObserver) */
  longTasks: number
}

/** Complete performance snapshot */
export interface PerfSnapshot {
  /** Timestamp when snapshot was taken */
  timestamp: number
  /** Memory metrics (main process) */
  memory: MemoryMetrics
  /** CPU metrics (main process) */
  cpu: CpuMetrics
  /** BrowserView metrics */
  browserViews: BrowserViewMetrics
  /** IPC metrics (reset each sample) */
  ipc: IpcMetrics
  /** Renderer process metrics (optional, only when renderer reporting is enabled) */
  renderer?: RendererMetrics
}

// ============================================
// Thresholds for Warnings
// ============================================

export interface PerfThresholds {
  /** Warn if heap exceeds this (MB) */
  heapUsedMB: number
  /** Warn if RSS exceeds this (MB) */
  rssMB: number
  /** Warn if CPU exceeds this (%) */
  cpuPercent: number
  /** Warn if BrowserView count exceeds */
  browserViewCount: number
  /** Warn if slow IPC calls exceed this per sample */
  slowIpcCalls: number
  /** Warn if FPS drops below this */
  minFps: number
  /** Warn if long tasks exceed this per sample */
  longTasksCount: number
  /** Warn if renderer JS heap exceeds this (MB) */
  rendererHeapMB: number
}

export const DEFAULT_THRESHOLDS: PerfThresholds = {
  heapUsedMB: 500,
  rssMB: 1000,
  cpuPercent: 80,
  browserViewCount: 10,
  slowIpcCalls: 5,
  minFps: 30,
  longTasksCount: 3,
  rendererHeapMB: 300,
}

// ============================================
// Service State
// ============================================

export interface PerfServiceState {
  /** Whether monitoring is running */
  isRunning: boolean
  /** Current configuration */
  config: PerfConfig
  /** Latest snapshot */
  latestSnapshot: PerfSnapshot | null
  /** Number of samples collected */
  sampleCount: number
  /** Warnings triggered */
  warnings: PerfWarning[]
}

export interface PerfWarning {
  timestamp: number
  type: 'heap' | 'rss' | 'cpu' | 'browserView' | 'slowIpc' | 'fps' | 'longTasks' | 'rendererHeap'
  message: string
  value: number
  threshold: number
}

// ============================================
// IPC Events
// ============================================

export const PerfChannels = {
  // Commands (renderer -> main)
  START: 'perf:start',
  STOP: 'perf:stop',
  GET_STATE: 'perf:get-state',
  GET_HISTORY: 'perf:get-history',
  CLEAR_HISTORY: 'perf:clear-history',
  SET_CONFIG: 'perf:set-config',
  EXPORT: 'perf:export',

  // Renderer metrics reporting (renderer -> main)
  RENDERER_METRICS: 'perf:renderer-metrics',

  // Events (main -> renderer)
  SNAPSHOT: 'perf:snapshot',
  WARNING: 'perf:warning',
} as const
