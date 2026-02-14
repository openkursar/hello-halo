/**
 * FileChangesFooter - Displays file changes summary at the bottom of message bubble
 *
 * Design principles:
 * - Non-intrusive: Only shows when there are changes
 * - Progressive disclosure: Stats → File list → Full diff modal
 *
 * Data strategy:
 * - Summary data (from metadata.fileChanges) for immediate stats display
 * - Full diff data (from thoughts) loaded on-demand when user clicks a file
 * - This keeps the main message file small while still showing stats instantly
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import {
  FileText,
  FilePlus,
  ChevronDown,
  Loader2,
} from 'lucide-react'
import { FileChangesList } from './FileChangesList'
import { DiffModal } from './DiffModal'
import { extractFileChanges, hasFileChanges, getAllFileChanges, summaryToFileChanges } from './utils'
import type { Thought, FileChangesSummary } from '../../types'
import type { FileChange, FileChanges as FileChangesType } from './types'
import { useTranslation } from '../../i18n'

interface FileChangesFooterProps {
  fileChangesSummary?: FileChangesSummary  // From metadata: immediate stats display
  thoughts?: Thought[] | null              // From message: full diff content if loaded
  onLoadThoughts?: () => Promise<Thought[]>  // Lazy load thoughts for diff content
}

export function FileChangesFooter({ fileChangesSummary, thoughts, onLoadThoughts }: FileChangesFooterProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isLoadingDiff, setIsLoadingDiff] = useState(false)
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

  // Full file changes with diff content (from thoughts)
  const fullFileChangesRef = useRef<FileChangesType | null>(null)
  const isLoadingRef = useRef(false)

  // Sync full data when thoughts become available (inline or after lazy load)
  useEffect(() => {
    if (Array.isArray(thoughts) && thoughts.length > 0) {
      const extracted = extractFileChanges(thoughts)
      if (hasFileChanges(extracted)) {
        fullFileChangesRef.current = extracted
      }
    }
  }, [thoughts])

  // Display data: lightweight summary for stats bar and file list
  // Pure computation — no side effects
  const displayChanges = useMemo(() => {
    if (Array.isArray(thoughts) && thoughts.length > 0) {
      const extracted = extractFileChanges(thoughts)
      if (hasFileChanges(extracted)) return extracted
    }
    if (fileChangesSummary) return summaryToFileChanges(fileChangesSummary)
    return null
  }, [fileChangesSummary, thoughts])

  const allDisplayFiles = useMemo(
    () => displayChanges ? getAllFileChanges(displayChanges) : [],
    [displayChanges]
  )

  // Memoize allFiles for DiffModal to avoid unnecessary re-renders
  const modalAllFiles = useMemo(
    () => fullFileChangesRef.current ? getAllFileChanges(fullFileChangesRef.current) : allDisplayFiles,
    // Re-derive when display files change (which happens when thoughts load)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allDisplayFiles, thoughts]
  )

  // Load full diff data on demand
  const loadFullFileChanges = useCallback(async (): Promise<FileChangesType | null> => {
    if (fullFileChangesRef.current) return fullFileChangesRef.current

    if (Array.isArray(thoughts) && thoughts.length > 0) {
      const extracted = extractFileChanges(thoughts)
      if (hasFileChanges(extracted)) {
        fullFileChangesRef.current = extracted
        return extracted
      }
    }

    if (!onLoadThoughts) return null

    const loaded = await onLoadThoughts()
    if (loaded.length > 0) {
      const extracted = extractFileChanges(loaded)
      if (hasFileChanges(extracted)) {
        fullFileChangesRef.current = extracted
        return extracted
      }
    }

    return null
  }, [thoughts, onLoadThoughts])

  // Open modal with the correct file from full data
  const openModalWithFile = useCallback((targetFile: string, fullChanges: FileChangesType | null, fallbackFile: FileChange, fallbackIndex: number) => {
    if (fullChanges) {
      const fullFiles = getAllFileChanges(fullChanges)
      const matched = fullFiles.find(f => f.file === targetFile)
      const matchedIndex = fullFiles.findIndex(f => f.file === targetFile)
      setModalState({
        isOpen: true,
        file: matched || fallbackFile,
        index: matchedIndex >= 0 ? matchedIndex : fallbackIndex
      })
    } else {
      setModalState({ isOpen: true, file: fallbackFile, index: fallbackIndex })
    }
  }, [])

  // Handle file click: load full diff if needed, then open modal
  const handleFileClick = useCallback(async (file: FileChange) => {
    const fallbackIndex = Math.max(0, allDisplayFiles.findIndex(f => f.file === file.file))

    // Fast path: full data already cached
    if (fullFileChangesRef.current) {
      openModalWithFile(file.file, fullFileChangesRef.current, file, fallbackIndex)
      return
    }

    // Guard against concurrent loads
    if (isLoadingRef.current) return
    isLoadingRef.current = true
    setIsLoadingDiff(true)

    try {
      const fullChanges = await loadFullFileChanges()
      openModalWithFile(file.file, fullChanges, file, fallbackIndex)
    } catch (error) {
      console.error('[FileChangesFooter] Failed to load diff:', error)
      // Fallback: open with summary data (stats only)
      setModalState({ isOpen: true, file, index: fallbackIndex })
    } finally {
      isLoadingRef.current = false
      setIsLoadingDiff(false)
    }
  }, [allDisplayFiles, loadFullFileChanges, openModalWithFile])

  // Navigate in modal
  const handleNavigate = useCallback((direction: 'prev' | 'next') => {
    const files = fullFileChangesRef.current
      ? getAllFileChanges(fullFileChangesRef.current)
      : allDisplayFiles

    const newIndex = direction === 'prev'
      ? Math.max(0, modalState.index - 1)
      : Math.min(files.length - 1, modalState.index + 1)

    setModalState(prev => ({ ...prev, file: files[newIndex], index: newIndex }))
  }, [allDisplayFiles, modalState.index])

  const handleCloseModal = useCallback(() => {
    setModalState(prev => ({ ...prev, isOpen: false }))
  }, [])

  if (!displayChanges) return null

  const { edits, writes } = displayChanges

  return (
    <>
      <div className="border-t border-border/30 mt-3 pt-2">
        {/* Stats bar */}
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
            <div className="flex items-center gap-1 text-muted-foreground">
              {edits.length > 0 && <FileText size={14} className="text-amber-400/70" />}
              {writes.length > 0 && <FilePlus size={14} className="text-green-400/70" />}
            </div>
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
          <div className="flex items-center gap-1 text-muted-foreground/60">
            {isLoadingDiff && <Loader2 size={12} className="animate-spin" />}
            <span className="text-[10px]">{isExpanded ? t('Collapse') : t('View')}</span>
            <ChevronDown
              size={14}
              className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
            />
          </div>
        </button>

        {/* File list */}
        {isExpanded && (
          <div className="mt-2 animate-slide-down">
            <FileChangesList changes={displayChanges} onFileClick={handleFileClick} />
          </div>
        )}
      </div>

      <DiffModal
        isOpen={modalState.isOpen}
        file={modalState.file}
        allFiles={modalAllFiles}
        currentIndex={modalState.index}
        onClose={handleCloseModal}
        onNavigate={handleNavigate}
      />
    </>
  )
}
