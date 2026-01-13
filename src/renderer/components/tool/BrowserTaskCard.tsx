/**
 * BrowserTaskCard - AI Browser Operation Visualization Component
 *
 * When AI uses browser tools, displays below the message bubble:
 * - Sci-fi style operation animations
 * - Real-time operation steps
 * - [View Live] button → Opens browser view in Canvas
 *
 * Design Philosophy:
 * - Browser is a "heavy" tool, needs independent display form
 * - Sci-fi effects build user trust
 * - Supports user observation and intervention in AI operations
 */

import { useState, useEffect, useMemo } from 'react'
import {
  Globe,
  Eye,
  CheckCircle2,
  Loader2,
  MousePointer2,
  Type,
  Navigation,
  Camera,
  XCircle,
  Maximize2,
} from 'lucide-react'
import { useCanvasStore } from '../../stores/canvas.store'
import { useAIBrowserStore, useAIBrowserActiveViewId } from '../../stores/ai-browser.store'
import type { ToolCall } from '../../types'
import { useTranslation } from '../../i18n'

// ============================================
// Types
// ============================================

interface BrowserTaskCardProps {
  /** Browser-related tool calls */
  browserToolCalls: ToolCall[]
  /** Whether currently executing */
  isActive: boolean
}

interface BrowserStep {
  id: string
  action: string
  description: string
  status: 'pending' | 'running' | 'success' | 'error'
  timestamp: number
  kind: string
}

// ============================================
// Constants
// ============================================

/** Browser tool name prefix */
const BROWSER_TOOL_PREFIX = 'mcp__ai-browser__browser_'

// ============================================
// Helper Functions
// ============================================

/**
 * Extract pure tool name (remove MCP prefix)
 */
function extractToolName(fullName: string): string {
  if (fullName.startsWith(BROWSER_TOOL_PREFIX)) {
    return fullName.replace('mcp__ai-browser__', '')
  }
  return fullName
}

/**
 * Check if tool is a browser tool
 */
export function isBrowserTool(toolName: string): boolean {
  return toolName.startsWith(BROWSER_TOOL_PREFIX) || toolName.startsWith('browser_')
}

/**
 * Convert tool call to step
 */
function toolCallToStep(
  toolCall: ToolCall,
  actionMap: Record<string, { action: string; getDescription: (input: Record<string, unknown>) => string }>,
  t: (key: string, options?: Record<string, unknown>) => string
): BrowserStep {
  const toolName = extractToolName(toolCall.name)
  const mapping = actionMap[toolName]

  const action = mapping?.action || t('Browser action')
  const description = mapping?.getDescription(toolCall.input as Record<string, unknown>) || ''

  return {
    id: toolCall.id,
    action,
    description,
    kind: toolName,
    status: toolCall.status === 'success' ? 'success'
          : toolCall.status === 'error' ? 'error'
          : toolCall.status === 'running' ? 'running'
          : 'pending',
    timestamp: Date.now()
  }
}

/**
 * Get icon for step action
 */
function getStepIcon(kind: string) {
  if (kind.includes('new_page') || kind.includes('navigate')) return Navigation
  if (kind.includes('click')) return MousePointer2
  if (kind.includes('fill') || kind.includes('type') || kind.includes('press_key')) return Type
  if (kind.includes('screenshot')) return Camera
  if (kind.includes('snapshot')) return Eye
  return Globe
}

// ============================================
// Sub-components
// ============================================

/**
 * Scanline animation - indicates AI is "scanning" the page
 */
function ScanlineAnimation() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none rounded-lg">
      {/* Scanline */}
      <div className="scanline-sweep" />
      {/* Border glow */}
      <div className="absolute inset-0 rounded-lg border border-primary/20 animate-border-glow" />
    </div>
  )
}

/**
 * Single step item
 */
