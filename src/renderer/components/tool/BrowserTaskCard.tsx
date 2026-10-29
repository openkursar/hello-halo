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
  CheckCircle2,
  Loader2,
  XCircle,
  ArrowUpRight,
} from 'lucide-react'
import { useCanvasStore } from '../../stores/canvas.store'
import { useAIBrowserStore, useActiveConversationBrowserView } from '../../stores/ai-browser.store'
import { useChatStore, selectActiveConversationId } from '../../stores/chat.store'
import { trackToolOpen } from '../../services/tool-session-telemetry'
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
  /** Whether to show the "View live feed" button (default: true).
   *  Set to false in contexts where the Canvas browser is not available (e.g. automation apps). */
  showViewButton?: boolean
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


// ============================================
// Sub-components
// ============================================


/** The header's globe and each step's status icon share this column, centered on one axis. */
const ICON_COLUMN = 'flex-shrink-0 w-4 flex items-center justify-center'

/**
 * Single step item
 */
function StepItem({ step, isLatest }: { step: BrowserStep; isLatest: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 text-sm transition-all duration-300 ${
        isLatest ? 'opacity-100' : 'opacity-60'
      }`}
    >
      {/* Status indicator, in a column as wide as the header's globe so their centers line up */}
      <div className={`${ICON_COLUMN} h-5`}>
        {step.status === 'running' ? (
          <Loader2 size={14} className="text-primary animate-spin" />
        ) : step.status === 'success' ? (
          <CheckCircle2 size={14} className="text-halo-success" />
        ) : step.status === 'error' ? (
          <XCircle size={14} className="text-halo-error" />
        ) : (
          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
        )}
      </div>

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

export function BrowserTaskCard({ browserToolCalls, isActive, showViewButton = true }: BrowserTaskCardProps) {
  const [isExpanded, setIsExpanded] = useState(true)
  const attachAIBrowserView = useCanvasStore(state => state.attachAIBrowserView)
  const conversationId = useChatStore(selectActiveConversationId)
  const view = useActiveConversationBrowserView()
  const activeViewId = view?.viewId ?? null
  const setOperating = useAIBrowserStore(state => state.setOperating)

  const { t } = useTranslation()
  const actionMap = useMemo(() => ({
    'browser_navigate': {
      action: t('Navigate'),
      getDescription: (input: Record<string, unknown>) => `${input.url || ''}`
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
    'browser_tab': {
      action: t('Tab'),
      getDescription: (input: Record<string, unknown>) =>
        input.action === 'list' ? t('List tabs') :
        input.action === 'new' ? `${t('Open page')} ${input.url || ''}` :
        input.action === 'close' ? t('Close tab') :
        t('Switch tab')
    },
    'browser_inspect': {
      action: t('Inspect'),
      getDescription: (input: Record<string, unknown>) =>
        input.target === 'network' ? t('Network requests') : t('Console messages')
    },
    'browser_run': {
      action: t('Run script'),
      getDescription: (input: Record<string, unknown>) => {
        const file = String(input.file || '')
        const name = file.split('/').pop() || file
        return name.slice(0, 30)
      }
    },
    'browser_download': {
      action: t('Download'),
      getDescription: (input: Record<string, unknown>) => {
        if (input.url) {
          const url = String(input.url)
          return url.split('/').pop()?.slice(0, 30) || url.slice(0, 30)
        }
        return t('Waiting for download')
      }
    },
    'browser_upload_file': {
      action: t('Upload'),
      getDescription: (input: Record<string, unknown>) => {
        const fp = input.filePath
        if (Array.isArray(fp)) return `${fp.length} files`
        const path = String(fp || '')
        return path.split('/').pop() || path.slice(0, 30)
      }
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
      if (tc.name.includes('navigate') && input.url) {
        return String(input.url)
      }
    }
    return null
  }, [browserToolCalls])

  // Has running steps
  const hasRunningStep = steps.some(s => s.status === 'running')

  // Only the card of the running turn reports operating state: an older card
  // mounting with nothing running must not clear a newer one's.
  // Surfaces that hide the live view (IM, run detail, team) are not the conversation
  // on screen, whose id `conversationId` is: they must not mark it as operating.
  useEffect(() => {
    if (!isActive || !conversationId || !showViewButton) return
    setOperating(conversationId, hasRunningStep)
    return () => setOperating(conversationId, false)
  }, [isActive, hasRunningStep, conversationId, showViewButton, setOperating])

  // Show recent steps
  const visibleSteps = isExpanded ? steps : steps.slice(-3)

  // Reveal the AI's live browser in the Canvas by attaching the EXACT view the
  // on-screen conversation is driving (same WebContents) — never a fresh copy.
  // Without a known active view there is nothing live to show, so the button
  // stays disabled.
  const handleViewLive = () => {
    if (!activeViewId) return
    const urlToOpen = view?.url || currentUrl || ''
    trackToolOpen('browser', 'task_card', attachAIBrowserView(activeViewId, urlToOpen, t('🤖 AI Browser')))
  }

  // Don't render if no browser tool calls
  if (browserToolCalls.length === 0) {
    return null
  }

  return (
    <div className="browser-task-card mt-3 relative">
      {/* The same quiet surface as a reply; color marks only a browser in use. */}
      <div className="relative rounded-lg border border-border-soft bg-card overflow-hidden">

        {/* Header: title and step count, with the canvas link on the right like the team strip's. */}
        <div className="flex items-center gap-2 px-4 pt-3 pb-1.5 text-xs">
          {/* AI Browser icon */}
          <div className={`relative ${ICON_COLUMN}`}>
            <Globe
              size={16}
              className={isActive && hasRunningStep ? 'text-primary' : 'text-muted-foreground'}
            />
            {isActive && hasRunningStep && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-halo-success rounded-full" />
            )}
          </div>
          <span className="truncate font-semibold text-[13px]">
            {isActive && hasRunningStep ? t('AI is operating the browser') : t('AI browser actions')}
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="shrink-0 text-muted-foreground">
            {steps.filter(s => s.status === 'success').length}/{steps.length} {t('steps')}
          </span>

          {/* Hidden in contexts without the Canvas browser (e.g. automation apps). Enabled only
              once the AI's live view id is known, so it always reveals the exact view the AI
              drives (never a divergent copy). */}
          {showViewButton && (
            <button
              onClick={handleViewLive}
              disabled={!activeViewId}
              className="ml-auto shrink-0 inline-flex items-center gap-0.5 text-primary hover:underline disabled:text-muted-foreground disabled:no-underline disabled:cursor-not-allowed"
            >
              {t('Open browser view')}
              <ArrowUpRight size={11} />
            </button>
          )}
        </div>

        {/* Step list */}
        <div className="px-4 py-1.5 space-y-1.5 max-h-48 overflow-y-auto">
          {visibleSteps.map((step, index) => (
            <StepItem
              key={step.id}
              step={step}
              isLatest={index === visibleSteps.length - 1}
            />
          ))}
        </div>

        {/* Footer: the page in use, and the list toggle once it has more than three steps */}
        <div className="flex items-center justify-between gap-2 px-4 pt-1 pb-3 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            {currentUrl && (() => {
              try {
                return new URL(currentUrl).hostname
              } catch {
                return currentUrl.slice(0, 30)
              }
            })()}
          </span>
          {steps.length > 3 && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="shrink-0 hover:text-foreground transition-colors"
            >
              {isExpanded ? t('Collapse') : t('Expand')}
            </button>
          )}
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
