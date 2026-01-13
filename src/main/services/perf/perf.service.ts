/**
 * Performance Monitoring Service
 *
 * Provides real-time performance monitoring for Halo.
 * This is a developer tool for diagnosing performance issues.
 *
 * Features:
 * - Memory monitoring (heap, RSS, external)
 * - CPU usage tracking
 * - BrowserView instance counting
 * - IPC call frequency tracking
 * - Threshold-based warnings
 * - Data export for analysis
 *
 * Usage:
 *   import { perfService } from './services/perf'
 *   await perfService.start()
 */

import { BrowserWindow } from 'electron'
import * as v8 from 'v8'
import type {
  PerfConfig,
  PerfSnapshot,
  PerfServiceState,
  PerfWarning,
  PerfThresholds,
  MemoryMetrics,
  CpuMetrics,
  BrowserViewMetrics,
  RendererMetrics,
} from './types'
import { DEFAULT_PERF_CONFIG, DEFAULT_THRESHOLDS } from './types'

class PerformanceService {
  private static instance: PerformanceService | null = null

  // Configuration
  private config: PerfConfig = { ...DEFAULT_PERF_CONFIG }
  private thresholds: PerfThresholds = { ...DEFAULT_THRESHOLDS }

  // State
  private isRunning = false
  private intervalId: NodeJS.Timeout | null = null
  private history: PerfSnapshot[] = []
  private warnings: PerfWarning[] = []

  // IPC tracking
  private ipcCallCount = 0
  private slowIpcCount = 0

  // CPU tracking
  private lastCpuUsage: NodeJS.CpuUsage | null = null
  private lastCpuTime = 0

  // Main window reference for sending events
  private mainWindow: BrowserWindow | null = null

