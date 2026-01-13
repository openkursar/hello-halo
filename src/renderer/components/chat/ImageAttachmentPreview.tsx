/**
 * ImageAttachmentPreview - Display attached images in input area
 * Features:
 * - Grid layout for multiple images
 * - Hover to show delete button
 * - Click to preview full size with ImageViewer
 * - Smooth animations
 */

import { useState } from 'react'
import { X, Image as ImageIcon } from 'lucide-react'
import { ImageViewer } from './ImageViewer'
import type { ImageAttachment } from '../../types'
import { useTranslation } from '../../i18n'

interface ImageAttachmentPreviewProps {
  images: ImageAttachment[]
  onRemove: (id: string) => void
  maxDisplay?: number
}

export function ImageAttachmentPreview({
  images,
  onRemove,
  maxDisplay = 4
}: ImageAttachmentPreviewProps) {
  const { t } = useTranslation()
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerIndex, setViewerIndex] = useState(0)

  if (images.length === 0) return null

  const displayImages = images.slice(0, maxDisplay)
  const remainingCount = images.length - maxDisplay

  const openViewer = (index: number) => {
    setViewerIndex(index)
    setViewerOpen(true)
  }

  return (
    <>
      <div className="flex flex-wrap gap-2 p-2 animate-fade-in">
        {displayImages.map((image, index) => (
          <div
            key={image.id}
            className="relative group"
            style={{
              animationDelay: `${index * 50}ms`
            }}
          >
            {/* Image thumbnail - clickable to preview */}
            <div
              className="relative w-16 h-16 rounded-lg overflow-hidden bg-secondary/50
                border border-border/50 transition-all duration-200
                group-hover:border-primary/30 group-hover:shadow-sm
                cursor-pointer"
              onClick={() => openViewer(index)}
            >
              <img
                src={`data:${image.mediaType};base64,${image.data}`}
                alt={image.name || t('Attached image')}
                className="w-full h-full object-cover"
              />
            </div>

            {/* Delete button - appears on hover, positioned outside overflow container */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                onRemove(image.id)
              }}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full
                bg-destructive text-destructive-foreground
                flex items-center justify-center
                opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100
                transition-all duration-150 shadow-sm z-10
                hover:bg-destructive/90"
              title={t('Remove image')}
            >
              <X size={12} strokeWidth={2.5} />
            </button>

            {/* File size indicator */}
            {image.size && (
              <div className="absolute bottom-0.5 left-0.5 right-0.5
                text-[9px] text-center text-white/90
                bg-black/50 backdrop-blur-sm rounded-b-md
                opacity-0 group-hover:opacity-100 transition-opacity">
                {formatFileSize(image.size)}
              </div>
            )}
          </div>
        ))}

        {/* More images indicator */}
        {remainingCount > 0 && (
          <div className="w-16 h-16 rounded-lg bg-secondary/50 border border-border/50
            flex flex-col items-center justify-center text-muted-foreground">
            <ImageIcon size={16} />
            <span className="text-xs mt-0.5">+{remainingCount}</span>
          </div>
        )}
      </div>

      {/* Image viewer modal */}
      {viewerOpen && (
        <ImageViewer
          images={images}
          initialIndex={viewerIndex}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  )
}

// Format file size for display
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// Single image display in message bubble
interface MessageImageProps {
  images: ImageAttachment[]
}

export function MessageImages({ images }: MessageImageProps) {
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerIndex, setViewerIndex] = useState(0)

  if (!images || images.length === 0) return null

  const openViewer = (index: number) => {
    setViewerIndex(index)
    setViewerOpen(true)
  }

  // Single image - larger display
  if (images.length === 1) {
    return (
      <>
        <div className="mb-2">
          <img
            src={`data:${images[0].mediaType};base64,${images[0].data}`}
            alt={images[0].name || 'Image'}
            className="max-w-full max-h-64 rounded-lg object-contain cursor-pointer
              hover:opacity-95 transition-opacity"
            onClick={() => openViewer(0)}
          />
        </div>
        {viewerOpen && (
          <ImageViewer
            images={images}
            initialIndex={viewerIndex}
            onClose={() => setViewerOpen(false)}
          />
        )}
      </>
    )
  }

  // Multiple images - grid layout
  return (
    <>
      <div className={`mb-2 grid gap-1.5 ${
        images.length === 2 ? 'grid-cols-2' :
        images.length === 3 ? 'grid-cols-3' :
        'grid-cols-2'
      }`}>
        {images.slice(0, 4).map((image, index) => (
          <div
            key={image.id}
            className="relative aspect-square rounded-lg overflow-hidden cursor-pointer
              hover:opacity-95 transition-opacity"
            onClick={() => openViewer(index)}
          >
            <img
              src={`data:${image.mediaType};base64,${image.data}`}
              alt={image.name || `Image ${index + 1}`}
              className="w-full h-full object-cover"
            />
            {/* Show remaining count on last image */}
            {index === 3 && images.length > 4 && (
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                <span className="text-white font-medium">+{images.length - 4}</span>
              </div>
            )}
          </div>
        ))}
      </div>
      {viewerOpen && (
        <ImageViewer
          images={images}
          initialIndex={viewerIndex}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  )
}
