/**
 * CodeResultViewer - Code display with syntax highlighting
 *
 * Features:
 * - Syntax highlighting via highlight.js
 * - Preview mode (8 lines) with expand
 * - Copy to clipboard
 * - Error state styling
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Copy, Check, ChevronDown, ChevronUp, FileText } from 'lucide-react'
import { useAsyncHighlight } from '../../../hooks/useAsyncHighlight'
import { useTranslation } from '../../../i18n'
import type { ViewerBaseProps } from './types'
import { countLines, truncateToLines, removeLineNumberPrefix } from './detection'

const PREVIEW_LINES = 8
const MAX_EXPANDED_HEIGHT = 400

interface CodeResultViewerProps extends ViewerBaseProps {
  language?: string
}

export function CodeResultViewer({
  output,
  isError,
  language = 'text',
  toolInput
}: CodeResultViewerProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  // Clean output: remove line number prefixes from tool output (cat -n format)
  const cleanedOutput = useMemo(() => {
    return removeLineNumberPrefix(output)
  }, [output])

  // Parse content
  const { content: previewContent, totalLines, truncated } = useMemo(() => {
    return truncateToLines(cleanedOutput, PREVIEW_LINES)
  }, [cleanedOutput])

  const displayContent = isExpanded ? cleanedOutput : previewContent

  // Async highlight: shows plain text instantly, then swaps in highlighted HTML
  const highlightedCode = useAsyncHighlight(displayContent, language)

  // Copy handler - copy cleaned content
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(cleanedOutput)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [cleanedOutput])

  // Toggle expand
  const handleToggle = useCallback(() => {
    setIsExpanded(prev => !prev)
  }, [])

  // Scroll to top when collapsing
  useEffect(() => {
    if (!isExpanded && contentRef.current) {
      contentRef.current.scrollTop = 0
    }
  }, [isExpanded])

  return (
    <div
      className={`
        mt-1.5 rounded-lg overflow-hidden border transition-colors
        ${isError
          ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-border/30 bg-muted/20'
        }
      `}
    >
      {/* Code content */}
      <div
        ref={contentRef}
        className={`
          overflow-hidden transition-all duration-200 ease-out
          ${isExpanded ? 'max-h-[400px] overflow-y-auto scrollbar-thin' : 'max-h-[160px]'}
        `}
      >
        <pre
          className={`
            px-3 py-2 text-[11px] font-mono leading-relaxed m-0 overflow-x-auto
            ${isError ? 'text-amber-600/80' : ''}
          `}
        >
          <code
            className={`hljs ${language ? `language-${language}` : ''}`}
            dangerouslySetInnerHTML={{ __html: highlightedCode }}
          />
          {truncated && !isExpanded && (
            <span className="text-muted-foreground/30 block">⋯</span>
          )}
        </pre>
      </div>

      {/* Footer */}
      <div
        className={`
          flex items-center justify-between
          px-2.5 py-[1px]
          border-t text-[10px]
          ${isError
            ? 'border-amber-500/20 bg-amber-500/10 text-amber-600/60'
            : 'border-border/20 bg-muted/30 text-muted-foreground/60'
          }
        `}
      >
        {/* Left side: stats */}
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <FileText size={10} />
            {t('{{count}} lines', { count: totalLines })}
          </span>
          {/* Language label - hidden on mobile */}
          <span className="hidden sm:inline text-muted-foreground/40">·</span>
          <span className="hidden sm:inline">{language}</span>
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
