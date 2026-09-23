/**
 * Size ceiling for in-Canvas document preview (xlsx/xls/docx/pptx/pdf).
 *
 * Shared because the two transports enforce it in different processes: on
 * desktop the main process refuses the read, while in remote mode the request
 * goes to the generic download route — which must keep serving files of any size,
 * since downloading a large file is the point of that route — so the preview
 * caller in the renderer has to hold the line itself. One constant so the two
 * can never disagree about where the line is.
 *
 * Past this size the viewer must parse the whole file before anything paints and
 * then holds the bytes for the life of the tab; the fallback (open externally /
 * download) is the better experience.
 */
export const MAX_PREVIEW_DOCUMENT_SIZE = 25 * 1024 * 1024

/** Human-readable byte size for preview limit messages. */
export function formatPreviewSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
