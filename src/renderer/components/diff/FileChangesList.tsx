/**
 * FileChangesList - Scrollable list of changed files
 * Layer 2: Shows file names with stats, click to open diff modal
 *
 * Design:
 * - Fixed max height with scroll for many files
 * - Tree-like visual hierarchy (edits first, then writes)
 * - Hover effect to indicate clickability
 * - Stats inline for quick scanning
 */

import { FileText, FilePlus, ChevronRight } from 'lucide-react'
import { formatStats } from './utils'
import type { FileChange, FileChanges } from './types'
import { useTranslation } from '../../i18n'

interface FileChangesListProps {
  changes: FileChanges
  onFileClick: (file: FileChange) => void
}

// Single file item
function FileItem({
  file,
  isLast,
  onClick,
  t
}: {
  file: FileChange
  isLast: boolean
  onClick: () => void
  t: (key: string) => string
}) {
  const isWrite = file.type === 'write'
  const Icon = isWrite ? FilePlus : FileText

  return (
    <button
      onClick={onClick}
      className={`
        w-full flex items-center gap-2 px-2 py-1.5 -mx-2
        rounded-md text-xs transition-all duration-150
        hover:bg-muted/40 group
        ${!isLast ? 'border-b border-border/10' : ''}
      `}
    >
      {/* Tree connector */}
      <span className="text-muted-foreground/30 font-mono">
        {isLast ? '└─' : '├─'}
      </span>

      {/* File icon */}
      <Icon
        size={14}
        className={isWrite ? 'text-green-400/70' : 'text-amber-400/70'}
      />

      {/* File name */}
      <span className="flex-1 text-left truncate text-foreground/80 group-hover:text-foreground">
        {file.fileName}
      </span>

      {/* Stats */}
      <span className={`
        font-mono text-[11px] shrink-0
        ${file.stats.removed > 0 ? 'text-red-400/70' : ''}
        ${file.stats.added > 0 && file.stats.removed === 0 ? 'text-green-400/70' : ''}
        ${file.stats.added > 0 && file.stats.removed > 0 ? 'text-muted-foreground' : ''}
      `}>
        {isWrite ? (
          <span className="text-green-400/70">{t('New')}</span>
        ) : (
          <>
            {file.stats.added > 0 && (
              <span className="text-green-400/70">+{file.stats.added}</span>
            )}
            {file.stats.added > 0 && file.stats.removed > 0 && (
              <span className="text-muted-foreground/50 mx-0.5">/</span>
            )}
            {file.stats.removed > 0 && (
              <span className="text-red-400/70">-{file.stats.removed}</span>
            )}
          </>
        )}
      </span>

      {/* Arrow indicator */}
      <ChevronRight
        size={12}
        className="text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors"
      />
    </button>
  )
}

export function FileChangesList({ changes, onFileClick }: FileChangesListProps) {
  const { edits, writes } = changes
  const allFiles = [...edits, ...writes]
  const { t } = useTranslation()

  return (
    <div className="max-h-[200px] overflow-y-auto px-2 -mx-2">
      {/* Edits section */}
      {edits.length > 0 && (
        <div>
          {writes.length > 0 && (
            <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1 px-2">
              {t('Modified')}
            </div>
          )}
          {edits.map((file, index) => (
            <FileItem
              key={file.id}
              file={file}
              isLast={index === edits.length - 1 && writes.length === 0}
              onClick={() => onFileClick(file)}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Writes section */}
      {writes.length > 0 && (
        <div className={edits.length > 0 ? 'mt-2' : ''}>
          {edits.length > 0 && (
            <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1 px-2">
              {t('Created')}
            </div>
          )}
          {writes.map((file, index) => (
            <FileItem
              key={file.id}
              file={file}
              isLast={index === writes.length - 1}
              onClick={() => onFileClick(file)}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}
