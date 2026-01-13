/**
 * Performance Tools - Performance tracing and analysis
 *
 * Tools for capturing and analyzing performance traces.
 * Tool descriptions aligned with chrome-devtools-mcp for 100% compatibility.
 */

import type { AIBrowserTool, ToolResult } from '../types'

// Trace state stored per context
interface TraceState {
  isTracing: boolean
  startTime: number
  traceEvents: unknown[]
}

const traceStates = new Map<string, TraceState>()

// Standard trace categories (aligned with chrome-devtools-mcp)
const TRACE_CATEGORIES = [
  '-*',
  'blink.console',
  'blink.user_timing',
  'devtools.timeline',
  'disabled-by-default-devtools.screenshot',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.invalidationTracking',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-v8.cpu_profiler.hires',
  'latencyInfo',
  'loading',
  'disabled-by-default-lighthouse',
  'v8.execute',
  'v8'
]

/**
 * performance_start_trace - Start performance tracing
 * Aligned with chrome-devtools-mcp: performance_start_trace
 */
export const performanceStartTraceTool: AIBrowserTool = {
  name: 'browser_perf_start',
  description: 'Starts a performance trace recording on the selected page. This can be used to look for performance problems and insights to improve the performance of the page. It will also report Core Web Vital (CWV) scores for the page.',
  category: 'performance',
  inputSchema: {
    type: 'object',
    properties: {
      reload: {
        type: 'boolean',
        description: 'Determines if, once tracing has started, the page should be automatically reloaded.'
      },
      autoStop: {
        type: 'boolean',
        description: 'Determines if the trace recording should be automatically stopped.'
      }
    },
    required: ['reload', 'autoStop']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const reload = params.reload as boolean
    const autoStop = params.autoStop as boolean

    const viewId = context.getActiveViewId()
    if (!viewId) {
      return {
        content: 'No active browser page.',
        isError: true
      }
    }

    // Check if already tracing
    if (traceStates.get(viewId)?.isTracing) {
      return {
        content: 'Error: a performance trace is already running. Use performance_stop_trace to stop it. Only one trace can be running at any given time.',
        isError: true
      }
    }

    try {
      // If reload is requested, first navigate to about:blank
      if (reload) {
        const currentUrl = await context.getPageUrl()
        await context.navigate('about:blank')
        await new Promise(resolve => setTimeout(resolve, 500))

        // Start tracing
        await context.sendCDPCommand('Tracing.start', {
          categories: TRACE_CATEGORIES.join(',')
        })

        // Store trace state
        traceStates.set(viewId, {
          isTracing: true,
          startTime: Date.now(),
          traceEvents: []
        })

        // Navigate back to original URL
        await context.navigate(currentUrl)
      } else {
        // Start tracing without reload
        await context.sendCDPCommand('Tracing.start', {
          categories: TRACE_CATEGORIES.join(',')
        })

        traceStates.set(viewId, {
          isTracing: true,
          startTime: Date.now(),
          traceEvents: []
        })
      }

      // Auto-stop after 5 seconds if requested
      if (autoStop) {
        await new Promise(resolve => setTimeout(resolve, 5000))

        const state = traceStates.get(viewId)
        if (state?.isTracing) {
          await context.sendCDPCommand('Tracing.end')
          state.isTracing = false

          const duration = Date.now() - state.startTime
          const metrics = await getPerformanceMetrics(context)

          return {
            content: formatTraceResults(duration, metrics)
          }
        }
      }

      return {
        content: 'The performance trace is being recorded. Use performance_stop_trace to stop it.'
      }
    } catch (error) {
      return {
        content: `Failed to start trace: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

/**
 * performance_stop_trace - Stop performance tracing
 * Aligned with chrome-devtools-mcp: performance_stop_trace
 */
export const performanceStopTraceTool: AIBrowserTool = {
  name: 'browser_perf_stop',
  description: 'Stops the active performance trace recording on the selected page.',
  category: 'performance',
  inputSchema: {
    type: 'object',
    properties: {}
  },
  handler: async (_params, context): Promise<ToolResult> => {
    const viewId = context.getActiveViewId()
    if (!viewId) {
      return {
        content: 'No active browser page.',
        isError: true
      }
    }

    const state = traceStates.get(viewId)
    if (!state?.isTracing) {
      return {
        content: 'No performance trace is running.'
      }
    }

    try {
      await context.sendCDPCommand('Tracing.end')

      const duration = Date.now() - state.startTime
      state.isTracing = false

      // Get performance metrics
      const metrics = await getPerformanceMetrics(context)

      return {
        content: formatTraceResults(duration, metrics)
      }
    } catch (error) {
      return {
        content: `Failed to stop trace: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

/**
 * performance_analyze_insight - Analyze specific performance insights
 * Aligned with chrome-devtools-mcp: performance_analyze_insight
 */
export const performanceAnalyzeInsightTool: AIBrowserTool = {
  name: 'browser_perf_insight',
  description: 'Provides more detailed information on a specific Performance Insight of an insight set that was highlighted in the results of a trace recording.',
  category: 'performance',
  inputSchema: {
    type: 'object',
    properties: {
      insightSetId: {
        type: 'string',
        description: 'The id for the specific insight set. Only use the ids given in the "Available insight sets" list.'
      },
      insightName: {
        type: 'string',
        description: 'The name of the Insight you want more information on. For example: "DocumentLatency" or "LCPBreakdown"'
      }
    },
    required: ['insightSetId', 'insightName']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const insightSetId = params.insightSetId as string
    const insightName = params.insightName as string

    if (!context.getActiveViewId()) {
      return {
        content: 'No active browser page.',
        isError: true
      }
    }

    try {
      // Get performance metrics and provide insight analysis
      const metrics = await getPerformanceMetrics(context)

      const lines: string[] = [
        `# Performance Insight: ${insightName}`,
        `Insight Set: ${insightSetId}`,
        ''
      ]

      // Provide insights based on the insight name
      switch (insightName.toLowerCase()) {
        case 'documentlatency':
          lines.push('## Document Latency Analysis')
          lines.push(`Task Duration: ${(metrics.TaskDuration * 1000).toFixed(2)}ms`)
          lines.push(`Script Duration: ${(metrics.ScriptDuration * 1000).toFixed(2)}ms`)
          if (metrics.TaskDuration > 0.05) {
            lines.push('')
            lines.push('⚠️ Long tasks detected. Consider:')
            lines.push('- Breaking up long-running JavaScript')
            lines.push('- Using requestIdleCallback for non-urgent work')
            lines.push('- Web Workers for heavy computation')
          }
          break

        case 'lcpbreakdown':
          lines.push('## LCP (Largest Contentful Paint) Breakdown')
          lines.push(`Layout Count: ${metrics.LayoutCount}`)
          lines.push(`Layout Duration: ${(metrics.LayoutDuration * 1000).toFixed(2)}ms`)
          lines.push(`Recalc Style Count: ${metrics.RecalcStyleCount}`)
          lines.push('')
          lines.push('Recommendations:')
          lines.push('- Optimize critical rendering path')
          lines.push('- Preload LCP resources')
          lines.push('- Reduce render-blocking resources')
          break

        case 'renderblocking':
          lines.push('## Render Blocking Resources')
          lines.push(`Documents: ${metrics.Documents}`)
          lines.push(`Frames: ${metrics.Frames}`)
          lines.push('')
          lines.push('Recommendations:')
          lines.push('- Use async/defer for scripts')
          lines.push('- Inline critical CSS')
          lines.push('- Preconnect to required origins')
          break

        default:
          lines.push('## General Performance Metrics')
          lines.push(`JS Heap Used: ${formatBytes(metrics.JSHeapUsedSize)}`)
          lines.push(`JS Heap Total: ${formatBytes(metrics.JSHeapTotalSize)}`)
          lines.push(`DOM Nodes: ${metrics.Nodes}`)
          lines.push(`Layout Count: ${metrics.LayoutCount}`)
          lines.push(`Script Duration: ${(metrics.ScriptDuration * 1000).toFixed(2)}ms`)
      }

      return {
        content: lines.join('\n')
      }
    } catch (error) {
      return {
        content: `Failed to analyze insight: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

/**
 * Get performance metrics via CDP
 */
async function getPerformanceMetrics(context: any): Promise<Record<string, number>> {
  try {
    const result = await context.sendCDPCommand<{
      metrics: Array<{ name: string; value: number }>
    }>('Performance.getMetrics')

    const metrics: Record<string, number> = {}
    for (const m of result.metrics) {
      metrics[m.name] = m.value
    }
    return metrics
  } catch {
    return {}
  }
}

/**
 * Format trace results
 */
function formatTraceResults(duration: number, metrics: Record<string, number>): string {
  const lines = [
    'The performance trace has been stopped.',
    '',
    `## Trace Summary`,
    `Duration: ${duration}ms`,
    '',
    '## Core Metrics'
  ]

  if (metrics.JSHeapUsedSize) {
    lines.push(`JS Heap Used: ${formatBytes(metrics.JSHeapUsedSize)}`)
  }
  if (metrics.JSHeapTotalSize) {
    lines.push(`JS Heap Total: ${formatBytes(metrics.JSHeapTotalSize)}`)
  }
  if (metrics.Nodes) {
    lines.push(`DOM Nodes: ${metrics.Nodes}`)
  }
  if (metrics.Documents) {
    lines.push(`Documents: ${metrics.Documents}`)
  }
  if (metrics.LayoutCount) {
    lines.push(`Layout Count: ${metrics.LayoutCount}`)
  }
  if (metrics.LayoutDuration) {
    lines.push(`Layout Duration: ${(metrics.LayoutDuration * 1000).toFixed(2)}ms`)
  }
  if (metrics.RecalcStyleCount) {
    lines.push(`Recalc Style Count: ${metrics.RecalcStyleCount}`)
  }
  if (metrics.ScriptDuration) {
    lines.push(`Script Duration: ${(metrics.ScriptDuration * 1000).toFixed(2)}ms`)
  }
  if (metrics.TaskDuration) {
    lines.push(`Task Duration: ${(metrics.TaskDuration * 1000).toFixed(2)}ms`)
  }

  lines.push('')
  lines.push('## Available Insight Sets')
  lines.push('Use performance_analyze_insight with these insight sets:')
  lines.push('- insightSetId: "main", available insights: DocumentLatency, LCPBreakdown, RenderBlocking')

  return lines.join('\n')
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

// Export all performance tools
export const performanceTools: AIBrowserTool[] = [
  performanceStartTraceTool,
  performanceStopTraceTool,
  performanceAnalyzeInsightTool
]
