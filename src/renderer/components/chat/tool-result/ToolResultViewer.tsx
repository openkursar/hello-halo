/**
 * ToolResultViewer - Intelligent rendering for tool results
 *
 * Automatically detects content type and renders with appropriate viewer:
 * - Code: Syntax highlighting + line numbers (Read/Bash)
 * - Search: Grep results with file paths and match highlighting
 * - FileList: Glob results as file/folder list
 * - Markdown: Rendered markdown (WebFetch/Task)
 * - JSON: Formatted and highlighted JSON
 * - PlainText: Fallback for unknown content
 *
 * Design principles:
 * - Default collapsed: Only show preview to not overwhelm user
 * - Smart preview: Show enough to understand content
 * - Expandable: Full content available on demand
 * - Copy support: Easy clipboard access
 */

import { memo } from 'react'
import type { ToolResultViewerProps } from './types'
import { detectContentType, getLanguageForTool } from './detection'
import { CodeResultViewer } from './CodeResultViewer'
import { SearchResultViewer } from './SearchResultViewer'
import { FileListViewer } from './FileListViewer'
import { MarkdownResultViewer } from './MarkdownResultViewer'
import { JsonResultViewer } from './JsonResultViewer'
import { PlainTextViewer } from './PlainTextViewer'
import { useTranslation } from '../../../i18n'

export const ToolResultViewer = memo(function ToolResultViewer({
  toolName,
  toolInput,
  output,
  isError
}: ToolResultViewerProps) {
  const { t } = useTranslation()

  // Handle empty output
  if (!output || output.trim() === '') {
    return (
      <div className="mt-1.5 px-2.5 py-1.5 rounded-lg bg-muted/20 border border-border/30">
        <span className="text-[11px] text-muted-foreground/50 italic">
          {t('No output')}
        </span>
      </div>
    )
  }

  // Detect content type
  const contentType = detectContentType(toolName, toolInput, output)

  // Get language for code viewer
  const language = getLanguageForTool(toolName, toolInput)

  // Render based on content type
  switch (contentType) {
    case 'code':
      return (
        <CodeResultViewer
          output={output}
          isError={isError}
          language={language}
          toolInput={toolInput}
        />
      )

    case 'search-result':
      return (
        <SearchResultViewer
          output={output}
          isError={isError}
          toolInput={toolInput}
        />
      )

    case 'file-list':
      return (
        <FileListViewer
          output={output}
          isError={isError}
          toolInput={toolInput}
        />
      )

    case 'markdown':
      return (
        <MarkdownResultViewer
          output={output}
          isError={isError}
          toolInput={toolInput}
        />
      )

    case 'json':
      return (
        <JsonResultViewer
          output={output}
          isError={isError}
          toolInput={toolInput}
        />
      )

    default:
      return (
        <PlainTextViewer
          output={output}
          isError={isError}
          toolInput={toolInput}
        />
      )
  }
})
