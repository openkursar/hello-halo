/**
 * JsonResultViewer - Display formatted and highlighted JSON
 *
 * Features:
 * - Automatic pretty-print formatting
 * - JSON syntax highlighting
 * - Preview mode (6 lines) with expand
 * - Copy to clipboard
 */

import { useState, useCallback, useMemo } from 'react'
import { Copy, Check, ChevronDown, ChevronUp, Braces } from 'lucide-react'
import { useAsyncHighlight } from '../../../hooks/useAsyncHighlight'
import { useTranslation } from '../../../i18n'
import type { ViewerBaseProps } from './types'
import { truncateToLines } from './detection'

const PREVIEW_LINES = 6

export function JsonResultViewer({
  output,
  isError,
  toolInput
}: ViewerBaseProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  // Parse and format JSON
  const formattedJson = useMemo(() => {
    try {
      const parsed = JSON.parse(output)
      return JSON.stringify(parsed, null, 2)
    } catch {
      // If not valid JSON, return as-is
      return output
    }
  }, [output])

  // Parse content for preview
  const { content: previewContent, totalLines, truncated } = useMemo(() => {
    return truncateToLines(formattedJson, PREVIEW_LINES)
  }, [formattedJson])

  const displayContent = isExpanded ? formattedJson : previewContent

  // Async highlight: shows plain text instantly, then swaps in highlighted HTML
  const highlightedJson = useAsyncHighlight(displayContent, 'json')

  // Copy handler
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(formattedJson)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [formattedJson])

  // Toggle expand
  const handleToggle = useCallback(() => {
    setIsExpanded(prev => !prev)
  }, [])

  return (
    <div
      className={`
        mt-1.5 rounded-lg overflow-hidden border
        ${isError
          ? 'border-destructive/30 bg-destructive/5'
          : 'border-border/30 bg-muted/20'
        }
      `}
    >
      {/* JSON content */}
      <div
        className={`
          overflow-hidden transition-all duration-200 ease-out
          ${isExpanded ? 'max-h-[400px] overflow-y-auto scrollbar-thin' : 'max-h-[140px]'}
        `}
      >
        <pre
          className={`
            px-3 py-2 text-[11px] font-mono leading-relaxed m-0 overflow-x-auto
            ${isError ? 'text-destructive/80' : ''}
          `}
        >
          <code
            className="hljs language-json"
            dangerouslySetInnerHTML={{ __html: highlightedJson }}
          />
        </pre>

        {/* Truncation indicator */}
        {truncated && !isExpanded && (
          <div className="px-3 pb-2 text-[10px] text-muted-foreground/40">
            ⋯
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        className={`
          flex items-center justify-between
          px-2.5 py-[1px]
          border-t text-[10px]
          ${isError
            ? 'border-destructive/20 bg-destructive/10 text-destructive/60'
            : 'border-border/20 bg-muted/30 text-muted-foreground/60'
          }
        `}
      >
        {/* Left side: type and stats */}
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <Braces size={10} />
            JSON
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>{t('{{count}} lines', { count: totalLines })}</span>
        </div>

        {/* Right side: actions */}
        <div className="flex items-center gap-1">
          {/* Copy button */}
          <button
            onClick={handleCopy}
            className={`
              flex items-center gap-1 px-2 py-0.5 rounded
              hover:bg-white/10 hover:text-foreground
              transition-colors
            `}
          >
            {copied ? (
              <>
                <Check size={10} className="text-green-400" />
                {/* Text hidden on mobile */}
                <span className="hidden sm:inline text-green-400">{t('Copied')}</span>
              </>
            ) : (
              <>
                <Copy size={10} />
                {/* Text hidden on mobile */}
                <span className="hidden sm:inline">{t('Copy')}</span>
              </>
            )}
          </button>

          {/* Expand/Collapse button */}
          {truncated && (
            <button
              onClick={handleToggle}
              className={`
                flex items-center gap-1 px-2 py-0.5 rounded
                hover:bg-white/10 hover:text-foreground
                transition-colors
              `}
            >
              {isExpanded ? (
                <>
                  <ChevronUp size={10} />
                  {/* Text hidden on mobile */}
                  <span className="hidden sm:inline">{t('Collapse')}</span>
                </>
              ) : (
                <>
                  <ChevronDown size={10} />
                  {/* Text hidden on mobile */}
                  <span className="hidden sm:inline">{t('Expand all')}</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
