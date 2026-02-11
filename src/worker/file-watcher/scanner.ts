/**
 * File Scanner -- runs inside file-watcher utility process.
 *
 * Responsibilities:
 * - readdir with Dirent (zero stat calls for initial scan)
 * - .gitignore filtering
 * - Hidden pattern filtering
 * - Tree node / artifact creation
 *
 * HARD CONSTRAINT: This file MUST NOT import anything from 'electron'.
 */

import { join, extname, relative, sep } from 'path'
import { promises as fs, readFileSync, existsSync, type Dirent } from 'fs'
import ignore, { type Ignore } from 'ignore'
import {
  ALWAYS_IGNORE_DIRS,
  BASELINE_IGNORE_PATTERNS
} from '../../shared/constants/ignore-patterns'
import type { CachedTreeNode, CachedArtifact } from '../../shared/types/artifact'

// --- Constants ---

const HIDDEN_PATTERNS = [
  /\.DS_Store$/,
  /Thumbs\.db$/,
  /desktop\.ini$/,
]

const FILE_ICON_IDS: Record<string, string> = {
  html: 'globe', htm: 'globe', css: 'palette', scss: 'palette', less: 'palette',
  js: 'file-code', jsx: 'file-code', ts: 'file-code', tsx: 'file-code',
  json: 'file-json', md: 'book', markdown: 'book', txt: 'file-text',
  py: 'file-code', rs: 'cpu', go: 'file-code', java: 'coffee',
  cpp: 'cpu', c: 'cpu', h: 'cpu', hpp: 'cpu', vue: 'file-code',
  svelte: 'file-code', php: 'file-code', rb: 'gem', swift: 'file-code',
  kt: 'file-code', sql: 'database', sh: 'terminal', bash: 'terminal',
  zsh: 'terminal', yaml: 'file-json', yml: 'file-json', xml: 'file-json',
  svg: 'image', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  webp: 'image', ico: 'image', pdf: 'book', default: 'file-text'
}

// --- Helpers ---

let idCounter = 0
export function generateId(): string {
  return `artifact-${++idCounter}`
}

export function getFileIconId(ext: string): string {
  const normalized = ext.toLowerCase().replace('.', '')
  return FILE_ICON_IDS[normalized] || FILE_ICON_IDS.default
}

export function shouldHide(filePath: string): boolean {
  return HIDDEN_PATTERNS.some(pattern => pattern.test(filePath))
}

export function isDiskRoot(path: string): boolean {
  if (/^[A-Z]:\\?$/i.test(path)) return true
  if (path === '/') return true
  if (/^\/Volumes\/[^/]+\/?$/.test(path)) return true
  if (/^\/mnt\/[^/]+\/?$/.test(path)) return true
  if (/^\/media\/[^/]+\/?$/.test(path)) return true
  return false
}

// --- .gitignore ---

export function loadIgnoreRules(rootPath: string): Ignore {
  const ig = ignore()
  ig.add(ALWAYS_IGNORE_DIRS)
  ig.add(BASELINE_IGNORE_PATTERNS)

  const rootGitignore = join(rootPath, '.gitignore')
  if (existsSync(rootGitignore)) {
    try {
      const content = readFileSync(rootGitignore, 'utf-8')
      ig.add(content)
    } catch (error) {
      console.warn(`[Scanner] Failed to read .gitignore:`, error)
    }
  }
  return ig
}

export function isIgnored(ig: Ignore, relativePath: string): boolean {
  if (!relativePath || relativePath === '.') return false
  const normalized = sep === '/' ? relativePath : relativePath.split(sep).join('/')
  return ig.ignores(normalized)
}

// --- Dirent-based creation (zero stat) ---

export function createTreeNodeFromDirent(
  entry: Dirent,
  dirPath: string,
  rootPath: string,
  depth: number
): CachedTreeNode {
  const fullPath = join(dirPath, entry.name)
  const ext = extname(entry.name)
  const relativePath = relative(rootPath, fullPath)
  const isDir = entry.isDirectory()

  return {
    id: generateId(),
    name: entry.name,
    type: isDir ? 'folder' : 'file',
    path: fullPath,
    relativePath,
    extension: ext.replace('.', ''),
    icon: isDir ? 'folder' : getFileIconId(ext),
    depth,
    children: isDir ? [] : undefined,
    childrenLoaded: false
  }
}

