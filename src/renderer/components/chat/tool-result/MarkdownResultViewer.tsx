/**
 * MarkdownResultViewer - Display rendered Markdown content
 *
 * Features:
 * - Collapsed: renders only the first lines (tool output can be hundreds of KB)
 * - Expanded: full content; very large output renders chunk by chunk as it
 *   scrolls into view
 * - Copy raw source
 */

import { useState, useCallback, useMemo, useRef, type RefObject } from 'react'
import { Copy, Check, ChevronDown, ChevronUp, FileText } from 'lucide-react'
import { MarkdownRenderer } from '../MarkdownRenderer'
import { useTranslation } from '../../../i18n'
import { useLazyVisible } from '../../../hooks/useLazyVisible'
import { splitMarkdownIntoChunks } from '../../../lib/markdown-chunks'
import type { ViewerBaseProps } from './types'
import { truncateToLines, PREVIEW_MAX_CHARS } from './detection'

const PREVIEW_HEIGHT = 120
const PREVIEW_LINES = 40
/** Above this, expanded output is parsed per chunk instead of in one long task. */
const CHUNKED_EXPAND_THRESHOLD_CHARS = 32_000

function LazyMarkdownChunk({ content, root }: { content: string; root: RefObject<HTMLDivElement | null> }) {
  const [ref, isVisible] = useLazyVisible('400px', root)
  return (
    <div ref={ref} style={isVisible ? undefined : { minHeight: Math.ceil(content.length / 100) * 18 }}>
      {isVisible && <MarkdownRenderer content={content} className="tool-result-markdown" />}
    </div>
  )
}

export function MarkdownResultViewer({
  output,
  isError,
  toolInput
}: ViewerBaseProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const preview = useMemo(
    () => truncateToLines(output, PREVIEW_LINES, PREVIEW_MAX_CHARS),
    [output],
  )
  const chunks = useMemo(
    () => (isExpanded && output.length > CHUNKED_EXPAND_THRESHOLD_CHARS ? splitMarkdownIntoChunks(output) : null),
    [isExpanded, output],
  )
  const needsExpand = preview.truncated || overflows

  // Check if content overflows preview height
  const checkOverflow = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      setOverflows(node.scrollHeight > PREVIEW_HEIGHT)
    }
  }, [])

  // Copy handler (copies raw markdown)
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(output)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [output])

  // Toggle expand
  const handleToggle = useCallback(() => {
    setIsExpanded(prev => !prev)
  }, [])

  return (
    <div
      className={`
        mt-1.5 rounded-lg overflow-hidden border
        ${isError
          ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-border/30 bg-muted/20'
        }
      `}
    >
      {/* Markdown content */}
      <div
        ref={(node) => {
          contentRef.current = node
          checkOverflow(node)
        }}
        className={`
          relative overflow-hidden transition-all duration-200 ease-out
          ${isExpanded ? 'max-h-[400px] overflow-y-auto scrollbar-thin' : 'max-h-[120px]'}
        `}
      >
        <div className="px-3 py-2 text-[12px]">
          {!isExpanded ? (
            <MarkdownRenderer content={preview.content} className="tool-result-markdown" />
          ) : chunks ? (
            chunks.map((chunk, index) => <LazyMarkdownChunk key={index} content={chunk} root={contentRef} />)
          ) : (
            <MarkdownRenderer content={output} className="tool-result-markdown" />
          )}
        </div>

        {/* Gradient mask when collapsed and has overflow */}
        {!isExpanded && needsExpand && (
          <div
            className="absolute bottom-0 left-0 right-0 h-10 pointer-events-none"
            style={{
              background: 'linear-gradient(to bottom, transparent, hsl(var(--muted) / 0.3))'
            }}
          />
        )}
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
        {/* Left side: type indicator */}
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <FileText size={10} />
            Markdown
          </span>
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
                <span className="hidden sm:inline">{t('Copy source')}</span>
              </>
            )}
          </button>

          {/* Expand/Collapse button */}
          {needsExpand && (
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
