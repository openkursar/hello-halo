/**
 * Content Type Detection Utilities
 * Intelligently detect the best rendering type for tool results
 */

import type { ToolResultContentType } from './types'

// Extension to language mapping for syntax highlighting
export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // JavaScript/TypeScript
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',

  // Python
  py: 'python',
  pyw: 'python',
  pyi: 'python',

  // Web
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',

  // Data formats
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  svg: 'xml',

  // Shell
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'shell',
  psm1: 'shell',
  bat: 'shell',
  cmd: 'shell',

  // Markdown
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',

  // SQL
  sql: 'sql',
  mysql: 'sql',
  pgsql: 'sql',

  // Systems programming
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  cs: 'csharp',

  // Scripting
  rb: 'ruby',
  php: 'php',
  pl: 'perl',
  lua: 'lua',
  r: 'r',
  scala: 'scala',
  groovy: 'groovy',

  // Config
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  cmake: 'cmake',

  // Other
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  tex: 'latex',
  latex: 'latex',
}

/**
 * Get language from file path extension
 */
export function getLanguageFromPath(filePath: string): string | undefined {
  if (!filePath) return undefined

  // Extract extension from path
  const match = filePath.match(/\.([^./\\]+)$/)
  if (!match) {
    // Check for special filenames
    const fileName = filePath.split(/[/\\]/).pop()?.toLowerCase()
    if (fileName === 'dockerfile') return 'dockerfile'
    if (fileName === 'makefile') return 'makefile'
    if (fileName === '.gitignore') return 'bash'
    if (fileName === '.env') return 'bash'
    return undefined
  }

  const ext = match[1].toLowerCase()
  return EXTENSION_TO_LANGUAGE[ext]
}

/**
 * Check if content looks like JSON (valid only)
 */
export function looksLikeJson(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false
  }
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

/**
 * Check if content looks like structured data (JSON or JSON-like).
 *
 * Broader than looksLikeJson — also catches truncated or malformed JSON
 * that would trigger catastrophic regex backtracking in downstream markdown
 * parsers (marked's inline link regex on `[{...` patterns).
 *
 * Used as a safety gate before routing content to markdown rendering.
 */
export function looksLikeStructuredData(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false
  }
  // Valid JSON — definitely structured data
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    // Truncated/malformed JSON: [{"key": or {"key": patterns
    // Common in tool outputs that get cut off
    const head = trimmed.slice(0, 200)
    return /^\[?\s*\{\s*"/.test(head)
  }
}

/**
 * Check if content looks like Markdown
 */
export function looksLikeMarkdown(content: string): boolean {
  const trimmed = content.trim()
  // Check for common markdown patterns
  const mdPatterns = [
    /^#{1,6}\s/m,           // Headers
    /^\s*[-*+]\s/m,         // Unordered lists
    /^\s*\d+\.\s/m,         // Ordered lists
    /\[.+\]\(.+\)/,         // Links
    /`{1,3}[^`]+`{1,3}/,    // Code
    /\*\*[^*]+\*\*/,        // Bold
    /^\s*>/m,               // Blockquotes
    /^\s*```/m,             // Code blocks
  ]

  return mdPatterns.some(pattern => pattern.test(trimmed))
}

/**
 * Detect the best content type for rendering
 */
export function detectContentType(
  toolName: string,
  toolInput?: Record<string, unknown>,
  output?: string
): ToolResultContentType {
  if (!output || output.trim() === '') {
    return 'plaintext'
  }

  // Note: Read/Bash/Grep/Glob output arrives as plain text (string content block).
  // Task/WebSearch/WebFetch/LSP output arrives as JSON (array/object content block, stringified by message-utils).
  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'code'

    case 'Bash':
      return 'code' // Shell output

    case 'Grep':
      return 'search-result'

    case 'Glob':
      return 'file-list'

    case 'WebFetch':
    case 'Task':
    case 'WebSearch':
    case 'LSP':
      return 'json'

    default:
      // For unknown tools, try to detect content type
      if (looksLikeStructuredData(output)) {
        return 'json'
      }
      if (looksLikeMarkdown(output)) {
        return 'markdown'
      }
      return 'plaintext'
  }
}

/**
 * Get language for code viewer
 */
