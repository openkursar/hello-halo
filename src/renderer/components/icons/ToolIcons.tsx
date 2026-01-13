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
  Database,
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
// Space Icons with Colors
// ============================================

// Space icon identifiers (used in data storage)
export const SPACE_ICON_IDS = [
  'folder', 'code', 'globe', 'chart', 'file-text', 'palette',
  'gamepad', 'wrench', 'smartphone', 'lightbulb', 'rocket', 'star'
] as const

export type SpaceIconId = typeof SPACE_ICON_IDS[number]

// Map icon IDs to Lucide components
export const spaceIconMap: Record<string, LucideIcon> = {
  folder: Folder,
  code: FileCode,
  globe: Globe,
  chart: Database,
  'file-text': FileText,
  palette: Palette,
  gamepad: Gamepad2,
  wrench: Wrench,
  smartphone: Smartphone,
  lightbulb: Lightbulb,
  rocket: Rocket,
  star: Star,
  sparkles: Sparkles,
}

// Professional color palette for space icons
export const spaceIconColors: Record<string, string> = {
  folder: 'text-amber-500',        // Classic folder yellow
  code: 'text-blue-500',           // Tech/programming blue
  globe: 'text-cyan-500',          // Internet/global cyan
  chart: 'text-violet-500',        // Data/analytics purple
  'file-text': 'text-slate-500',   // Document neutral
  palette: 'text-pink-500',        // Design/art pink
  gamepad: 'text-emerald-500',     // Gaming green
  wrench: 'text-orange-500',       // Tools orange
  smartphone: 'text-indigo-500',   // Mobile tech
  lightbulb: 'text-yellow-500',    // Ideas/creativity
  rocket: 'text-rose-500',         // Launch/speed
  star: 'text-amber-400',          // Favorite/important
  sparkles: 'text-primary',        // Halo brand color
}

// Space icon component with color
interface SpaceIconProps {
  iconId: SpaceIconId | string
  className?: string
  size?: number
  colored?: boolean  // Whether to apply default color
}

export function SpaceIcon({ iconId, className = '', size = 20, colored = true }: SpaceIconProps) {
  const Icon = spaceIconMap[iconId as SpaceIconId] || Folder
  const colorClass = colored ? (spaceIconColors[iconId] || 'text-muted-foreground') : ''
  return <Icon className={`${colorClass} ${className}`} size={size} />
}

// ============================================
// File Type Icons
// ============================================

// File extension to icon mapping
export const fileIconMap: Record<string, LucideIcon> = {
  // Web
  html: Globe,
  htm: Globe,
  css: Palette,
  scss: Palette,
  less: Palette,
  // JavaScript/TypeScript
  js: FileCode,
  jsx: FileCode,
  ts: FileCode,
  tsx: FileCode,
  // Data
  json: FileJson,
  // Documentation
  md: Book,
  markdown: Book,
  txt: FileText,
  // Python
  py: FileCode,
  // Rust
  rs: Cpu,
  // Go
  go: FileCode,
  // Java
  java: Coffee,
  // C/C++
  cpp: Cpu,
  c: Cpu,
  h: Cpu,
  hpp: Cpu,
  // Ruby
  rb: Gem,
  // Swift
  swift: Apple,
  // SQL
  sql: Database,
  // Shell
  sh: Terminal,
  bash: Terminal,
  zsh: Terminal,
  // Config
  yaml: FileJson,
  yml: FileJson,
  xml: FileJson,
  // Images
  svg: Image,
  png: Image,
  jpg: Image,
  jpeg: Image,
  gif: Image,
  webp: Image,
  ico: Image,
  // Documents
  pdf: Book,
  doc: FileText,
  docx: FileText,
  xls: Database,
  xlsx: Database,
  // Archives
  zip: Package,
  tar: Package,
  gz: Package,
  rar: Package,
  // Default
  default: FileText,
}

// Get file icon by extension
export function getFileTypeIcon(extension: string): LucideIcon {
  const ext = extension.toLowerCase().replace('.', '')
  return fileIconMap[ext] || fileIconMap.default
}

// Professional color palette for file types
export const fileIconColors: Record<string, string> = {
  // Web - official brand colors
  html: 'text-orange-500',         // HTML5 orange
  htm: 'text-orange-500',
  css: 'text-blue-500',            // CSS3 blue
  scss: 'text-pink-500',           // Sass pink
  less: 'text-indigo-500',
  // JavaScript/TypeScript
  js: 'text-yellow-500',           // JS yellow
  jsx: 'text-cyan-400',            // React cyan
  ts: 'text-blue-600',             // TypeScript blue
  tsx: 'text-blue-500',            // React + TS
  // Data
  json: 'text-emerald-500',        // Data green
  // Documentation
  md: 'text-slate-500',            // Markdown neutral
  markdown: 'text-slate-500',
  txt: 'text-gray-500',
  // Python
  py: 'text-sky-500',              // Python blue
  // Rust
  rs: 'text-orange-600',           // Rust orange
  // Go
  go: 'text-cyan-500',             // Go cyan
  // Java
  java: 'text-red-500',            // Java red
  // C/C++
  cpp: 'text-blue-700',
  c: 'text-blue-600',
  h: 'text-violet-500',
  hpp: 'text-violet-600',
  // Ruby
  rb: 'text-red-600',              // Ruby red
  // Swift
  swift: 'text-orange-500',        // Swift orange
  // SQL
  sql: 'text-amber-600',           // Database amber
  // Shell
  sh: 'text-green-600',            // Terminal green
  bash: 'text-green-600',
  zsh: 'text-green-500',
  // Config
  yaml: 'text-red-400',
  yml: 'text-red-400',
  xml: 'text-orange-400',
  // Images
  svg: 'text-amber-500',
  png: 'text-pink-500',
  jpg: 'text-pink-500',
  jpeg: 'text-pink-500',
  gif: 'text-purple-500',
  webp: 'text-indigo-500',
  ico: 'text-blue-400',
  // Documents
  pdf: 'text-red-500',             // PDF red
  doc: 'text-blue-600',            // Word blue
  docx: 'text-blue-600',
  xls: 'text-green-600',           // Excel green
  xlsx: 'text-green-600',
  // Archives
  zip: 'text-amber-600',
  tar: 'text-amber-600',
  gz: 'text-amber-500',
  rar: 'text-purple-600',
  // Default
  default: 'text-slate-500',
  // Folder
  folder: 'text-amber-500',        // Classic folder yellow
}

// Get file icon color
export function getFileIconColor(extension: string, isFolder: boolean = false): string {
  if (isFolder) return fileIconColors.folder
  const ext = extension.toLowerCase().replace('.', '')
  return fileIconColors[ext] || fileIconColors.default
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
  const colorClass = colored ? getFileIconColor(extension, isFolder) : ''

  if (isFolder) {
    const FolderIcon = isOpen ? FolderOpen : Folder
    return <FolderIcon className={`${colorClass} ${className}`} size={size} />
  }
  const Icon = getFileTypeIcon(extension)
  return <Icon className={`${colorClass} ${className}`} size={size} />
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
