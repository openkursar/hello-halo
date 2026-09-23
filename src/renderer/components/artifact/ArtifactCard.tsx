/**
 * Artifact Card - Single file/folder display with enhanced interactivity
 * Supports both desktop (open) and web (download) modes
 * Integrates with Content Canvas for in-app file viewing
 */

import { useState } from 'react'
import { api } from '../../api'
import { useCanvasStore } from '../../stores/canvas.store'
import type { Artifact } from '../../types'
import { FileIcon } from '../icons/ToolIcons'
import { ExternalLink, Download, Eye } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { canOpenInCanvas, isDocumentExtension } from '../../constants/file-types'

// Check if running in web mode
const isWebMode = api.isRemoteMode()

export interface ArtifactContextMenuState {
  x: number
  y: number
  path: string
  relativePath: string
  isFolder: boolean
}

interface ArtifactCardProps {
  artifact: Artifact
  onShowContextMenu?: (menu: ArtifactContextMenuState) => void
}

// Format file size
function formatSize(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ArtifactCard({ artifact, onShowContextMenu }: ArtifactCardProps) {
  const { t } = useTranslation()
  const [isHovered, setIsHovered] = useState(false)
  const openFile = useCanvasStore(state => state.openFile)
  const isFolder = artifact.type === 'folder'

  // Check if this file can be viewed in the canvas
  const canViewInCanvas = !isFolder && canOpenInCanvas(artifact.extension)

  // Documents in web mode get their own download control alongside the preview.
  // Always shown, not hover-revealed: web mode includes touch clients that have
  // no hover at all.
  const showDownload = isWebMode && !isFolder && isDocumentExtension(artifact.extension)

  // Handle click to open file
  // Priority: Canvas > System App (desktop) > Download (web)
  const handleClick = async () => {
    // Try to open in Canvas first for viewable files
    if (canViewInCanvas) {
      openFile(artifact.path, artifact.name)
      return
    }

    // Fallback behavior for non-viewable files
    if (isWebMode) {
      // In web mode, trigger download
      api.downloadArtifact(artifact.path)
    } else {
      // In desktop mode, open with system app
      try {
        const response = await api.openArtifact(artifact.path)
        if (!response.success) {
          console.error('Failed to open artifact:', response.error)
        }
      } catch (error) {
        console.error('Failed to open artifact:', error)
      }
    }
  }

  // Handle double-click to force open with system app
  const handleDoubleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isWebMode) {
      api.downloadArtifact(artifact.path)
    } else {
      try {
        await api.openArtifact(artifact.path)
      } catch (error) {
        console.error('Failed to open artifact:', error)
      }
    }
  }

  // Handle right-click context menu
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (onShowContextMenu) {
      onShowContextMenu({
        x: e.clientX,
        y: e.clientY,
        path: artifact.path,
        relativePath: artifact.relativePath,
        isFolder
      })
    } else if (!isWebMode) {
      api.showArtifactInFolder(artifact.path).catch(error =>
        console.error('Failed to show in folder:', error)
      )
    }
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/halo-artifact-relative-path', artifact.relativePath)
        e.dataTransfer.setData('text/plain', artifact.relativePath)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`
        w-full artifact-card p-2.5 rounded-lg text-left
        transition-all duration-200 group cursor-pointer
        ${isHovered
          ? 'bg-secondary shadow-sm'
          : 'bg-secondary/50 hover:bg-secondary/80'
        }
      `}
      title={canViewInCanvas
        ? (showDownload
            ? t('Click to preview · use the download button to save the file')
            : t('Click to preview · double-click to open with system'))
        : (isWebMode ? t('Click to download file') : artifact.path)
      }
    >
      <div className="flex items-center gap-2.5">
        {/* Icon */}
        <div>
          <FileIcon extension={artifact.extension} isFolder={isFolder} size={18} />
        </div>

        {/* File info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate text-foreground/90">
            {artifact.name}
          </p>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {!isFolder && artifact.extension && (
              <span className="uppercase">{artifact.extension}</span>
            )}
            {!isFolder && artifact.size !== undefined && artifact.extension && (
              <span className="text-muted-foreground/50">·</span>
            )}
            {!isFolder && artifact.size !== undefined && (
              <span>{formatSize(artifact.size)}</span>
            )}
            {isFolder && (
              <span>{t('Folder')}</span>
            )}
          </div>
        </div>

        {/* Hover action indicator */}
        {isHovered && (
          canViewInCanvas ? (
            <Eye className="w-4 h-4 text-primary flex-shrink-0" />
          ) : isWebMode ? (
            <Download className="w-4 h-4 text-primary flex-shrink-0" />
          ) : (
            <ExternalLink className="w-4 h-4 text-muted-foreground/50 flex-shrink-0" />
          )
        )}

        {showDownload && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              api.downloadArtifact(artifact.path)
            }}
            className="p-1 rounded flex-shrink-0 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title={t('Download')}
          >
            <Download className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}
