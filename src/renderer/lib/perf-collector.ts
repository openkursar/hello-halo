/**
 * Renderer Process Performance Collector
 *
 * Collects performance metrics from the renderer process:
 * - FPS and frame timing
 * - React render counts
 * - DOM node count
 * - JS Heap usage
 * - Long tasks (> 50ms)
 *
 * This runs in the renderer and sends metrics to main process.
 */

import { api } from '../api'

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

interface PerformanceMemory {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

declare global {
  interface Performance {
    memory?: PerformanceMemory
  }
}

class RendererPerfCollector {
  private isRunning = false
  private intervalId: ReturnType<typeof setInterval> | null = null
  private sampleInterval = 2000

  // FPS tracking
  private frameCount = 0
  private lastFrameTime = 0
  private frameTimes: number[] = []
  private rafId: number | null = null

  // React render tracking
  private renderCount = 0

  // Long task tracking
  private longTaskCount = 0
  private longTaskObserver: PerformanceObserver | null = null

  /**
   * Start collecting metrics
   */
  start(sampleInterval = 2000): void {
    if (this.isRunning) return

    this.isRunning = true
    this.sampleInterval = sampleInterval

    // Start FPS tracking
    this.startFpsTracking()

    // Start long task observation
    this.startLongTaskObserver()

    // Start sampling interval
    this.intervalId = setInterval(() => {
      this.collectAndReport()
    }, this.sampleInterval)
  }

  /**
   * Stop collecting metrics
   */
  stop(): void {
    if (!this.isRunning) return

    this.isRunning = false

    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }

    if (this.longTaskObserver) {
      this.longTaskObserver.disconnect()
      this.longTaskObserver = null
    }
  }

  /**
   * Mark a React component render (call this from useEffect or render tracking)
   */
  markRender(): void {
    this.renderCount++
  }

  /**
   * Get current render count (for external tracking)
   */
  getRenderCount(): number {
    return this.renderCount
  }

  private startFpsTracking(): void {
    this.lastFrameTime = performance.now()
    this.frameTimes = []
    this.frameCount = 0

    const measureFrame = (now: number) => {
      if (!this.isRunning) return

      const delta = now - this.lastFrameTime
      this.lastFrameTime = now
      this.frameCount++

      // Keep last 60 frame times for averaging
      this.frameTimes.push(delta)
      if (this.frameTimes.length > 60) {
        this.frameTimes.shift()
      }

      this.rafId = requestAnimationFrame(measureFrame)
    }

    this.rafId = requestAnimationFrame(measureFrame)
  }

  private startLongTaskObserver(): void {
    if (typeof PerformanceObserver === 'undefined') return

    try {
      this.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) {
            this.longTaskCount++
            console.warn(`[PerfCollector] Long task detected: ${entry.duration.toFixed(1)}ms`)
          }
        }
      })

      this.longTaskObserver.observe({ entryTypes: ['longtask'] })
    } catch (e) {
      // Long task observation not supported
    }
  }

  private collectAndReport(): void {
    const metrics = this.collectMetrics()

    // Send to main process via api (dynamic import to avoid circular dependency)
    import('../api')
      .then(({ api }) => api.perfReportRendererMetrics(metrics))
      .catch(() => {
        // Fallback to direct window.halo if api not available
        if (typeof window !== 'undefined' && window.halo?.perfReportRendererMetrics) {
          window.halo.perfReportRendererMetrics(metrics)
        }
      })

    // Reset counters
    this.renderCount = 0
    this.longTaskCount = 0
    this.frameTimes = []
    this.frameCount = 0
  }

  private collectMetrics(): RendererMetrics {
    // Calculate FPS
    const avgFrameTime = this.frameTimes.length > 0
      ? this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
      : 16.67

    const fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 60

    // DOM node count
    const domNodes = document.querySelectorAll('*').length

    // Event listener count (estimate based on common patterns)
    // This is a rough estimate - real count would require DOM traversal
    const eventListeners = this.estimateEventListeners()

    // JS Heap (Chrome only)
    const memory = performance.memory
    const jsHeapUsed = memory?.usedJSHeapSize || 0
    const jsHeapLimit = memory?.jsHeapSizeLimit || 0

    return {
      fps: Math.round(fps * 10) / 10,
      frameTime: Math.round(avgFrameTime * 10) / 10,
      renderCount: this.renderCount,
      domNodes,
      eventListeners,
      jsHeapUsed,
      jsHeapLimit,
      longTasks: this.longTaskCount,
    }
  }

  private estimateEventListeners(): number {
    // Count elements with common event attributes
    // This is an approximation - actual listener count isn't directly accessible
    let count = 0

    try {
      // Count elements with onclick, onchange, etc.
      const interactiveElements = document.querySelectorAll(
        'button, input, textarea, select, a, [onclick], [onchange], [onsubmit], [onkeydown], [onkeyup]'
      )
      count = interactiveElements.length
    } catch (e) {
      // Ignore errors
    }

    return count
  }
}

// Singleton instance
export const rendererPerfCollector = new RendererPerfCollector()

// React hook for tracking renders
export function useRenderTracking(componentName?: string): void {
  // Track initial render
  rendererPerfCollector.markRender()

  if (componentName && process.env.NODE_ENV === 'development') {
    console.debug(`[RenderTrack] ${componentName}`)
  }
}
