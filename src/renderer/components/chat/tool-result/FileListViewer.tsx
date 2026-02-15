/**
 * FileListViewer - Display Glob file/folder list results
 *
 * Features:
 * - File and folder icons
 * - Relative path display
 * - Preview mode (6 items) with expand
 * - File/folder count statistics
 */

import { useState, useCallback, useMemo } from 'react'
import { Copy, Check, ChevronDown, ChevronUp, FileText, Folder, FolderOpen } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import type { ViewerBaseProps } from './types'
import { parseGlobOutput } from './detection'

const PREVIEW_ITEMS = 6

export function FileListViewer({
  output,
  isError,
  toolInput
}: ViewerBaseProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  // Parse glob output
  const { items, fileCount, folderCount } = useMemo(() => {
    return parseGlobOutput(output)
  }, [output])

  // Determine what to display
  const displayItems = isExpanded ? items : items.slice(0, PREVIEW_ITEMS)
  const hasMore = items.length > PREVIEW_ITEMS

  // Copy handler
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

  // If no items, show simple message
  if (items.length === 0) {
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
        <div className="px-3 py-2 text-[11px] text-muted-foreground/60">
          {t('No files found')}
        </div>
      </div>
    )
  }

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
      {/* File list content */}
      <div
        className={`
          overflow-hidden transition-all duration-200 ease-out
          ${isExpanded ? 'max-h-[400px] overflow-y-auto scrollbar-thin' : 'max-h-[160px]'}
        `}
      >
        <div className="py-2 px-3 space-y-0.5">
          {displayItems.map((item, index) => (
            <div
              key={`${item.path}-${index}`}
              className="flex items-center gap-2 text-[11px] font-mono"
            >
              {/* Icon */}
              {item.isDirectory ? (
                <Folder size={12} className="text-amber-500/70 flex-shrink-0" />
              ) : (
                <FileText size={12} className="text-primary/60 flex-shrink-0" />
              )}

              {/* Path */}
              <span className="text-foreground/80 truncate">
                {item.path}
              </span>
            </div>
          ))}

          {/* Show more indicator */}
          {hasMore && !isExpanded && (
            <div className="pt-1 pl-5 text-[10px] text-muted-foreground/40">
              ⋯ {t('and {{count}} more', { count: items.length - PREVIEW_ITEMS })}
            </div>
          )}
        </div>
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
            <FolderOpen size={10} />
            {t('{{count}} files', { count: fileCount })}
          </span>
          {folderCount > 0 && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span>{t('{{count}} folders', { count: folderCount })}</span>
            </>
          )}
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
          {hasMore && (
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
