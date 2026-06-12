/**
 * RawFilesTab — manage a KB's source files ("Files").
 *
 * - Drop zone + desktop file picker to add text files.
 * - Files grouped into "Not yet learned" / "Learned" with status icons.
 * - "Learn now" triggers ingest; live progress bar reflects the event stream.
 *
 * Learned status comes from RawFileStatus.learned (pulled from disk), never
 * from progress events.
 */

import { useState, DragEvent } from 'react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { useTlonStore } from '../../stores/tlon.store'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { IngestProgress } from './IngestProgress'
import {
  FileText,
  CheckCircle2,
  Circle,
  Trash2,
  Upload,
  FolderOpen,
  FolderPlus,
  Sparkles,
  Loader2,
} from 'lucide-react'
import type { KnowledgeBaseEntry, RawFileStatus } from '../../../shared/types/tlon'

interface RawFilesTabProps {
  kb: KnowledgeBaseEntry
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function RawFilesTab({ kb }: RawFilesTabProps) {
  const { t } = useTranslation()
  const { showConfirm, DialogComponent } = useConfirmDialog()
  const rawFiles = useTlonStore(s => s.rawFiles[kb.id]) ?? []
  const progress = useTlonStore(s => s.ingestProgress[kb.id])
  const addFiles = useTlonStore(s => s.addFiles)
  const removeRawFile = useTlonStore(s => s.removeRawFile)
  const pickAndAddFiles = useTlonStore(s => s.pickAndAddFiles)
  const pickAndImportFolder = useTlonStore(s => s.pickAndImportFolder)
  const triggerIngest = useTlonStore(s => s.triggerIngest)

  const [isDragging, setIsDragging] = useState(false)
  const isElectron = !api.isRemoteMode()
  const isIngesting = progress?.phase === 'running'

  const notLearned = rawFiles.filter(f => !f.learned)
  const learned = rawFiles.filter(f => f.learned)

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const paths: string[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = (file as File & { path?: string }).path
      if (p) paths.push(p)
    }
    if (paths.length > 0) {
      await addFiles(kb.id, paths)
    }
  }

  const handleRemove = async (file: RawFileStatus) => {
    const ok = await showConfirm({
      title: t('Remove file'),
      message: t('Remove "{{name}}" from this knowledge base?', { name: file.name }),
      confirmLabel: t('Remove'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (ok) await removeRawFile(kb.id, file.path)
  }

  return (
    <div className="p-3 sm:p-4 space-y-4">
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`rounded-xl border-2 border-dashed p-5 sm:p-6 text-center transition-colors ${
          isDragging ? 'border-primary bg-primary/5' : 'border-border'
        }`}
      >
        <Upload className="w-6 h-6 mx-auto text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">{t('Drop files or folders here')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('PDF, documents, spreadsheets, presentations, Markdown, text, CSV, HTML. Folders import recursively — source code and system files are skipped.')}
        </p>
        {isElectron && (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={() => pickAndAddFiles(kb.id)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              {t('Browse files')}
            </button>
            <button
              onClick={() => pickAndImportFolder(kb.id)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
            >
              <FolderPlus className="w-4 h-4" />
              {t('Browse folder')}
            </button>
          </div>
        )}
        {!isElectron && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('Browsing files requires the desktop app.')}
          </p>
        )}
      </div>

      {/* Progress */}
      <IngestProgress progress={progress} />

      {/* Learn button */}
      {notLearned.length > 0 && (
        <button
          onClick={() => triggerIngest(kb.id)}
          disabled={isIngesting}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isIngesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {isIngesting
            ? t('Learning…')
            : t('Learn {{count}} new file(s)', { count: notLearned.length })}
        </button>
      )}

      {/* File groups */}
      {rawFiles.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {t('No files yet. Add some above to get started.')}
        </p>
      ) : (
        <div className="space-y-4">
          {notLearned.length > 0 && (
            <FileGroup
              title={t('Not yet learned')}
              files={notLearned}
              learned={false}
              onRemove={handleRemove}
              formatSize={formatSize}
            />
          )}
          {learned.length > 0 && (
            <FileGroup
              title={t('Learned')}
              files={learned}
              learned={true}
              onRemove={handleRemove}
              formatSize={formatSize}
            />
          )}
        </div>
      )}

      {DialogComponent}
    </div>
  )
}

interface FileGroupProps {
  title: string
  files: RawFileStatus[]
  learned: boolean
  onRemove: (file: RawFileStatus) => void
  formatSize: (bytes: number) => string
}

function FileGroup({ title, files, learned, onRemove, formatSize }: FileGroupProps) {
  const { t } = useTranslation()
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</h4>
        <span className="text-[11px] text-muted-foreground tabular-nums">{files.length}</span>
      </div>
      <div className="space-y-1">
        {files.map(file => (
          <div
            key={file.path}
            className="group flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card"
          >
            {learned
              ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
              : <Circle className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
            <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm truncate">{file.name}</p>
              {file.path !== file.name && (
                <p className="text-[11px] text-muted-foreground truncate">{file.path}</p>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground tabular-nums flex-shrink-0">
              {formatSize(file.size)}
            </span>
            <button
              onClick={() => onRemove(file)}
              className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/20 transition-all flex-shrink-0"
              title={t('Remove')}
            >
              <Trash2 className="w-3.5 h-3.5 text-destructive" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
