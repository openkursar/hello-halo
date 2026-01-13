/**
 * FileChangesFooter - Displays file changes summary at the bottom of message bubble
 * Layer 1: Minimal stats bar that expands to show file list
 *
 * Design principles:
 * - Non-intrusive: Only shows when there are changes
 * - Gentle: Blends with message bubble, not visually aggressive
 * - Progressive disclosure: Stats → File list → Full diff modal
 */

import { useState, useMemo, useCallback } from 'react'
import {
  FileText,
  FilePlus,
  ChevronDown,
  ExternalLink,
} from 'lucide-react'
import { FileChangesList } from './FileChangesList'
import { DiffModal } from './DiffModal'
import { extractFileChanges, hasFileChanges, getAllFileChanges } from './utils'
import type { Thought } from '../../types'
import type { FileChange } from './types'
import { useTranslation } from '../../i18n'

interface FileChangesFooterProps {
  thoughts: Thought[]
}

export function FileChangesFooter({ thoughts }: FileChangesFooterProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [modalState, setModalState] = useState<{
    isOpen: boolean
    file: FileChange | null
    index: number
  }>({
    isOpen: false,
    file: null,
    index: 0
  })
  const { t } = useTranslation()

  // Extract file changes from thoughts
  const fileChanges = useMemo(() => extractFileChanges(thoughts), [thoughts])
  const allFiles = useMemo(() => getAllFileChanges(fileChanges), [fileChanges])

  // Handle file click - open modal
  const handleFileClick = useCallback((file: FileChange) => {
    const index = allFiles.findIndex(f => f.id === file.id)
    setModalState({
      isOpen: true,
      file,
      index: index >= 0 ? index : 0
    })
  }, [allFiles])

  // Navigate to previous/next file in modal
  const handleNavigate = useCallback((direction: 'prev' | 'next') => {
    const newIndex = direction === 'prev'
      ? Math.max(0, modalState.index - 1)
      : Math.min(allFiles.length - 1, modalState.index + 1)

    setModalState(prev => ({
      ...prev,
      file: allFiles[newIndex],
      index: newIndex
    }))
  }, [allFiles, modalState.index])

  // Close modal
  const handleCloseModal = useCallback(() => {
    setModalState(prev => ({ ...prev, isOpen: false }))
  }, [])

  // Don't render if no changes
  if (!hasFileChanges(fileChanges)) {
    return null
  }

  const { edits, writes, totalFiles } = fileChanges

  return (
    <>
      {/* Footer bar - attached to message bubble bottom */}
      <div className="border-t border-border/30 mt-3 pt-2">
        {/* Stats bar - clickable to expand */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={`
            w-full flex items-center justify-between gap-2 px-2 py-1.5 -mx-2
            rounded-lg text-xs transition-all duration-200
            hover:bg-muted/30
            ${isExpanded ? 'bg-muted/20' : ''}
          `}
        >
          <div className="flex items-center gap-3">
            {/* Icon */}
            <div className="flex items-center gap-1 text-muted-foreground">
              {edits.length > 0 && (
                <FileText size={14} className="text-amber-400/70" />
              )}
              {writes.length > 0 && (
                <FilePlus size={14} className="text-green-400/70" />
              )}
            </div>

            {/* Stats text */}
            <span className="text-muted-foreground">
              {edits.length > 0 && (
                <span>
                  {t('Modified')} <span className="text-foreground/80">{edits.length}</span> {t('files')}
                </span>
              )}
              {edits.length > 0 && writes.length > 0 && (
                <span className="mx-1.5 text-muted-foreground/50">·</span>
              )}
              {writes.length > 0 && (
                <span>
                  {t('Created')} <span className="text-foreground/80">{writes.length}</span>
                </span>
              )}
            </span>
          </div>

          {/* Expand indicator */}
          <div className="flex items-center gap-1 text-muted-foreground/60">
            <span className="text-[10px]">{isExpanded ? t('Collapse') : t('View')}</span>
            <ChevronDown
              size={14}
              className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
            />
          </div>
        </button>

        {/* Expanded file list */}
        {isExpanded && (
          <div className="mt-2 animate-slide-down">
            <FileChangesList
              changes={fileChanges}
              onFileClick={handleFileClick}
            />
          </div>
        )}
      </div>

      {/* Diff modal */}
      <DiffModal
        isOpen={modalState.isOpen}
        file={modalState.file}
        allFiles={allFiles}
        currentIndex={modalState.index}
        onClose={handleCloseModal}
        onNavigate={handleNavigate}
      />
    </>
  )
}
