/**
 * DiffContent - Professional diff view using react-diff-viewer-continued
 *
 * Features:
 * - Split (side-by-side) and unified view modes
 * - Syntax highlighting
 * - Line numbers
 * - Word-level diff highlighting
 * - Support for multiple edit chunks (when same file edited multiple times)
 */

import { useMemo, useState } from 'react'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { ChevronDown, Columns2, AlignJustify } from 'lucide-react'
import type { EditChunk } from './utils'
import { useTranslation } from '../../i18n'

interface DiffContentProps {
  type: 'edit' | 'write'
  oldString?: string
  newString?: string
  content?: string  // For write type
  fileName?: string // For syntax detection
  editChunks?: EditChunk[]  // Multiple edit chunks for same file
}

// Custom styles for the diff viewer to match Halo's dark theme
const customStyles = {
  variables: {
    dark: {
      diffViewerBackground: 'transparent',
      diffViewerColor: 'hsl(var(--foreground))',
      addedBackground: 'hsla(142, 76%, 36%, 0.15)',
      addedColor: 'hsl(142, 76%, 60%)',
      removedBackground: 'hsla(0, 84%, 60%, 0.15)',
      removedColor: 'hsl(0, 84%, 70%)',
      wordAddedBackground: 'hsla(142, 76%, 36%, 0.35)',
      wordRemovedBackground: 'hsla(0, 84%, 60%, 0.35)',
      addedGutterBackground: 'hsla(142, 76%, 36%, 0.1)',
      removedGutterBackground: 'hsla(0, 84%, 60%, 0.1)',
      gutterBackground: 'hsl(var(--muted))',
      gutterBackgroundDark: 'hsl(var(--muted))',
      highlightBackground: 'hsla(var(--primary), 0.1)',
      highlightGutterBackground: 'hsla(var(--primary), 0.2)',
      codeFoldGutterBackground: 'hsl(var(--muted))',
      codeFoldBackground: 'hsl(var(--muted))',
      emptyLineBackground: 'transparent',
      gutterColor: 'hsl(var(--muted-foreground))',
      addedGutterColor: 'hsl(142, 76%, 50%)',
      removedGutterColor: 'hsl(0, 84%, 60%)',
      codeFoldContentColor: 'hsl(var(--muted-foreground))',
      diffViewerTitleBackground: 'hsl(var(--muted))',
      diffViewerTitleColor: 'hsl(var(--foreground))',
      diffViewerTitleBorderColor: 'hsl(var(--border))',
    },
    light: {
      diffViewerBackground: 'transparent',
      diffViewerColor: 'hsl(var(--foreground))',
      addedBackground: 'hsla(142, 76%, 36%, 0.12)',
      addedColor: 'hsl(142, 60%, 30%)',
      removedBackground: 'hsla(0, 84%, 60%, 0.12)',
      removedColor: 'hsl(0, 70%, 40%)',
      wordAddedBackground: 'hsla(142, 76%, 36%, 0.3)',
      wordRemovedBackground: 'hsla(0, 84%, 60%, 0.3)',
      addedGutterBackground: 'hsla(142, 76%, 36%, 0.08)',
      removedGutterBackground: 'hsla(0, 84%, 60%, 0.08)',
      gutterBackground: 'hsl(var(--muted))',
      gutterBackgroundDark: 'hsl(var(--muted))',
      highlightBackground: 'hsla(var(--primary), 0.08)',
      highlightGutterBackground: 'hsla(var(--primary), 0.15)',
      codeFoldGutterBackground: 'hsl(var(--muted))',
      codeFoldBackground: 'hsl(var(--muted))',
      emptyLineBackground: 'transparent',
      gutterColor: 'hsl(var(--muted-foreground))',
      addedGutterColor: 'hsl(142, 60%, 35%)',
      removedGutterColor: 'hsl(0, 70%, 45%)',
      codeFoldContentColor: 'hsl(var(--muted-foreground))',
      diffViewerTitleBackground: 'hsl(var(--muted))',
      diffViewerTitleColor: 'hsl(var(--foreground))',
      diffViewerTitleBorderColor: 'hsl(var(--border))',
    },
  },
  line: {
    padding: '4px 8px',
    fontSize: '12px',
    lineHeight: '1.5',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  gutter: {
    minWidth: '40px',
    padding: '0 8px',
    fontSize: '11px',
  },
  contentText: {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  wordDiff: {
    padding: '1px 2px',
    borderRadius: '2px',
  },
}

// Detect if dark mode is active
function useIsDarkMode(): boolean {
  // Check if html element has 'light' class (our theme system uses dark as default)
  if (typeof document !== 'undefined') {
    return !document.documentElement.classList.contains('light')
  }
  return true
}

// Single diff chunk component
function DiffChunk({
  oldString,
  newString,
  chunkIndex,
  totalChunks,
  splitView,
  isDark,
  t
}: {
  oldString: string
  newString: string
  chunkIndex?: number
  totalChunks?: number
  splitView: boolean
  isDark: boolean
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  return (
    <div className={chunkIndex !== undefined && chunkIndex > 0 ? 'border-t border-border/30 pt-2 mt-2' : ''}>
      {/* Chunk header for multiple edits */}
      {totalChunks !== undefined && totalChunks > 1 && (
        <div className="px-3 py-1.5 text-xs text-muted-foreground bg-muted/30 border-b border-border/20">
          {t('Edit {{current}} / {{total}}', { current: (chunkIndex || 0) + 1, total: totalChunks })}
        </div>
      )}

      <ReactDiffViewer
        oldValue={oldString}
        newValue={newString}
        splitView={splitView}
        useDarkTheme={isDark}
        styles={customStyles}
        compareMethod={DiffMethod.WORDS}
        hideLineNumbers={false}
        showDiffOnly={false}
        extraLinesSurroundingDiff={3}
      />
    </div>
  )
}

export function DiffContent({
  type,
  oldString,
  newString,
  content,
  fileName,
  editChunks
}: DiffContentProps) {
  const [splitView, setSplitView] = useState(false)
  const isDark = useIsDarkMode()
  const { t } = useTranslation()

  // For write type, show all content as "added"
  const effectiveOldString = type === 'write' ? '' : (oldString || '')
  const effectiveNewString = type === 'write' ? (content || '') : (newString || '')

  // Calculate stats
  const stats = useMemo(() => {
    if (type === 'write') {
      const lines = (content || '').split('\n').length
      return { added: lines, removed: 0 }
    }

    const oldLines = (oldString || '').split('\n')
    const newLines = (newString || '').split('\n')

    // Simple line count (the diff viewer shows actual changes)
    return {
      added: Math.max(0, newLines.length - oldLines.length + 1),
      removed: Math.max(0, oldLines.length - newLines.length + 1)
    }
  }, [type, content, oldString, newString])

  return (
    <div className="overflow-hidden">
      {/* Header with view mode toggle */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b border-border/30">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {type === 'write' ? (
            <span className="text-green-400/80">
              {t('New file ({{lines}} lines)', { lines: stats.added })}
            </span>
          ) : (
            <>
              <span className="text-green-400/80">+{stats.added}</span>
              <span className="text-muted-foreground/50">/</span>
              <span className="text-red-400/80">-{stats.removed}</span>
              {editChunks && editChunks.length > 1 && (
                <span className="ml-2 text-amber-400/70">
                  ({t('{{count}} edits', { count: editChunks.length })})
                </span>
              )}
            </>
          )}
        </div>

        {/* View mode toggle */}
        {type === 'edit' && (
          <div className="flex items-center gap-1 bg-muted/50 rounded-md p-0.5">
            <button
              onClick={() => setSplitView(false)}
              className={`p-1.5 rounded transition-colors ${
                !splitView
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title={t('Unified view')}
            >
              <AlignJustify size={14} />
            </button>
            <button
              onClick={() => setSplitView(true)}
              className={`p-1.5 rounded transition-colors ${
                splitView
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title={t('Split view')}
            >
              <Columns2 size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Diff content */}
      <div className="overflow-auto max-h-[60vh]">
        {/* Multiple edit chunks */}
        {editChunks && editChunks.length > 0 ? (
          editChunks.map((chunk, index) => (
            <DiffChunk
              key={chunk.id}
              oldString={chunk.oldString}
              newString={chunk.newString}
              chunkIndex={index}
              totalChunks={editChunks.length}
              splitView={splitView}
              isDark={isDark}
              t={t}
            />
          ))
        ) : (
          /* Single diff */
          <ReactDiffViewer
            oldValue={effectiveOldString}
            newValue={effectiveNewString}
            splitView={splitView}
            useDarkTheme={isDark}
            styles={customStyles}
            compareMethod={DiffMethod.WORDS}
            hideLineNumbers={false}
            showDiffOnly={type === 'edit'}
            extraLinesSurroundingDiff={3}
          />
        )}
      </div>

      {/* Empty state */}
      {!effectiveNewString && !effectiveOldString && (!editChunks || editChunks.length === 0) && (
        <div className="py-8 text-center text-muted-foreground/50">
          {t('No changes')}
        </div>
      )}
    </div>
  )
}