export function createArtifactFromDirent(
  entry: Dirent,
  dirPath: string,
  rootPath: string,
  spaceId: string
): CachedArtifact {
  const fullPath = join(dirPath, entry.name)
  const ext = extname(entry.name)
  const relativePath = relative(rootPath, fullPath)
  const isDir = entry.isDirectory()

  return {
    id: generateId(),
    spaceId,
    name: entry.name,
    type: isDir ? 'folder' : 'file',
    path: fullPath,
    relativePath,
    extension: ext.replace('.', ''),
    icon: isDir ? 'folder' : getFileIconId(ext),
    createdAt: '',
    modifiedAt: ''
  }
}

// --- stat-based creation (for watcher events) ---

export async function createArtifactFromPath(
  fullPath: string,
  rootPath: string,
  spaceId: string
): Promise<CachedArtifact | null> {
  try {
    const stats = await fs.stat(fullPath)
    const ext = extname(fullPath)
    const name = fullPath.split(/[\\/]/).pop() || ''
    const relativePath = relative(rootPath, fullPath)
    const isDir = stats.isDirectory()

    return {
      id: generateId(),
      spaceId,
      name,
      type: isDir ? 'folder' : 'file',
      path: fullPath,
      relativePath,
      extension: ext.replace('.', ''),
      icon: isDir ? 'folder' : getFileIconId(ext),
      createdAt: '',
      modifiedAt: ''
    }
  } catch {
    return null
  }
}

export function createTreeNodeFromArtifact(
  artifact: CachedArtifact,
  depth: number
): CachedTreeNode {
  return {
    id: generateId(),
    name: artifact.name,
    type: artifact.type,
    path: artifact.path,
    relativePath: artifact.relativePath,
    extension: artifact.extension,
    icon: artifact.icon,
    depth,
    children: artifact.type === 'folder' ? [] : undefined,
    childrenLoaded: false
  }
}

// --- Directory scanning ---

export async function scanDirectoryTreeShallow(
  dirPath: string,
  rootPath: string,
  depth: number,
  ig: Ignore | null
): Promise<CachedTreeNode[]> {
  const nodes: CachedTreeNode[] = []

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })

    let ignoredCount = 0
    let hiddenCount = 0
    for (const entry of entries) {
      if (shouldHide(entry.name)) { hiddenCount++; continue }
      if (ig) {
        const entryRelative = relative(rootPath, join(dirPath, entry.name))
        if (isIgnored(ig, entryRelative)) { ignoredCount++; continue }
      }
      nodes.push(createTreeNodeFromDirent(entry, dirPath, rootPath, depth))
    }
    console.log(`[Scanner] scanTreeShallow: ${dirPath} — ${entries.length} entries, ${nodes.length} visible, ${ignoredCount} ignored, ${hiddenCount} hidden`)
  } catch (error) {
    console.error(`[Scanner] Failed to scan tree ${dirPath}:`, error)
  }

  return nodes
}

export async function scanDirectoryShallow(
  dirPath: string,
  rootPath: string,
  spaceId: string,
  ig: Ignore | null
): Promise<CachedArtifact[]> {
  const artifacts: CachedArtifact[] = []

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (shouldHide(entry.name)) continue
      if (ig) {
        const entryRelative = relative(rootPath, join(dirPath, entry.name))
        if (isIgnored(ig, entryRelative)) continue
      }
      artifacts.push(createArtifactFromDirent(entry, dirPath, rootPath, spaceId))
    }
  } catch (error) {
    console.error(`[Scanner] Failed to scan ${dirPath}:`, error)
  }

  return artifacts
}

export async function scanDirectoryRecursive(
  dirPath: string,
  rootPath: string,
  spaceId: string,
  maxDepth: number,
  currentDepth: number,
  ig: Ignore | null
): Promise<CachedArtifact[]> {
  if (currentDepth >= maxDepth || !existsSync(dirPath)) return []

  const artifacts: CachedArtifact[] = []
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (shouldHide(entry.name)) continue
      if (ig) {
        const entryRelative = relative(rootPath, join(dirPath, entry.name))
        if (isIgnored(ig, entryRelative)) continue
      }
      artifacts.push(createArtifactFromDirent(entry, dirPath, rootPath, spaceId))
      if (entry.isDirectory()) {
        const subItems = await scanDirectoryRecursive(
          join(dirPath, entry.name), rootPath, spaceId, maxDepth, currentDepth + 1, ig
        )
        artifacts.push(...subItems)
      }
    }
  } catch (error) {
    console.error(`[Scanner] Failed to scan ${dirPath}:`, error)
  }

  return artifacts
}
