/**
 * Image Processor - Professional image processing utilities
 *
 * Features:
 * - Smart compression based on image dimensions
 * - Quality optimization for API transmission
 * - Maintains aspect ratio
 * - Outputs to efficient formats (JPEG for photos, PNG for graphics)
 *
 * Design Principles:
 * - No external dependencies (uses native Canvas API)
 * - Balanced between quality and file size
 * - Optimized for Claude Vision API (max recommended: 1568px on longest side)
 */

import type { ImageMediaType } from '../types'

export interface ProcessedImage {
  data: string          // Base64 encoded (without data: prefix)
  mediaType: ImageMediaType
  width: number
  height: number
  originalSize: number
  compressedSize: number
  compressionRatio: number
}

export interface ImageProcessorOptions {
  maxDimension?: number     // Max width/height (default: 1568 for Claude)
  quality?: number          // JPEG quality 0-1 (default: 0.85)
  preserveTransparency?: boolean  // Keep PNG for transparent images (default: true)
}

// Claude Vision API recommended max dimension
const DEFAULT_MAX_DIMENSION = 1568

// Quality settings
const DEFAULT_JPEG_QUALITY = 0.85
const HIGH_QUALITY_THRESHOLD = 0.92  // For small images

/**
 * Process an image file - compress and optimize for API transmission
 */
export async function processImage(
  file: File,
  options: ImageProcessorOptions = {}
): Promise<ProcessedImage> {
  const {
    maxDimension = DEFAULT_MAX_DIMENSION,
    quality = DEFAULT_JPEG_QUALITY,
    preserveTransparency = true
  } = options

  // Load image
  const img = await loadImage(file)

  // Calculate target dimensions
  const { width, height } = calculateDimensions(img.width, img.height, maxDimension)

  // Determine output format
  const outputType = determineOutputType(file.type, preserveTransparency)

  // Adjust quality for small images (they can afford higher quality)
  const pixelCount = width * height
  const adjustedQuality = pixelCount < 500000 ? HIGH_QUALITY_THRESHOLD : quality

  // Compress using canvas
  const { dataUrl, blob } = await compressImage(img, width, height, outputType, adjustedQuality)

  // Extract base64 data (remove data:image/xxx;base64, prefix)
  const base64Data = dataUrl.split(',')[1]

  return {
    data: base64Data,
    mediaType: outputType as ImageMediaType,
    width,
    height,
    originalSize: file.size,
    compressedSize: blob.size,
    compressionRatio: blob.size / file.size
  }
}

/**
 * Process multiple images in parallel
 */
export async function processImages(
  files: File[],
  options: ImageProcessorOptions = {}
): Promise<ProcessedImage[]> {
  return Promise.all(files.map(file => processImage(file, options)))
}

/**
 * Load image from file
 */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`Failed to load image: ${file.name}`))
    }

    img.src = url
  })
}

/**
 * Calculate target dimensions while maintaining aspect ratio
 */
function calculateDimensions(
  originalWidth: number,
  originalHeight: number,
  maxDimension: number
): { width: number; height: number } {
  // If image is smaller than max, keep original size
  if (originalWidth <= maxDimension && originalHeight <= maxDimension) {
    return { width: originalWidth, height: originalHeight }
  }

  // Scale down maintaining aspect ratio
  const ratio = Math.min(maxDimension / originalWidth, maxDimension / originalHeight)

  return {
    width: Math.round(originalWidth * ratio),
    height: Math.round(originalHeight * ratio)
  }
}

/**
 * Determine output format based on input
 * - PNG for images with transparency
 * - JPEG for photos (better compression)
 * - Keep WebP/GIF as-is
 */
function determineOutputType(inputType: string, preserveTransparency: boolean): string {
  // WebP and GIF: keep as-is (they have good compression)
  if (inputType === 'image/webp' || inputType === 'image/gif') {
    return inputType
  }

  // PNG: keep if preserving transparency, otherwise convert to JPEG
  if (inputType === 'image/png' && preserveTransparency) {
    return 'image/png'
  }

  // Default to JPEG for best compression
  return 'image/jpeg'
}

/**
 * Compress image using Canvas API
 */
async function compressImage(
  img: HTMLImageElement,
  width: number,
  height: number,
  outputType: string,
  quality: number
): Promise<{ dataUrl: string; blob: Blob }> {
  // Create canvas
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Failed to get canvas context')
  }

  // Fill white background for JPEG (to handle transparency)
  if (outputType === 'image/jpeg') {
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, width, height)
  }

  // Enable image smoothing for better quality
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Draw image
  ctx.drawImage(img, 0, 0, width, height)

  // Convert to data URL
  const dataUrl = canvas.toDataURL(outputType, quality)

  // Convert to blob for size calculation
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error('Failed to create blob')),
      outputType,
      quality
    )
  })

  return { dataUrl, blob }
}

/**
 * Check if file is a valid image type
 */
export function isValidImageType(file: File): boolean {
  const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
  return validTypes.includes(file.type)
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
