/**
 * ThinkingBlock - Displays agent reasoning process
 * A collapsible component showing the agent's internal thinking
 */

import { useState } from 'react'
import type { ThinkingBlock as ThinkingBlockType } from '../../types'
import { useTranslation } from '../../i18n'

interface ThinkingBlockProps {
  blocks: ThinkingBlockType[]
  isThinking: boolean
}

export function ThinkingBlock({ blocks, isThinking }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const { t } = useTranslation()

  // Don't render if no thinking blocks and not thinking
  if (blocks.length === 0 && !isThinking) {
    return null
  }

  // Calculate total thinking content
  const totalContent = blocks.map(b => b.content).join('\n\n')
  const previewLength = 100
  const hasMoreContent = totalContent.length > previewLength

  return (
    <div className="animate-fade-in mb-4">
      <div
        className={`
          relative rounded-xl border transition-all duration-300
          ${isThinking
            ? 'border-primary/50 bg-primary/5 thinking-pulse'
            : 'border-border/50 bg-card/30'
          }
        `}
      >
        {/* Header - Always visible */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors rounded-xl"
        >
          {/* Thinking indicator */}
          <div className="flex items-center gap-2">
            {isThinking ? (
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <div className="w-2 h-2 rounded-full bg-primary animate-pulse" style={{ animationDelay: '0.2s' }} />
                <div className="w-2 h-2 rounded-full bg-primary animate-pulse" style={{ animationDelay: '0.4s' }} />
              </div>
            ) : (
              <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            )}
          </div>

          {/* Title */}
          <span className={`text-sm font-medium ${isThinking ? 'text-primary' : 'text-muted-foreground'}`}>
            {isThinking ? t('Thinking...') : t('Thought process')}
          </span>

          {/* Preview text when collapsed */}
          {!isExpanded && totalContent && (
            <span className="flex-1 text-xs text-muted-foreground/60 truncate ml-2">
              {totalContent.substring(0, previewLength)}
              {hasMoreContent && '...'}
            </span>
          )}

          {/* Expand indicator */}
          <svg
            className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Expanded content */}
        {isExpanded && (
          <div className="px-4 pb-4 animate-slide-down">
            <div className="border-t border-border/30 pt-3">
              {blocks.map((block, index) => (
                <div
                  key={block.id}
                  className={`
                    text-sm text-muted-foreground/80 whitespace-pre-wrap
                    ${index > 0 ? 'mt-3 pt-3 border-t border-border/20' : ''}
                  `}
                >
                  {block.content}
                </div>
              ))}

              {/* Thinking cursor when actively thinking */}
              {isThinking && (
                <span className="inline-block w-2 h-4 ml-1 bg-primary/50 animate-pulse" />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
