/**
 * Image Viewer - Image display with zoom and pan
 *
 * Features:
 * - Zoom in/out with buttons or scroll
 * - Pan by dragging
 * - Fit to window / actual size
 * - Download button
 * - Window maximize for fullscreen viewing
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { ZoomIn, ZoomOut, Maximize, ExternalLink, Download, RotateCw } from 'lucide-react'
import { api } from '../../../api'
import type { CanvasTab } from '../../../stores/canvas.store'
import { useTranslation } from '../../../i18n'

interface ImageViewerProps {
  tab: CanvasTab
}

export function ImageViewer({ tab }: ImageViewerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 })
  // True while the image is auto-fitted to the container (never upscaled past
  // 100%). Manual zoom/pan drops it so resizes stop overriding the user's zoom.
  const [isFitted, setIsFitted] = useState(true)

  // Scale that fits w×h inside the container, capped at 1 (don't upscale).
  const fitScaleFor = useCallback((w: number, h: number): number => {
    const c = containerRef.current
    if (!c || !w || !h) return 1
    return Math.min((c.clientWidth - 48) / w, (c.clientHeight - 48) / h, 1)
  }, [])

  // Get image URL
  // Priority: halo-file:// (custom protocol, fast) > remote download > base64 fallback
  const imageUrl = tab.path
    ? (api.isRemoteMode()
        ? api.getArtifactDownloadUrl(tab.path)
        : `halo-file://${tab.path}`)
    : tab.content
      ? `data:${tab.mimeType || 'image/png'};base64,${tab.content}`
      : ''

  // Reset view when tab changes
  useEffect(() => {
    setScale(1)
    setPosition({ x: 0, y: 0 })
    setImageLoaded(false)
    setImageError(false)
    setIsFitted(true)
  }, [tab.id])

  // Zoom functions — manual zoom exits fitted mode so resizes stop refitting.
  const zoomIn = () => { setIsFitted(false); setScale(s => Math.min(s * 1.25, 5)) }
  const zoomOut = () => { setIsFitted(false); setScale(s => Math.max(s / 1.25, 0.1)) }
  const resetZoom = () => {
    setIsFitted(false)
    setScale(1)
    setPosition({ x: 0, y: 0 })
  }
  const fitToWindow = () => {
    if (!naturalSize.width) return
    setScale(fitScaleFor(naturalSize.width, naturalSize.height))
    setPosition({ x: 0, y: 0 })
    setIsFitted(true)
  }

  // Handle wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    setIsFitted(false)
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setScale(s => Math.max(0.1, Math.min(5, s * delta)))
  }, [])

  // Re-fit while in fitted mode when the container resizes (e.g. dragging the
  // chat/canvas split narrower) so the image never spills out of view.
  useEffect(() => {
    const c = containerRef.current
    if (!c) return
    const ro = new ResizeObserver(() => {
      if (!isFitted || !naturalSize.width) return
      setScale(fitScaleFor(naturalSize.width, naturalSize.height))
      setPosition({ x: 0, y: 0 })
    })
    ro.observe(c)
    return () => ro.disconnect()
  }, [isFitted, naturalSize, fitScaleFor])

  // Handle drag
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    setIsDragging(true)
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y })
  }

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return
    setPosition({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y
    })
  }, [isDragging, dragStart])

  const handleMouseUp = () => setIsDragging(false)

  // Download image
  const handleDownload = () => {
    if (tab.path) {
      api.downloadArtifact(tab.path)
    }
  }

  // Open with external application
  const handleOpenExternal = async () => {
    if (!tab.path) return
    try {
      await api.openArtifact(tab.path)
    } catch (err) {
      console.error('Failed to open with external app:', err)
    }
  }

  const canOpenExternal = !api.isRemoteMode() && tab.path

  // Image load handlers
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    const w = img.naturalWidth, h = img.naturalHeight
    setNaturalSize({ width: w, height: h })
    setImageLoaded(true)
    setImageError(false)
    // Open fitted to the container so a large image never lands cropped.
    setScale(fitScaleFor(w, h))
    setPosition({ x: 0, y: 0 })
    setIsFitted(true)
  }

  const handleImageError = () => {
    setImageError(true)
    setImageLoaded(false)
  }

  return (
    <div className="relative flex flex-col h-full bg-[#1a1a1a]">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {imageLoaded && (
            <>
              <span>{naturalSize.width} × {naturalSize.height}</span>
              <span className="text-muted-foreground/50">·</span>
              <span>{Math.round(scale * 100)}%</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Zoom controls */}
          <button
            onClick={zoomOut}
            className="p-1.5 rounded hover:bg-secondary transition-colors"
            title={t('Zoom out')}
          >
            <ZoomOut className="w-4 h-4 text-muted-foreground" />
          </button>
          <button
            onClick={zoomIn}
            className="p-1.5 rounded hover:bg-secondary transition-colors"
            title={t('Zoom in')}
          >
            <ZoomIn className="w-4 h-4 text-muted-foreground" />
          </button>
          <button
            onClick={fitToWindow}
            className="p-1.5 rounded hover:bg-secondary transition-colors"
            title={t('Fit to window')}
          >
            <Maximize className="w-4 h-4 text-muted-foreground" />
          </button>
          <button
            onClick={resetZoom}
            className="p-1.5 rounded hover:bg-secondary transition-colors"
            title={t('Reset')}
          >
            <RotateCw className="w-4 h-4 text-muted-foreground" />
          </button>

          <div className="w-px h-4 bg-border mx-1" />

          {/* Download */}
          {tab.path && (
            <button
              onClick={handleDownload}
              className="p-1.5 rounded hover:bg-secondary transition-colors"
              title={t('Download')}
            >
              <Download className="w-4 h-4 text-muted-foreground" />
            </button>
          )}

          {/* Open with external app */}
          {canOpenExternal && (
            <button
              onClick={handleOpenExternal}
              className="p-1.5 rounded hover:bg-secondary transition-colors"
              title={t('Open in external application')}
            >
              <ExternalLink className="w-4 h-4 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* Image container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden flex items-center justify-center cursor-grab active:cursor-grabbing"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {imageError ? (
          <div className="text-center text-muted-foreground">
            <p className="text-lg mb-2">{t('Unable to load image')}</p>
            <p className="text-sm">{t('File may have been moved or deleted')}</p>
          </div>
        ) : (
          <img
            src={imageUrl}
            alt={tab.title}
            className="max-w-none transition-transform duration-100"
            style={{
              transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
              opacity: imageLoaded ? 1 : 0,
            }}
            onLoad={handleImageLoad}
            onError={handleImageError}
            draggable={false}
          />
        )}

        {/* Loading indicator */}
        {!imageLoaded && !imageError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Checkerboard background for transparency */}
      <style>{`
        .bg-\\[\\#1a1a1a\\] {
          background-image:
            linear-gradient(45deg, #222 25%, transparent 25%),
            linear-gradient(-45deg, #222 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #222 75%),
            linear-gradient(-45deg, transparent 75%, #222 75%);
          background-size: 20px 20px;
          background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
          background-color: #1a1a1a;
        }
      `}</style>
    </div>
  )
}