  // Latest renderer metrics (received from renderer process)
  private latestRendererMetrics: RendererMetrics | null = null

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): PerformanceService {
    if (!PerformanceService.instance) {
      PerformanceService.instance = new PerformanceService()
    }
    return PerformanceService.instance
  }

  /**
   * Set main window reference (for sending IPC events)
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * Start performance monitoring
   */
  async start(config?: Partial<PerfConfig>): Promise<void> {
    if (this.isRunning) {
      console.log('[Perf] Already running')
      return
    }

    if (config) {
      this.config = { ...this.config, ...config }
    }

    console.log('[Perf] Starting performance monitoring...')
    console.log('[Perf] Config:', JSON.stringify(this.config))

    this.isRunning = true
    this.lastCpuUsage = process.cpuUsage()
    this.lastCpuTime = Date.now()

    // Take initial snapshot
    this.takeSample()

    // Start sampling interval
    this.intervalId = setInterval(() => {
      this.takeSample()
    }, this.config.sampleInterval)

    console.log('[Perf] Monitoring started')
  }

  /**
   * Stop performance monitoring
   */
  stop(): void {
    if (!this.isRunning) return

    console.log('[Perf] Stopping performance monitoring...')

    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    this.isRunning = false
    console.log('[Perf] Monitoring stopped')
  }

  /**
   * Get current state
   */
  getState(): PerfServiceState {
    return {
      isRunning: this.isRunning,
      config: { ...this.config },
      latestSnapshot: this.history.length > 0 ? this.history[this.history.length - 1] : null,
      sampleCount: this.history.length,
      warnings: [...this.warnings],
    }
  }

  /**
   * Get history
   */
  getHistory(): PerfSnapshot[] {
    return [...this.history]
  }

  /**
   * Clear history and warnings
   */
  clearHistory(): void {
    this.history = []
    this.warnings = []
    console.log('[Perf] History cleared')
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<PerfConfig>): void {
    const wasRunning = this.isRunning

    if (wasRunning) {
      this.stop()
    }

    this.config = { ...this.config, ...config }

    if (wasRunning && this.config.enabled) {
      this.start()
    }
  }

  /**
   * Set thresholds
   */
  setThresholds(thresholds: Partial<PerfThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds }
  }

  /**
   * Mark an IPC call (for tracking frequency)
   */
  markIpcCall(durationMs?: number): void {
    this.ipcCallCount++
    if (durationMs && durationMs > 100) {
      this.slowIpcCount++
    }
  }

  /**
   * Update renderer metrics (called from IPC handler)
   */
  updateRendererMetrics(metrics: RendererMetrics): void {
    this.latestRendererMetrics = metrics

    // Check renderer-specific thresholds
    if (this.config.warnOnThreshold && this.isRunning) {
      this.checkRendererThresholds(metrics)
    }
  }

  /**
   * Export data as JSON string
   */
  export(): string {
    return JSON.stringify(
      {
        exportTime: new Date().toISOString(),
        config: this.config,
        thresholds: this.thresholds,
        history: this.history,
        warnings: this.warnings,
        summary: this.getSummary(),
      },
      null,
      2
    )
  }

  /**
   * Get summary statistics
   */
  private getSummary(): Record<string, unknown> {
    if (this.history.length === 0) return {}

    const heapValues = this.history.map((s) => s.memory.heapUsed)
    const cpuValues = this.history.map((s) => s.cpu.percentCPU)

    return {
      sampleCount: this.history.length,
      duration: this.history.length > 1
        ? this.history[this.history.length - 1].timestamp - this.history[0].timestamp
        : 0,
      memory: {
        heapUsedAvg: Math.round(average(heapValues) / 1024 / 1024),
        heapUsedMax: Math.round(Math.max(...heapValues) / 1024 / 1024),
        heapUsedMin: Math.round(Math.min(...heapValues) / 1024 / 1024),
      },
      cpu: {
        avg: Math.round(average(cpuValues) * 10) / 10,
        max: Math.round(Math.max(...cpuValues) * 10) / 10,
      },
      warningCount: this.warnings.length,
    }
  }

  // ============================================
  // Private Methods
  // ============================================

  private takeSample(): void {
    const snapshot = this.collectSnapshot()

    // Add to history
    this.history.push(snapshot)

    // Trim history if needed
    if (this.history.length > this.config.maxSamples) {
      this.history.shift()
    }

    // Check thresholds
    if (this.config.warnOnThreshold) {
      this.checkThresholds(snapshot)
    }

    // Send to renderer
    this.emitSnapshot(snapshot)

    // Log to console
    this.logSnapshot(snapshot)

    // Reset IPC counters
    this.ipcCallCount = 0
    this.slowIpcCount = 0
  }

  private collectSnapshot(): PerfSnapshot {
    const snapshot: PerfSnapshot = {
      timestamp: Date.now(),
      memory: this.collectMemoryMetrics(),
      cpu: this.collectCpuMetrics(),
      browserViews: this.collectBrowserViewMetrics(),
      ipc: {
        callCount: this.ipcCallCount,
        slowCalls: this.slowIpcCount,
      },
    }

    // Include renderer metrics if available
    if (this.latestRendererMetrics) {
      snapshot.renderer = this.latestRendererMetrics
    }

    return snapshot
  }

  private collectMemoryMetrics(): MemoryMetrics {
    const mem = process.memoryUsage()
    return {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      rss: mem.rss,
      arrayBuffers: mem.arrayBuffers || 0,
    }
  }

  private collectCpuMetrics(): CpuMetrics {
    const now = Date.now()
    const elapsed = now - this.lastCpuTime

    if (elapsed === 0 || !this.lastCpuUsage) {
      this.lastCpuUsage = process.cpuUsage()
      this.lastCpuTime = now
      return { percentCPU: 0 }
    }

    const currentUsage = process.cpuUsage(this.lastCpuUsage)
    const totalMicros = currentUsage.user + currentUsage.system
    const percentCPU = (totalMicros / 1000 / elapsed) * 100

    this.lastCpuUsage = process.cpuUsage()
    this.lastCpuTime = now

    return {
      percentCPU: Math.round(percentCPU * 10) / 10,
    }
  }

  private collectBrowserViewMetrics(): BrowserViewMetrics {
    const viewIds: string[] = []
    let count = 0

    try {
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        const views = win.getBrowserViews()
        count += views.length
        // We don't have direct access to view IDs from here
        // This would need integration with browserViewManager
      }
    } catch (e) {
      // Ignore errors
    }

    return { count, viewIds }
  }

  private checkThresholds(snapshot: PerfSnapshot): void {
    const heapMB = snapshot.memory.heapUsed / 1024 / 1024
    const rssMB = snapshot.memory.rss / 1024 / 1024

    if (heapMB > this.thresholds.heapUsedMB) {
      this.addWarning('heap', `Heap usage high: ${heapMB.toFixed(0)}MB`, heapMB, this.thresholds.heapUsedMB)
    }

    if (rssMB > this.thresholds.rssMB) {
      this.addWarning('rss', `RSS high: ${rssMB.toFixed(0)}MB`, rssMB, this.thresholds.rssMB)
    }

    if (snapshot.cpu.percentCPU > this.thresholds.cpuPercent) {
      this.addWarning('cpu', `CPU usage high: ${snapshot.cpu.percentCPU}%`, snapshot.cpu.percentCPU, this.thresholds.cpuPercent)
    }

    if (snapshot.browserViews.count > this.thresholds.browserViewCount) {
      this.addWarning('browserView', `Too many BrowserViews: ${snapshot.browserViews.count}`, snapshot.browserViews.count, this.thresholds.browserViewCount)
    }

    if (snapshot.ipc.slowCalls > this.thresholds.slowIpcCalls) {
      this.addWarning('slowIpc', `Slow IPC calls: ${snapshot.ipc.slowCalls}`, snapshot.ipc.slowCalls, this.thresholds.slowIpcCalls)
    }

    // Check renderer metrics if available
    if (snapshot.renderer) {
      this.checkRendererThresholds(snapshot.renderer)
    }
  }

  private checkRendererThresholds(renderer: RendererMetrics): void {
    if (renderer.fps < this.thresholds.minFps && renderer.fps > 0) {
      this.addWarning('fps', `Low FPS: ${renderer.fps}`, renderer.fps, this.thresholds.minFps)
    }

    if (renderer.longTasks > this.thresholds.longTasksCount) {
      this.addWarning('longTasks', `Long tasks: ${renderer.longTasks}`, renderer.longTasks, this.thresholds.longTasksCount)
    }

    const rendererHeapMB = renderer.jsHeapUsed / 1024 / 1024
    if (rendererHeapMB > this.thresholds.rendererHeapMB) {
      this.addWarning('rendererHeap', `Renderer heap high: ${rendererHeapMB.toFixed(0)}MB`, rendererHeapMB, this.thresholds.rendererHeapMB)
    }
  }

  private addWarning(
    type: PerfWarning['type'],
    message: string,
    value: number,
    threshold: number
  ): void {
    const warning: PerfWarning = {
      timestamp: Date.now(),
      type,
      message,
      value,
      threshold,
    }

    this.warnings.push(warning)

    // Keep only last 100 warnings
    if (this.warnings.length > 100) {
      this.warnings.shift()
    }

    console.warn(`[Perf] ⚠️ ${message}`)
    this.emitWarning(warning)
  }

  private emitSnapshot(snapshot: PerfSnapshot): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('perf:snapshot', snapshot)
    } else {
      console.warn('[Perf] Cannot emit snapshot - mainWindow not set or destroyed')
    }
  }

  private emitWarning(warning: PerfWarning): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('perf:warning', warning)
    }
  }

  private logSnapshot(snapshot: PerfSnapshot): void {
    const heapMB = (snapshot.memory.heapUsed / 1024 / 1024).toFixed(1)
    const rssMB = (snapshot.memory.rss / 1024 / 1024).toFixed(1)

    let logMessage = `[Perf] Main: Heap ${heapMB}MB | RSS ${rssMB}MB | CPU ${snapshot.cpu.percentCPU}% | Views ${snapshot.browserViews.count} | IPC ${snapshot.ipc.callCount} (slow: ${snapshot.ipc.slowCalls})`

    if (snapshot.renderer) {
      const r = snapshot.renderer
      const rendererHeapMB = (r.jsHeapUsed / 1024 / 1024).toFixed(1)
      logMessage += ` || Renderer: FPS ${r.fps} | Frame ${r.frameTime}ms | Renders ${r.renderCount} | DOM ${r.domNodes} | Heap ${rendererHeapMB}MB | LongTasks ${r.longTasks}`
    }

    console.log(logMessage)
  }
}

// Utility
function average(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

// Export singleton
export const perfService = PerformanceService.getInstance()
