/**
 * ImageViewer - Full-screen image viewer modal
 *
 * Features:
 * - Click outside or press Esc to close
 * - Navigate between multiple images
 * - Zoom support (scroll or button)
 * - Smooth animations
 *
 * Design: Professional, minimal, focus on the image
 */

import { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react'
import type { ImageAttachment } from '../../types'
import { useTranslation } from '../../i18n'

interface ImageViewerProps {
  images: ImageAttachment[]
  initialIndex?: number
  onClose: () => void
}

export function ImageViewer({ images, initialIndex = 0, onClose }: ImageViewerProps) {
  const { t } = useTranslation()
  const [currentIndex, setCurrentIndex] = useState(initialIndex)
  const [scale, setScale] = useState(1)
  const [isClosing, setIsClosing] = useState(false)

  const currentImage = images[currentIndex]
  const hasMultiple = images.length > 1

  // Handle close with animation
  const handleClose = useCallback(() => {
    setIsClosing(true)
    setTimeout(onClose, 150)
  }, [onClose])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          handleClose()
          break
        case 'ArrowLeft':
          if (hasMultiple && currentIndex > 0) {
            setCurrentIndex(i => i - 1)
            setScale(1)
          }
          break
        case 'ArrowRight':
          if (hasMultiple && currentIndex < images.length - 1) {
            setCurrentIndex(i => i + 1)
            setScale(1)
          }
          break
        case '+':
        case '=':
          setScale(s => Math.min(s + 0.25, 3))
          break
        case '-':
          setScale(s => Math.max(s - 0.25, 0.5))
          break
        case '0':
          setScale(1)
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleClose, hasMultiple, currentIndex, images.length])

  // Handle wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    setScale(s => Math.max(0.5, Math.min(3, s + delta)))
  }, [])

  // Navigate
  const goToPrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(i => i - 1)
      setScale(1)
    }
  }

  const goToNext = () => {
    if (currentIndex < images.length - 1) {
      setCurrentIndex(i => i + 1)
      setScale(1)
    }
  }

  if (!currentImage) return null

  // Render to document.body using Portal to ensure it's always on top
  return createPortal(
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center
        bg-black/90 backdrop-blur-sm
        transition-opacity duration-150
        ${isClosing ? 'opacity-0' : 'opacity-100 animate-fade-in'}`}
      onClick={handleClose}
    >
      {/* Close button */}
      <button
        onClick={handleClose}
        className="absolute top-4 right-4 z-10 p-2 rounded-full
          bg-white/10 hover:bg-white/20 text-white/80 hover:text-white
          transition-colors duration-150"
        title={t('Close (Esc)')}
      >
        <X size={24} />
      </button>

      {/* Image counter */}
      {hasMultiple && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10
          px-3 py-1.5 rounded-full bg-black/50 text-white/80 text-sm">
          {currentIndex + 1} / {images.length}
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10
        flex items-center gap-2 px-3 py-2 rounded-full bg-black/50">
        <button
          onClick={(e) => { e.stopPropagation(); setScale(s => Math.max(0.5, s - 0.25)) }}
          className="p-1.5 rounded-full hover:bg-white/20 text-white/80 hover:text-white
            transition-colors duration-150"
          title={t('Zoom out (-)')}
        >
          <ZoomOut size={18} />
        </button>
        <span className="text-white/70 text-sm min-w-[3rem] text-center">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); setScale(s => Math.min(3, s + 0.25)) }}
          className="p-1.5 rounded-full hover:bg-white/20 text-white/80 hover:text-white
            transition-colors duration-150"
          title={t('Zoom in (+)')}
        >
          <ZoomIn size={18} />
        </button>
      </div>

      {/* Navigation arrows */}
      {hasMultiple && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); goToPrev() }}
            disabled={currentIndex === 0}
            className={`absolute left-4 z-10 p-2 rounded-full
              bg-white/10 hover:bg-white/20 text-white/80 hover:text-white
              transition-all duration-150
              ${currentIndex === 0 ? 'opacity-30 cursor-not-allowed' : ''}`}
            title={t('Previous image (←)')}
          >
            <ChevronLeft size={28} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); goToNext() }}
            disabled={currentIndex === images.length - 1}
            className={`absolute right-4 z-10 p-2 rounded-full
              bg-white/10 hover:bg-white/20 text-white/80 hover:text-white
              transition-all duration-150
              ${currentIndex === images.length - 1 ? 'opacity-30 cursor-not-allowed' : ''}`}
            title={t('Next image (→)')}
          >
            <ChevronRight size={28} />
          </button>
        </>
      )}

      {/* Main image */}
      <div
        className="relative max-w-[90vw] max-h-[85vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onWheel={handleWheel}
      >
        <img
          src={`data:${currentImage.mediaType};base64,${currentImage.data}`}
          alt={currentImage.name || t('Image')}
          className="max-w-full max-h-[85vh] object-contain select-none
            transition-transform duration-150 ease-out"
          style={{ transform: `scale(${scale})` }}
          draggable={false}
        />
      </div>

      {/* Image name */}
      {currentImage.name && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2
          px-3 py-1 rounded bg-black/50 text-white/60 text-xs truncate max-w-[50vw]">
          {currentImage.name}
        </div>
      )}
    </div>,
    document.body
  )
}
