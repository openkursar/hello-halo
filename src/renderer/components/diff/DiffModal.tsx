/**
 * DiffModal - Full-screen modal for viewing file diffs
 * Layer 3: Professional diff view with file navigation
 *
 * Design:
 * - Modal overlay with backdrop blur
 * - Header with file name and navigation
 * - Scrollable diff content area
 * - Keyboard navigation support (←/→ for prev/next, Esc to close)
 */

import { useEffect, useCallback } from 'react'
import {
  X,
  ChevronLeft,
  ChevronRight,
  FileText,
  FilePlus,
  FolderOpen,
  Copy,
  Check,
} from 'lucide-react'
import { useState } from 'react'
import { DiffContent } from './DiffContent'
import type { FileChange } from './types'
import { useTranslation } from '../../i18n'

interface DiffModalProps {
  isOpen: boolean
  file: FileChange | null
  allFiles: FileChange[]
  currentIndex: number
  onClose: () => void
  onNavigate: (direction: 'prev' | 'next') => void
}

export function DiffModal({
  isOpen,
  file,
  allFiles,
  currentIndex,
  onClose,
  onNavigate
}: DiffModalProps) {
  const [copied, setCopied] = useState(false)
  const { t } = useTranslation()

  // Handle keyboard navigation
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case 'ArrowLeft':
          if (currentIndex > 0) onNavigate('prev')
          break
        case 'ArrowRight':
          if (currentIndex < allFiles.length - 1) onNavigate('next')
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, currentIndex, allFiles.length, onClose, onNavigate])

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  // Copy content
  const handleCopy = useCallback(async () => {
    if (!file) return

    const content = file.type === 'write'
      ? file.content
      : file.newString

    if (content) {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [file])

  // Open in folder (Electron only)
  const handleOpenFolder = useCallback(() => {
    if (!file) return
    // This will be handled by the preload bridge
    if (window.halo?.openFolder) {
      window.halo.openFolder(file.file)
    }
  }, [file])

  if (!isOpen || !file) return null

  const isWrite = file.type === 'write'
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < allFiles.length - 1

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
      />

      {/* Modal content */}
      <div className="relative w-[90vw] max-w-4xl h-[80vh] bg-card border border-border rounded-xl shadow-2xl flex flex-col animate-scale-in overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 bg-muted/30 shrink-0">
          {/* Left: File info */}
          <div className="flex items-center gap-3 min-w-0">
            {/* File icon */}
            {isWrite ? (
              <FilePlus size={18} className="text-green-400 shrink-0" />
            ) : (
              <FileText size={18} className="text-amber-400 shrink-0" />
            )}

            {/* File name and path */}
            <div className="min-w-0">
              <div className="font-medium text-foreground truncate">
                {file.fileName}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {file.file}
              </div>
            </div>

            {/* Stats badge */}
            <div className={`
              px-2 py-0.5 rounded text-xs font-mono shrink-0
              ${isWrite
                ? 'bg-green-500/10 text-green-400'
                : 'bg-muted text-muted-foreground'
              }
            `}>
              {isWrite ? (
                t('New file')
              ) : (
                <>
                  {file.stats.added > 0 && (
                    <span className="text-green-400">+{file.stats.added}</span>
                  )}
                  {file.stats.added > 0 && file.stats.removed > 0 && (
                    <span className="text-muted-foreground/50 mx-1">/</span>
                  )}
                  {file.stats.removed > 0 && (
                    <span className="text-red-400">-{file.stats.removed}</span>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Right: Actions and close */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Navigation */}
            {allFiles.length > 1 && (
              <div className="flex items-center gap-1 mr-2">
                <button
                  onClick={() => onNavigate('prev')}
                  disabled={!hasPrev}
                  className={`
                    p-1.5 rounded-md transition-colors
                    ${hasPrev
                      ? 'hover:bg-muted text-muted-foreground hover:text-foreground'
                      : 'text-muted-foreground/30 cursor-not-allowed'
                    }
                  `}
                  title={t('Previous file (←)')}
                >
                  <ChevronLeft size={18} />
                </button>

                <span className="text-xs text-muted-foreground px-1">
                  {currentIndex + 1} / {allFiles.length}
                </span>

                <button
                  onClick={() => onNavigate('next')}
                  disabled={!hasNext}
                  className={`
                    p-1.5 rounded-md transition-colors
                    ${hasNext
                      ? 'hover:bg-muted text-muted-foreground hover:text-foreground'
                      : 'text-muted-foreground/30 cursor-not-allowed'
                    }
                  `}
                  title={t('Next file (→)')}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            )}

            {/* Copy button */}
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title={t('Copy content')}
            >
              {copied ? (
                <Check size={18} className="text-green-400" />
              ) : (
                <Copy size={18} />
              )}
            </button>

            {/* Open folder button (only in Electron) */}
            {typeof window !== 'undefined' && window.halo?.openFolder && (
              <button
                onClick={handleOpenFolder}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                title={t('Open in folder')}
              >
                <FolderOpen size={18} />
              </button>
            )}

            {/* Close button */}
            <button
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors ml-1"
              title={t('Close (Esc)')}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Diff content */}
        <div className="flex-1 overflow-auto bg-background/50">
          <DiffContent
            type={file.type}
            oldString={file.oldString}
            newString={file.newString}
            content={file.content}
            fileName={file.fileName}
            editChunks={file.editChunks}
          />
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-border/30 bg-muted/20 text-xs text-muted-foreground/50 shrink-0">
          <span>{t('Esc to close')}</span>
          {allFiles.length > 1 && (
            <span className="ml-4">{t('← → to switch files')}</span>
          )}
        </div>
      </div>
    </div>
  )
}
