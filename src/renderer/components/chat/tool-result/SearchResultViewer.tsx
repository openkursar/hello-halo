/**
 * SearchResultViewer - Display Grep search results
 *
 * Features:
 * - File paths with icons
 * - Line numbers for each match
 * - Match highlighting
 * - Grouped by file
 * - Preview mode with expand
 */

import { useState, useCallback, useMemo } from 'react'
import { Copy, Check, ChevronDown, ChevronUp, Search, FileText, Folder } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import type { ViewerBaseProps } from './types'
import { parseGrepOutput } from './detection'

const PREVIEW_MATCHES = 5

export function SearchResultViewer({
  output,
  isError,
  toolInput
}: ViewerBaseProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  // Extract search pattern from tool input
  const pattern = (toolInput?.pattern as string) || ''

  // Parse grep output
  const { matches, fileCount, matchCount } = useMemo(() => {
    return parseGrepOutput(output)
  }, [output])

  // Group matches by file
  const groupedMatches = useMemo(() => {
    const groups = new Map<string, typeof matches>()
    for (const match of matches) {
      const existing = groups.get(match.filePath) || []
      existing.push(match)
      groups.set(match.filePath, existing)
    }
    return Array.from(groups.entries())
  }, [matches])

  // Determine what to display
  const displayMatches = isExpanded ? matches : matches.slice(0, PREVIEW_MATCHES)
  const displayGroups = useMemo(() => {
    if (isExpanded) return groupedMatches

    // In preview mode, limit total matches shown
    const result: typeof groupedMatches = []
    let count = 0
    for (const [file, fileMatches] of groupedMatches) {
      if (count >= PREVIEW_MATCHES) break
      const remaining = PREVIEW_MATCHES - count
      result.push([file, fileMatches.slice(0, remaining)])
      count += Math.min(fileMatches.length, remaining)
    }
    return result
  }, [groupedMatches, isExpanded])

  const hasMore = matches.length > PREVIEW_MATCHES

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

  // Highlight match in content
  const highlightMatch = (content: string, pattern: string) => {
    if (!pattern || !content) return content

    try {
      // Escape special regex characters for literal matching
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`(${escaped})`, 'gi')
      const parts = content.split(regex)

      return parts.map((part, i) => {
        if (regex.test(part)) {
          return (
            <span
              key={i}
              className="bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 px-0.5 rounded"
            >
              {part}
            </span>
          )
        }
        return part
      })
    } catch {
      return content
    }
  }

  // If no matches, show simple message
  if (matches.length === 0) {
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
          {t('No matches found')}
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
      {/* Results content */}
      <div
        className={`
          overflow-hidden transition-all duration-200 ease-out
          ${isExpanded ? 'max-h-[400px] overflow-y-auto scrollbar-thin' : 'max-h-[200px]'}
        `}
      >
        <div className="py-2 px-3 space-y-2">
          {displayGroups.map(([filePath, fileMatches]) => (
            <div key={filePath} className="space-y-0.5">
              {/* File path header */}
              <div className="flex items-center gap-1.5 text-[11px] text-primary/80 font-medium">
                <FileText size={12} />
                <span className="font-mono truncate">{filePath}</span>
              </div>

              {/* Matches in this file */}
              {fileMatches.filter(m => m.content).map((match, i) => (
                <div
                  key={`${match.filePath}-${match.lineNumber}-${i}`}
                  className="flex gap-2 pl-4 text-[11px] font-mono"
                >
                  {/* Line number */}
                  <span className="flex-shrink-0 text-muted-foreground/40 w-8 text-right">
                    {match.lineNumber}
                  </span>
                  {/* Content with highlight */}
                  <span className="text-foreground/80 truncate">
                    {highlightMatch(match.content, pattern)}
                  </span>
                </div>
              ))}
            </div>
          ))}

          {/* Show more indicator */}
          {hasMore && !isExpanded && (
            <div className="pt-1 text-[10px] text-muted-foreground/40 pl-4">
              ⋯ {t('and {{count}} more', { count: matches.length - PREVIEW_MATCHES })}
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
            <Search size={10} />
            {t('{{count}} matches', { count: matchCount })}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>{t('{{count}} files', { count: fileCount })}</span>
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