export function getLanguageForTool(
  toolName: string,
  toolInput?: Record<string, unknown>
): string {
  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'Write':
      // Get from file_path
      const filePath = toolInput?.file_path as string | undefined
      return getLanguageFromPath(filePath || '') || 'text'

    case 'NotebookEdit':
      const nbPath = toolInput?.notebook_path as string | undefined
      return getLanguageFromPath(nbPath || '') || 'python' // Notebooks are usually Python

    case 'Bash':
      return 'bash'

    default:
      return 'text'
  }
}

/**
 * Parse Grep output into structured format
 */
export function parseGrepOutput(output: string): {
  matches: Array<{
    filePath: string
    lineNumber: number
    content: string
  }>
  fileCount: number
  matchCount: number
} {
  const lines = output.split('\n').filter(line => line.trim())
  const matches: Array<{
    filePath: string
    lineNumber: number
    content: string
  }> = []
  const files = new Set<string>()

  for (const line of lines) {
    // Grep output format: file:line:content or file:line-content
    // Also handles: file-line-content (context lines)
    const match = line.match(/^([^:]+):(\d+)[:|-](.*)$/)
    if (match) {
      const [, filePath, lineNum, content] = match
      files.add(filePath)
      matches.push({
        filePath,
        lineNumber: parseInt(lineNum, 10),
        content
      })
    } else {
      // Might be a simple file path (files_with_matches mode)
      if (line.includes('/') || line.includes('\\')) {
        files.add(line)
        matches.push({
          filePath: line,
          lineNumber: 0,
          content: ''
        })
      }
    }
  }

  return {
    matches,
    fileCount: files.size,
    matchCount: matches.filter(m => m.content).length || files.size
  }
}

/**
 * Parse Glob output into file list
 */
export function parseGlobOutput(output: string): {
  items: Array<{
    path: string
    name: string
    isDirectory: boolean
  }>
  fileCount: number
  folderCount: number
} {
  const lines = output.split('\n').filter(line => line.trim())
  const items: Array<{
    path: string
    name: string
    isDirectory: boolean
  }> = []

  let fileCount = 0
  let folderCount = 0

  for (const line of lines) {
    const path = line.trim()
    if (!path) continue

    const isDirectory = path.endsWith('/')
    const name = path.split(/[/\\]/).filter(Boolean).pop() || path

    items.push({
      path: isDirectory ? path.slice(0, -1) : path,
      name,
      isDirectory
    })

    if (isDirectory) {
      folderCount++
    } else {
      fileCount++
    }
  }

  return { items, fileCount, folderCount }
}

/**
 * Count lines in content
 */
export function countLines(content: string): number {
  if (!content) return 0
  return content.split('\n').length
}

/**
 * Remove line number prefixes from tool output (cat -n format)
 * Formats handled:
 * - "     1→code" (arrow separator, used by Read tool)
 * - "     1\tcode" (tab separator, standard cat -n)
 * - "1-code" (dash separator)
 *
 * Also handles Write tool output format:
 * "The file ... has been updated. Here's the result of running `cat -n`..."
 * followed by numbered lines
 */
export function removeLineNumberPrefix(content: string): string {
  if (!content) return content

  const lines = content.split('\n')

  // Pattern for line number prefix: optional spaces + digits + (tab or arrow or dash)
  const lineNumberPattern = /^\s*\d+[\t→-]/

  // Check if first line has line number prefix
  const firstLineHasPrefix = lineNumberPattern.test(lines[0])

  if (firstLineHasPrefix) {
    // All lines have prefixes - remove from all
    return lines
      .map(line => line.replace(lineNumberPattern, ''))
      .join('\n')
  }

  // Check for Write tool format: description line followed by numbered code
  // Look for "cat -n" mention and subsequent numbered lines
  const hasCatNMention = lines[0].includes('cat -n') || lines[0].includes('`cat -n`')
  const secondLineHasPrefix = lines.length > 1 && lineNumberPattern.test(lines[1])

  if (hasCatNMention && secondLineHasPrefix) {
    // Write tool format: skip first line (description), process rest
    const codeLines = lines.slice(1)
    return codeLines
      .map(line => line.replace(lineNumberPattern, ''))
      .join('\n')
  }

  // No line number prefixes found
  return content
}

/**
 * Truncate to first N lines
 */
export function truncateToLines(content: string, maxLines: number): {
  content: string
  totalLines: number
  truncated: boolean
} {
  const lines = content.split('\n')
  const totalLines = lines.length

  if (totalLines <= maxLines) {
    return { content, totalLines, truncated: false }
  }

  return {
    content: lines.slice(0, maxLines).join('\n'),
    totalLines,
    truncated: true
  }
}
