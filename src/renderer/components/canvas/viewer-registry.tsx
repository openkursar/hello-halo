/**
 * Which viewer renders each canvas content type.
 *
 * Typed `Record<ContentType, ViewerSpec>`, so adding a content type does not
 * compile until it has a viewer. A new viewer is one entry here plus its file;
 * the host (ContentCanvas) never changes. See DESIGN.md for the viewer rules.
 */

import { lazy, type ComponentType } from 'react'
import { api } from '../../api'
import type { ContentType, TabState } from '../../services/canvas-lifecycle'
import { GoalEditor } from '../goal'
import { CodeViewer } from './viewers/CodeViewer'
import { MarkdownViewer } from './viewers/MarkdownViewer'
import { ImageViewer } from './viewers/ImageViewer'
import { HtmlViewer } from './viewers/HtmlViewer'
import { CsvViewer } from './viewers/CsvViewer'
import { BrowserViewer, BrowserViewerFallback } from './viewers/BrowserViewer'
import { TerminalViewer } from './viewers/TerminalViewer'
import { TeamViewer } from './viewers/TeamViewer'

// Office viewers ship heavy parsers (SheetJS, docx-preview, pdfjs) — lazy
// chunks keep them out of the startup bundle.
const XlsxViewer = lazy(() => import('./viewers/XlsxViewer'))
const DocxViewer = lazy(() => import('./viewers/DocxViewer'))
const PdfViewer = lazy(() => import('./viewers/PdfViewer'))
const PptxViewer = lazy(() => import('./viewers/PptxViewer'))

/** Everything the host hands a viewer; each viewer takes the part it needs. */
export interface ViewerProps {
  tab: TabState
  onScrollChange?: (position: number) => void
  onContentChange?: (content: string) => void
  onSaveComplete?: (content: string) => void
  onRevert?: () => void
  onResolveDiskConflict?: (keep: 'disk' | 'mine') => void
  onEditRequest?: () => void
}

export interface ViewerSpec {
  Component: ComponentType<ViewerProps>
  /** Shows its own loading and error states (a view that loads out of process); the host shows neither. */
  ownsLoading?: boolean
  /** Shows its own error fallback (open externally / download) instead of the host's. */
  ownsError?: boolean
}

function MarkdownEntry(props: ViewerProps) {
  return props.tab.isEditMode ? <CodeViewer {...props} /> : <MarkdownViewer {...props} />
}

// A desktop gets a BrowserView (Chromium's own renderer, PDFs included); a
// remote client has none, so PDFs render with pdfjs and pages fall back to a link.
const remote = api.isRemoteMode()

export const VIEWERS: Record<ContentType, ViewerSpec> = {
  code: { Component: CodeViewer },
  json: { Component: CodeViewer },
  text: { Component: CodeViewer },
  markdown: { Component: MarkdownEntry },
  html: { Component: HtmlViewer },
  image: { Component: ImageViewer },
  csv: { Component: CsvViewer },
  xlsx: { Component: XlsxViewer, ownsError: true },
  docx: { Component: DocxViewer, ownsError: true },
  pptx: { Component: PptxViewer, ownsError: true },
  pdf: remote ? { Component: PdfViewer, ownsError: true } : { Component: BrowserViewer, ownsLoading: true },
  browser: { Component: remote ? BrowserViewerFallback : BrowserViewer, ownsLoading: true },
  terminal: { Component: TerminalViewer },
  team: { Component: TeamViewer },
  goal: { Component: GoalEditor },
}

/** The viewer for `type`; a type with no viewer shows as text rather than a blank pane. */
export function viewerFor(type: string): ViewerSpec {
  return (VIEWERS as Record<string, ViewerSpec | undefined>)[type] ?? VIEWERS.text
}
