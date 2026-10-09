/**
 * ToolIcons - Centralized icon mapping using Lucide icons
 * Provides consistent, cross-platform icons for all UI elements
 */

import {
  FileText,
  FilePlus,
  FileEdit,
  Terminal,
  Search,
  FolderSearch,
  Globe,
  ListTodo,
  MessageSquare,
  GitBranch,
  Braces,
  FileCode,
  FolderOpen,
  Folder,
  Play,
  Pause,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  Loader2,
  Lightbulb,
  Zap,
  Info,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Eye,
  EyeOff,
  Sparkles,
  Hand,
  Settings,
  Plus,
  Trash2,
  ArrowLeft,
  Palette,
  Gamepad2,
  Wrench,
  Smartphone,
  Rocket,
  Star,
  FileJson,
  Image,
  Coffee,
  Gem,
  Apple,
  Flame,
  Package,
  Book,
  Cpu,
  HardDrive,
  Pencil,
  Target,
  File,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileArchive,
  type LucideIcon
} from 'lucide-react'

// Tool name to icon mapping
export const toolIconMap: Record<string, LucideIcon> = {
  // File operations
  Read: FileText,
  Write: FilePlus,
  Edit: FileEdit,

  // Search operations
  Grep: Search,
  Glob: FolderSearch,

  // Execution
  Bash: Terminal,

  // Web
  WebFetch: Globe,
  WebSearch: Globe,

  // Task management
  TodoWrite: ListTodo,
  Goal: Target,

  // Agent
  Task: Zap,

  // Notebook
  NotebookEdit: FileCode,

  // Other
  AskUserQuestion: MessageSquare,
}

// Get icon component for a tool
export function getToolIcon(toolName: string): LucideIcon {
  return toolIconMap[toolName] || Braces
}

// Status icons
export const StatusIcons = {
  pending: Clock,
  running: Loader2,
  success: CheckCircle2,
  error: XCircle,
  waiting_approval: AlertCircle,
} as const

// Thought type icons
export const ThoughtIcons = {
  thinking: Lightbulb,
  tool_use: Braces,
  tool_result: CheckCircle2,
  text: MessageSquare,
  system: Info,
  error: XCircle,
  result: Check,
} as const

// Re-export commonly used icons for convenience
export {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  Loader2,
  Lightbulb,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Eye,
  EyeOff,
  Info,
  Terminal,
  FileText,
  FilePlus,
  FileEdit,
  Search,
  FolderSearch,
  Globe,
  ListTodo,
  MessageSquare,
  Zap,
  Braces,
}

// Icon wrapper component with consistent styling
interface ToolIconProps {
  name: string
  className?: string
  size?: number
}

export function ToolIcon({ name, className = '', size = 16 }: ToolIconProps) {
  const Icon = getToolIcon(name)
  return <Icon className={className} size={size} />
}

// Status icon component
interface StatusIconProps {
  status: 'pending' | 'running' | 'success' | 'error' | 'waiting_approval'
  className?: string
  size?: number
}

export function StatusIcon({ status, className = '', size = 16 }: StatusIconProps) {
  const Icon = StatusIcons[status]
  const isSpinning = status === 'running'

  return (
    <Icon
      className={`${className} ${isSpinning ? 'animate-spin' : ''}`}
      size={size}
    />
  )
}

// ============================================
// File Type Icons
// ============================================

// Every file type shares the same page outline; only the glyph inside it says
// which kind. Grouped by kind rather than by language: a tree of mixed files
// should read as one list, not a palette.
const FILE_KINDS = {
  code: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'rb', 'swift',
    'kt', 'php', 'cs', 'sh', 'bash', 'zsh', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte',
    'json', 'yaml', 'yml', 'xml', 'toml', 'ini'],
  text: ['md', 'markdown', 'txt', 'rst', 'log', 'doc', 'docx', 'rtf'],
  image: ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif'],
  sheet: ['csv', 'tsv', 'xls', 'xlsx'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'rar', '7z'],
  pdf: ['pdf'],
} as const
type FileKind = keyof typeof FILE_KINDS | 'other'

const FILE_KIND_ICON: Record<FileKind, LucideIcon> = {
  code: FileCode2,
  text: FileText,
  pdf: FileText,
  image: FileImage,
  sheet: FileSpreadsheet,
  archive: FileArchive,
  other: File,
}

// Muted by default; only the four kinds people scan a tree for get a light tint.
const FILE_KIND_COLOR: Record<FileKind, string> = {
  code: 'text-muted-foreground',
  text: 'text-muted-foreground',
  other: 'text-muted-foreground',
  image: 'text-pink-500/80',
  sheet: 'text-green-600/80',
  archive: 'text-amber-600/80',
  pdf: 'text-red-500/80',
}

const KIND_BY_EXT: Record<string, FileKind> = Object.fromEntries(
  (Object.entries(FILE_KINDS) as [FileKind, readonly string[]][])
    .flatMap(([kind, exts]) => exts.map(ext => [ext, kind]))
)

function fileKind(extension: string): FileKind {
  return KIND_BY_EXT[extension.toLowerCase().replace('.', '')] ?? 'other'
}

// File icon component with color
interface FileIconProps {
  extension: string
  isFolder?: boolean
  isOpen?: boolean  // For folders: show open/closed state
  className?: string
  size?: number
  colored?: boolean
}

export function FileIcon({ extension, isFolder = false, isOpen = false, className = '', size = 16, colored = true }: FileIconProps) {
  if (isFolder) {
    const FolderIcon = isOpen ? FolderOpen : Folder
    return <FolderIcon className={`${colored ? 'text-muted-foreground' : ''} ${className}`} size={size} strokeWidth={1.5} />
  }
  const kind = fileKind(extension)
  const Icon = FILE_KIND_ICON[kind]
  return <Icon className={`${colored ? FILE_KIND_COLOR[kind] : ''} ${className}`} size={size} strokeWidth={1.5} />
}

// ============================================
// UI Icons (commonly used throughout app)
// ============================================

export const UIIcons = {
  sparkles: Sparkles,
  hand: Hand,
  settings: Settings,
  plus: Plus,
  trash: Trash2,
  arrowLeft: ArrowLeft,
  folder: Folder,
  folderOpen: FolderOpen,
  messageSquare: MessageSquare,
  check: Check,
  checkCircle: CheckCircle2,
  xCircle: XCircle,
  alertCircle: AlertCircle,
  lightbulb: Lightbulb,
} as const

// Re-export additional icons
export {
  Sparkles,
  Hand,
  Settings,
  Plus,
  Trash2,
  ArrowLeft,
  Folder,
  FolderOpen,
  Palette,
  Gamepad2,
  Wrench,
  Smartphone,
  Rocket,
  Star,
  FileJson,
  Image,
  Coffee,
  Gem,
  Apple,
  Package,
  Book,
  Cpu,
  HardDrive,
  Pencil,
}
