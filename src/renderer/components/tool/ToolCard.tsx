/**
 * ToolCard - Displays tool call status with Lucide icons
 * Shows detailed information about tool execution and approval workflow
 */

import { useState } from 'react'
import {
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  Copy,
  Check,
  AlertTriangle,
} from 'lucide-react'
import { ToolIcon } from '../icons/ToolIcons'
import { useChatStore } from '../../stores/chat.store'
import type { ToolCall } from '../../types'
import { useTranslation } from '../../i18n'

interface ToolCardProps {
  toolCall: ToolCall
  conversationId?: string
}

export function ToolCard({ toolCall, conversationId }: ToolCardProps) {
  const { t } = useTranslation()
  const { approveTool, rejectTool } = useChatStore()
  const [isExpanded, setIsExpanded] = useState(false)
  const [isCopied, setIsCopied] = useState(false)

  const statusConfig = {
    pending: {
      icon: Clock,
      text: t('Pending'),
      className: 'tool-pending',
      color: 'text-muted-foreground',
    },
    running: {
      icon: Loader2,
      text: t('Running'),
      className: 'tool-running',
      color: 'text-primary',
      spin: true,
    },
    success: {
      icon: CheckCircle2,
      text: t('Completed'),
      className: 'tool-success',
      color: 'text-green-500',
    },
    error: {
      icon: XCircle,
      text: t('Failed'),
      className: 'tool-error',
      color: 'text-red-500',
    },
    waiting_approval: {
      icon: AlertCircle,
      text: t('Needs confirmation'),
      className: 'tool-waiting',
      color: 'text-yellow-500',
    },
  } as const

  const status = statusConfig[toolCall.status] || statusConfig.pending
  const StatusIcon = status.icon

  // Get tool display name
  const getToolDisplayName = (name: string) => {
    switch (name) {
      case 'Read':
        return t('Read file')
      case 'Write':
        return t('Create file')
      case 'Edit':
        return t('Edit file')
      case 'Bash':
        return t('Execute command')
      case 'Grep':
        return t('Search content')
      case 'Glob':
        return t('Find files')
      case 'WebFetch':
        return t('Fetch web page')
      case 'WebSearch':
        return t('Search the web')
      case 'TodoWrite':
        return t('Task list')
      case 'Task':
        return t('Subtask')
      case 'NotebookEdit':
        return t('Edit notebook')
      case 'AskUserQuestion':
        return t('Ask user')
      default:
        return name
    }
  }

  // Get tool description
  const getToolDescription = () => {
    if (toolCall.description) return toolCall.description

    const input = toolCall.input
    switch (toolCall.name) {
      case 'Read':
        return input.file_path as string
      case 'Write':
        return input.file_path as string
      case 'Edit':
        return input.file_path as string
      case 'Bash':
        return input.command as string
      case 'Grep':
        return t('Search: {{pattern}}', { pattern: input.pattern as string })
      case 'Glob':
        return t('Pattern: {{pattern}}', { pattern: input.pattern as string })
      default:
        return JSON.stringify(input).slice(0, 50)
    }
  }

  // Handle copy
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(toolCall.output || '')
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  return (
    <div className={`border rounded-xl overflow-hidden transition-all duration-200 ${status.className}`}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2.5 bg-secondary/30 cursor-pointer hover:bg-secondary/50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2.5">
          {/* Tool icon */}
          <div className={status.color}>
            <ToolIcon name={toolCall.name} size={16} />
          </div>
          {/* Tool name and status */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {getToolDisplayName(toolCall.name)}
            </span>
            <div className={`flex items-center gap-1 ${status.color}`}>
              <StatusIcon
                size={12}
                className={status.spin ? 'animate-spin' : ''}
              />
              <span className="text-xs">{status.text}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {toolCall.status === 'success' && (
            <span className="text-xs text-muted-foreground">
              {isExpanded ? t('Collapse') : t('View')}
            </span>
          )}

          <ChevronDown
            size={16}
            className={`text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
          />
        </div>
      </div>

      {/* Description - file path or command */}
      <div className="px-3 py-2 text-sm text-muted-foreground border-t border-border/30">
        <code className="text-xs bg-secondary/50 px-1.5 py-0.5 rounded font-mono">
          {getToolDescription()}
        </code>
      </div>

      {/* Progress bar for running */}
      {toolCall.status === 'running' && (
        <div className="h-1 bg-secondary/50 overflow-hidden">
          {toolCall.progress ? (
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${toolCall.progress}%` }}
            />
          ) : (
            <div className="h-full w-1/3 bg-primary progress-indeterminate" />
          )}
        </div>
      )}

      {/* Approval buttons */}
      {toolCall.status === 'waiting_approval' && (
        <div className="px-3 py-3 border-t border-border bg-yellow-500/5">
          <p className="text-xs text-muted-foreground mb-3">
            {t('This action requires your confirmation to continue')}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => conversationId && approveTool(conversationId)}
              disabled={!conversationId}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium
                bg-green-500/20 text-green-400 rounded-lg
                hover:bg-green-500/30 active:bg-green-500/40
                transition-all duration-150
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Check size={16} />
              {t('Allow')}
            </button>
            <button
              onClick={() => conversationId && rejectTool(conversationId)}
              disabled={!conversationId}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium
                bg-red-500/20 text-red-400 rounded-lg
                hover:bg-red-500/30 active:bg-red-500/40
                transition-all duration-150
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <XCircle size={16} />
              {t('Reject')}
            </button>
          </div>
        </div>
      )}

      {/* Expanded content */}
      {isExpanded && toolCall.output && (
        <div className="border-t border-border animate-slide-down">
          <div className="px-3 py-2 bg-background/50">
            <pre className="text-xs text-muted-foreground overflow-auto max-h-48 p-2 bg-secondary/30 rounded-lg font-mono whitespace-pre-wrap">
              {toolCall.output.slice(0, 2000)}
              {toolCall.output.length > 2000 && `\n${t('...(content truncated)')}`}
            </pre>
          </div>
          <div className="flex justify-end gap-2 px-3 py-2 border-t border-border/30">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {isCopied ? (
                <>
                  <Check size={14} className="text-green-500" />
                  {t('Copied')}
                </>
              ) : (
                <>
                  <Copy size={14} />
                  {t('Copy')}
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Error message */}
      {toolCall.status === 'error' && toolCall.error && (
        <div className="px-3 py-2.5 border-t border-border bg-red-500/5">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
            <span className="text-sm text-red-400">{toolCall.error}</span>
          </div>
        </div>
      )}
    </div>
  )
}
