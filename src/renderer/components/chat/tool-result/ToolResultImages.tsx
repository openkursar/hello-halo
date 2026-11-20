/**
 * ToolResultImages - a tool result whose images were saved as files
 *
 * The desktop app shows each image from its file, the way a chat image is
 * shown (click to view it large). Where the file cannot be read — remote web
 * and the mobile app, or a step recorded on another machine of a team — each
 * image is one line naming it and its size.
 */

import { useMemo, useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { isElectron } from '../../../api/transport'
import { ImageViewer } from '../ImageViewer'
import { PlainTextViewer } from './PlainTextViewer'
import { formatFileSize } from '../../../lib/utils'
import { toHaloFileUrl } from '../../../../shared/halo-file-url'
import { TOOL_IMAGE_FILE_BLOCK, type ToolImageFileBlock, type ToolOutputPart } from '../../../../shared/tool-result-images'
import type { ImageAttachment, ImageMediaType } from '../../../../shared/types/image-attachment'

interface ToolResultImagesProps {
  parts: ToolOutputPart[]
  toolInput?: Record<string, unknown>
  isError?: boolean
}

/** The file the tool read, when it read exactly one; saved images are named by content. */
function readFileName(toolInput: Record<string, unknown> | undefined): string | undefined {
  const path = toolInput?.file_path
  if (typeof path !== 'string' || !path) return undefined
  return path.split(/[\\/]/).filter(Boolean).pop()
}

/** The output in its order: runs of text joined, each image in its place. */
type Segment = { kind: 'text'; text: string } | { kind: 'image'; index: number }

export function ToolResultImages({ parts, toolInput, isError }: ToolResultImagesProps) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState<ReadonlySet<number>>(() => new Set())
  const [viewing, setViewing] = useState<number | null>(null)
  const images = useMemo(
    () => parts.filter((part): part is ToolImageFileBlock => part.type === TOOL_IMAGE_FILE_BLOCK),
    [parts]
  )
  const segments = useMemo(() => {
    const out: Segment[] = []
    let image = 0
    for (const part of parts) {
      if (part.type === TOOL_IMAGE_FILE_BLOCK) {
        out.push({ kind: 'image', index: image++ })
      } else if (part.text) {
        const last = out[out.length - 1]
        if (last?.kind === 'text') last.text += `\n${part.text}`
        else out.push({ kind: 'text', text: part.text })
      }
    }
    return out
  }, [parts])
  const sourceName = images.length === 1 ? readFileName(toolInput) : undefined
  const desktop = isElectron()
  const attachments = useMemo<ImageAttachment[]>(() => images.map((image, index) => ({
    id: `${index}:${image.path}`,
    type: 'image',
    mediaType: image.media_type as ImageMediaType,
    data: '',
    url: toHaloFileUrl(image.path),
    name: sourceName ?? image.path.split(/[\\/]/).pop(),
    size: image.bytes,
  })), [images, sourceName])

  return (
    <div className="mt-1.5 space-y-1.5" data-testid="tool-result-images">
      {segments.map((segment, at) => {
        if (segment.kind === 'text') {
          return <PlainTextViewer key={`text-${at}`} output={segment.text} isError={isError} toolInput={toolInput} />
        }
        const index = segment.index
        const image = attachments[index]
        return desktop && !failed.has(index) ? (
          <img
            key={image.id}
            src={image.url}
            alt={image.name ?? t('Image')}
            className="block max-w-full max-h-64 rounded-lg object-contain cursor-pointer hover:opacity-95 transition-opacity"
            onClick={() => setViewing(index)}
            onError={() => setFailed(current => new Set(current).add(index))}
          />
        ) : (
          <div
            key={image.id}
            className="flex min-w-0 items-center gap-1.5 rounded-lg bg-secondary/35 px-2.5 py-1.5 text-[11px] text-muted-foreground"
          >
            <ImageIcon size={12} className="shrink-0" />
            <span className="min-w-0 truncate">{sourceName ?? t('Image')}</span>
            <span className="shrink-0 text-muted-foreground/60">· {formatFileSize(image.size ?? 0)}</span>
          </div>
        )
      })}
      {viewing !== null && (
        <ImageViewer
          images={attachments.filter((_, index) => !failed.has(index))}
          initialIndex={attachments.slice(0, viewing).filter((_, index) => !failed.has(index)).length}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}
