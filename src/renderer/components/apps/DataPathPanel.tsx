/**
 * DataPathPanel
 *
 * An activity entry whose detail lives in a file rather than inline: a header
 * naming the file, and the file's rendered content below it.
 *
 * The header action differs by deployment. On the desktop it reveals the file
 * in the system file manager; over HTTP there is no file manager to reveal it
 * in, so it downloads instead — without that branch the button was a no-op in
 * server mode.
 */

import { useState } from 'react'
import { FileText, FolderOpen, Download, FileWarning } from 'lucide-react'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { useTranslation } from '../../i18n'
import { api } from '../../api'

interface DataPathPanelProps {
  dataPath: string
  /** Rendered file content, or inline fallback text. */
  text?: string
  /** The file could not be read and there is no fallback text. */
  unreadable?: boolean
}

export function DataPathPanel({ dataPath, text, unreadable }: DataPathPanelProps) {
  const { t } = useTranslation()
  const remote = api.isRemoteMode()
  const ActionIcon = remote ? Download : FolderOpen

  const [failedPath, setFailedPath] = useState<string | null>(null)
  const handleOpen = async () => {
    setFailedPath(null)
    try {
      const result = await (remote ? api.downloadArtifact(dataPath) : api.showArtifactInFolder(dataPath))
      if (!result.success) throw new Error(result.error ?? 'File opening rejected')
    } catch (error) {
      console.warn('[Activity] Report file could not open:', error)
      setFailedPath(dataPath)
    }
  }

  return (
    <div className="rounded-md border border-border overflow-hidden">
      <button
        onClick={handleOpen}
        title={dataPath}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5
          bg-secondary/60 hover:bg-secondary text-muted-foreground
          text-[11px] font-mono transition-colors group border-b border-border"
      >
        <FileText className="w-3 h-3 flex-shrink-0" />
        <span className="truncate">{dataPath.split('/').pop()}</span>
        <ActionIcon className="w-3 h-3 flex-shrink-0 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
      </button>
      {failedPath === dataPath && <p role="alert" className="p-3 text-xs text-destructive">{t('Could not open this file. Please try again.')}</p>}
      {text === '' && !unreadable && <p className="p-3 text-xs text-muted-foreground">{t('This file is empty.')}</p>}
      {text ? (
        <div className="p-3">
          <MarkdownRenderer content={text} className="text-sm" />
        </div>
      ) : unreadable ? (
        <div className="flex items-start gap-1.5 p-3 text-xs text-muted-foreground">
          <FileWarning className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
          <span>{t('This file could not be previewed.')}</span>
        </div>
      ) : null}
    </div>
  )
}
