/**
 * MarkdownResultViewer - Display rendered Markdown content
 *
 * Features:
 * - Full markdown rendering via react-markdown
 * - Preview mode with gradient mask
 * - Copy raw source
 * - Expand to full content
 */

import { useState, useCallback, useRef } from 'react'
import { Copy, Check, ChevronDown, ChevronUp, FileText } from 'lucide-react'
import { MarkdownRenderer } from '../MarkdownRenderer'
import { useTranslation } from '../../../i18n'
import type { ViewerBaseProps } from './types'
import { countLines } from './detection'

const PREVIEW_HEIGHT = 120
const MAX_EXPANDED_HEIGHT = 400

export function MarkdownResultViewer({
  output,
  isError,
  toolInput
}: ViewerBaseProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [needsExpand, setNeedsExpand] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  // Check if content overflows preview height
  const checkOverflow = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      setNeedsExpand(node.scrollHeight > PREVIEW_HEIGHT)
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

  const lineCount = countLines(output)

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
          <MarkdownRenderer content={output} className="tool-result-markdown" />
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
