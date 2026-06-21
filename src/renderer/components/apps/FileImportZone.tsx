/**
 * FileImportZone
 *
 * Unified drag-and-drop zone that accepts both files and folders.
 * Shared across SkillInstallDialog, AppInstallDialog, and ShareToStoreDialog
 * to provide a consistent import UX.
 *
 * - Drop zone: auto-detects files vs folders via webkitGetAsEntry()
 * - Click on zone: opens the system file picker
 * - "Browse folder" button: opens the system folder picker (webkitdirectory)
 * - Consumer provides callbacks and labels; this component owns only the UI shell.
 */

import { useRef, useState, useCallback, type ReactNode } from 'react'
import { Upload, FolderOpen, Loader2 } from 'lucide-react'

export interface FileImportZoneProps {
  /** Called when a single file is dropped or selected via file picker */
  onFile: (file: File) => void
  /** Called when a folder is drag-dropped (detected via webkitGetAsEntry) */
  onDirectoryEntry: (entry: FileSystemDirectoryEntry) => void
  /** Called when a folder is selected via the browse-folder button */
  onFolderFileList: (files: FileList) => void
  /** File input accept attribute, e.g. ".md,.zip" */
  fileAccept: string
  /** Primary label inside the drop zone */
  dropLabel: string
  /** Secondary hint (file types) */
  dropHint: string
  /** Label for the browse-folder button */
  folderLabel: string
  /** Show spinner over the drop zone */
  processing?: boolean
  /** Format hints, error messages, or any content rendered below the folder button */
  children?: ReactNode
}

export function FileImportZone({
  onFile,
  onDirectoryEntry,
  onFolderFileList,
  fileAccept,
  dropLabel,
  dropHint,
  folderLabel,
  processing = false,
  children,
}: FileImportZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    const items = e.dataTransfer.items
    if (items && items.length > 0) {
      const entry = items[0].webkitGetAsEntry?.()
      if (entry?.isDirectory) {
        onDirectoryEntry(entry as FileSystemDirectoryEntry)
        return
      }
      if (entry?.isFile) {
        const fileEntry = entry as FileSystemFileEntry
        const file = await new Promise<File>((resolve, reject) =>
          fileEntry.file(resolve, reject)
        )
        onFile(file)
        return
      }
    }

    // Fallback: plain File from dataTransfer
    const file = e.dataTransfer.files[0]
    if (file) onFile(file)
  }, [onFile, onDirectoryEntry])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onFile(file)
    e.target.value = ''
  }, [onFile])

  const handleFolderInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) onFolderFileList(files)
    e.target.value = ''
  }, [onFolderFileList])

  return (
    <div className="space-y-3">
      {/* Drop zone — click opens file picker, drag accepts file or folder */}
      <div
        onDragOver={e => { e.preventDefault(); setIsDragOver(true) }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`flex flex-col items-center justify-center gap-3 h-40 border-2 border-dashed rounded-lg cursor-pointer select-none transition-colors ${
          isDragOver
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-muted-foreground/50'
        }`}
      >
        {processing
          ? <Loader2 className="w-7 h-7 text-muted-foreground animate-spin" />
          : <Upload className={`w-7 h-7 ${isDragOver ? 'text-primary' : 'text-muted-foreground'}`} />
        }
        <div className="text-center px-4">
          <p className="text-sm text-foreground">{dropLabel}</p>
          <p className="text-xs text-muted-foreground mt-1">{dropHint}</p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={fileAccept}
          onChange={handleFileInput}
          className="hidden"
        />
      </div>

      {/* Browse folder button */}
      <button
        type="button"
        onClick={() => folderInputRef.current?.click()}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground border border-border hover:border-muted-foreground/50 rounded-lg transition-colors"
      >
        <FolderOpen className="w-4 h-4" />
        {folderLabel}
        <input
          ref={folderInputRef}
          type="file"
          // @ts-expect-error -- non-standard but supported in Electron/Chrome
          webkitdirectory=""
          onChange={handleFolderInput}
          className="hidden"
        />
      </button>

      {/* Consumer-provided content (format hints, error messages, etc.) */}
      {children}
    </div>
  )
}