function StepItem({ step, isLatest }: { step: BrowserStep; isLatest: boolean }) {
  const Icon = getStepIcon(step.kind)

  return (
    <div
      className={`flex items-center gap-2 text-sm transition-all duration-300 ${
        isLatest ? 'opacity-100' : 'opacity-60'
      }`}
    >
      {/* Status indicator */}
      <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
        {step.status === 'running' ? (
          <Loader2 size={14} className="text-primary animate-spin" />
        ) : step.status === 'success' ? (
          <CheckCircle2 size={14} className="text-green-500" />
        ) : step.status === 'error' ? (
          <XCircle size={14} className="text-red-500" />
        ) : (
          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
        )}
      </div>

      {/* Action icon */}
      <Icon size={14} className="text-muted-foreground flex-shrink-0" />

      {/* Description */}
      <span className="truncate">
        <span className="font-medium">{step.action}</span>
        {step.description && (
          <span className="text-muted-foreground ml-1">{step.description}</span>
        )}
      </span>
    </div>
  )
}

// ============================================
// Main Component
// ============================================

export function BrowserTaskCard({ browserToolCalls, isActive }: BrowserTaskCardProps) {
  const [isExpanded, setIsExpanded] = useState(true)
  const attachAIBrowserView = useCanvasStore(state => state.attachAIBrowserView)
  const openUrl = useCanvasStore(state => state.openUrl)
  const activeViewId = useAIBrowserActiveViewId()
  const activeUrl = useAIBrowserStore(state => state.activeUrl)
  const setActiveUrl = useAIBrowserStore(state => state.setActiveUrl)
  const setOperating = useAIBrowserStore(state => state.setOperating)

  const { t } = useTranslation()
  const actionMap = useMemo(() => ({
    'browser_new_page': {
      action: t('Open page'),
      getDescription: (input: Record<string, unknown>) => `${input.url || t('New page')}`
    },
    'browser_navigate': {
      action: t('Navigate'),
      getDescription: (input: Record<string, unknown>) =>
        input.action === 'back' ? t('Back') : input.action === 'forward' ? t('Forward') : `${input.url || ''}`
    },
    'browser_click': {
      action: t('Click'),
      getDescription: (input: Record<string, unknown>) => `${t('Element')} ${input.uid || ''}`
    },
    'browser_fill': {
      action: t('Fill'),
      getDescription: (input: Record<string, unknown>) => {
        const val = String(input.value || '')
        return `"${val.slice(0, 20)}${val.length > 20 ? '...' : ''}"`
      }
    },
    'browser_select_option': {
      action: t('Select'),
      getDescription: (input: Record<string, unknown>) => `"${input.value || ''}"`
    },
    'browser_snapshot': {
      action: t('Analyze page'),
      getDescription: () => t('Get page structure')
    },
    'browser_screenshot': {
      action: t('Screenshot'),
      getDescription: (input: Record<string, unknown>) => (input.fullPage ? t('Full page') : t('Visible area'))
    },
    'browser_scroll': {
      action: t('Scroll'),
      getDescription: (input: Record<string, unknown>) => (input.direction as string) || t('Page')
    },
    'browser_hover': {
      action: t('Hover'),
      getDescription: (input: Record<string, unknown>) => `${t('Element')} ${input.uid || ''}`
    },
    'browser_type': {
      action: t('Type'),
      getDescription: (input: Record<string, unknown>) => {
        const val = String(input.text || '')
        return `"${val.slice(0, 15)}${val.length > 15 ? '...' : ''}"`
      }
    },
    'browser_press_key': {
      action: t('Press key'),
      getDescription: (input: Record<string, unknown>) => `${input.key || ''}`
    },
    'browser_wait_for': {
      action: t('Wait'),
      getDescription: (input: Record<string, unknown>) => input.text ? `"${input.text}"` : `${input.timeout || 1000}ms`
    },
    'browser_evaluate': {
      action: t('Execute script'),
      getDescription: () => 'JavaScript'
    },
  }), [t])

  // Convert tool calls to steps
  const steps = useMemo(() => {
    return browserToolCalls.map(tc => toolCallToStep(tc, actionMap, t))
  }, [actionMap, browserToolCalls, t])

  // Get current URL (from most recent new_page or navigate call)
  const currentUrl = useMemo(() => {
    for (let i = browserToolCalls.length - 1; i >= 0; i--) {
      const tc = browserToolCalls[i]
      const input = tc.input as Record<string, unknown>
      if (tc.name.includes('new_page') && input.url) {
        return String(input.url)
      }
      if (tc.name.includes('navigate') && input.url) {
        return String(input.url)
      }
    }
    return null
  }, [browserToolCalls])

  // Has running steps
  const hasRunningStep = steps.some(s => s.status === 'running')

  // Update AI Browser store operating state
  useEffect(() => {
    if (isActive && hasRunningStep) {
      setOperating(true)
      if (currentUrl) {
        setActiveUrl(currentUrl)
      }
    } else if (!hasRunningStep) {
      setOperating(false)
    }
  }, [isActive, hasRunningStep, currentUrl, setOperating, setActiveUrl])

  // Show recent steps
  const visibleSteps = isExpanded ? steps : steps.slice(-3)

  // Handle view live button click
  // If AI has an active BrowserView, attach it to Canvas (reuse existing view)
  // Otherwise fall back to opening a new browser tab with the URL
  const handleViewLive = () => {
    // Prefer activeUrl from store (synced from main process)
    // Fall back to currentUrl extracted from tool calls
    const urlToOpen = activeUrl || currentUrl

    if (activeViewId && urlToOpen) {
      // Attach existing AI BrowserView to Canvas - this reuses the view AI is operating
      attachAIBrowserView(activeViewId, urlToOpen, t('🤖 AI Browser'))
    } else if (urlToOpen) {
      // Fallback: open new browser tab if no activeViewId available
      openUrl(urlToOpen, t('🤖 AI Browser'))
    }
  }

  // Don't render if no browser tool calls
  if (browserToolCalls.length === 0) {
    return null
  }

  return (
    <div className="browser-task-card mt-3 relative">
      {/* Sci-fi background */}
      <div className="relative rounded-xl border border-primary/30 bg-gradient-to-br from-primary/5 via-background to-primary/10 overflow-hidden">
        {/* Scanline animation (only when active) */}
        {isActive && hasRunningStep && <ScanlineAnimation />}

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20">
          <div className="flex items-center gap-2">
            {/* AI Browser icon */}
            <div className="relative">
              <Globe
                size={18}
                className={`text-primary ${isActive && hasRunningStep ? 'animate-pulse-gentle' : ''}`}
              />
              {isActive && hasRunningStep && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              )}
            </div>
            <span className="font-medium text-sm">
              {isActive && hasRunningStep ? t('AI is operating the browser') : t('AI browser actions')}
            </span>
          </div>

          {/* Step count */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {steps.filter(s => s.status === 'success').length}/{steps.length} {t('steps')}
            </span>
            {steps.length > 3 && (
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="text-xs text-primary/70 hover:text-primary transition-colors"
              >
                {isExpanded ? t('Collapse') : t('Expand')}
              </button>
            )}
          </div>
        </div>

        {/* Step list */}
        <div className="px-4 py-3 space-y-2 max-h-48 overflow-y-auto">
          {visibleSteps.map((step, index) => (
            <StepItem
              key={step.id}
              step={step}
              isLatest={index === visibleSteps.length - 1}
            />
          ))}
        </div>

        {/* Footer action area */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-primary/20 bg-primary/5">
          {/* URL display */}
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {currentUrl && (
              <span className="text-xs text-muted-foreground truncate">
                {(() => {
                  try {
                    return new URL(currentUrl).hostname
                  } catch {
                    return currentUrl.slice(0, 30)
                  }
                })()}
              </span>
            )}
          </div>

          {/* View button */}
          <button
            onClick={handleViewLive}
            disabled={!currentUrl}
            className={`
              flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium
              transition-all duration-200
              ${currentUrl
                ? 'bg-primary/20 text-primary hover:bg-primary/30 hover:scale-[1.02] active:scale-[0.98]'
                : 'bg-muted/30 text-muted-foreground cursor-not-allowed'
              }
            `}
          >
            <Eye size={14} />
            <span>{t('View live feed')}</span>
            <Maximize2 size={12} className="opacity-50" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================
// Export helper to filter browser tools
// ============================================

/**
 * Filter browser tools from tool calls list
 */
export function filterBrowserTools(toolCalls: ToolCall[] | undefined): ToolCall[] {
  if (!toolCalls) return []
  return toolCalls.filter(tc => isBrowserTool(tc.name))
}
