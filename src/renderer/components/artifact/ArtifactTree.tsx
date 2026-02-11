/**
 * ArtifactTree - Professional tree view using react-arborist
 * VSCode-style file explorer with virtual scrolling and lazy loading
 *
 * PERFORMANCE OPTIMIZED:
 * - Zero conversion: backend CachedTreeNode shape consumed directly (no intermediate types)
 * - O(1) node lookup: mutable Map<path, node> index avoids recursive tree traversal
 * - Mutable ref + revision counter: watcher updates mutate in place, single shallow copy triggers render
 * - CSS-only hover: no per-node React state for mouse events
 * - Lazy loading: children fetched on-demand when expanding folders
 */

import { useState, useCallback, useEffect, useMemo, createContext, useContext, useRef } from 'react'
import { Tree, NodeRendererProps } from 'react-arborist'
import { api } from '../../api'
import { useCanvasStore } from '../../stores/canvas.store'
import type { ArtifactTreeNode, ArtifactTreeUpdateEvent } from '../../types'
import { FileIcon } from '../icons/ToolIcons'
import { ChevronRight, ChevronDown, Download, Eye, Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { canOpenInCanvas } from '../../constants/file-types'

// Context to pass openFile function to tree nodes without each node subscribing to store
type OpenFileFn = (path: string, title?: string) => Promise<void>
const OpenFileContext = createContext<OpenFileFn | null>(null)

const isWebMode = api.isRemoteMode()

// Directories that should be visually dimmed (secondary importance)
const DIMMED_DIRS = new Set([
  // Dependencies
  'node_modules', 'vendor', 'venv', '.venv', 'Pods', 'bower_components',
  // Build outputs
  'dist', 'build', 'out', 'target', '.output', 'bin', 'obj',
  // Framework caches
  '.next', '.nuxt', '.cache', '.turbo', '.parcel-cache', '.webpack',
  // Version control
  '.git', '.svn', '.hg',
  // IDE/Editor
  '.idea', '.vscode', '.vs',
  // Test/Coverage
  'coverage', '.nyc_output', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox',
  // Misc
  '.halo', 'logs', 'tmp', 'temp',
])

function isDimmed(name: string): boolean {
  if (name.startsWith('.')) return true
  return DIMMED_DIRS.has(name)
}

interface ArtifactTreeProps {
  spaceId: string
}

// Fixed offsets for tree height calculation (in pixels)
const TREE_HEIGHT_OFFSET = 180

function useTreeHeight() {
  const [height, setHeight] = useState(() => window.innerHeight - TREE_HEIGHT_OFFSET)

  useEffect(() => {
    const handleResize = () => setHeight(window.innerHeight - TREE_HEIGHT_OFFSET)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return height
}

// Get parent directory path (supports both / and \ separators)
function getParentPath(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastSep > 0 ? filePath.substring(0, lastSep) : filePath
}

// Context for lazy loading children
interface LazyLoadContextType {
  loadChildren: (path: string) => Promise<void>
  loadingPaths: Set<string>
}
const LazyLoadContext = createContext<LazyLoadContextType | null>(null)

// ============================================
// Index helpers — maintain Map<path, node> for O(1) lookup
// ============================================

/** Add direct children to the index (non-recursive — deeper nodes indexed on expand) */
function indexNodes(nodes: ArtifactTreeNode[], index: Map<string, ArtifactTreeNode>): void {
  for (const node of nodes) {
    index.set(node.path, node)
  }
}

/** Remove a node and its entire expanded subtree from the index */
function removeSubtreeFromIndex(node: ArtifactTreeNode, index: Map<string, ArtifactTreeNode>): void {
  index.delete(node.path)
  if (node.children) {
    for (const child of node.children) {
      removeSubtreeFromIndex(child, index)
    }
  }
}

/**
 * Merge incoming children (from watcher or IPC) with existing children.
 * Preserves react-arborist node id (key stability) and expanded folder state.
 * Maintains the path→node index as a side effect.
 */
function mergeChildren(
  incoming: ArtifactTreeNode[],
  existing: ArtifactTreeNode[],
  index: Map<string, ArtifactTreeNode>
): ArtifactTreeNode[] {
  const existingByPath = new Map(existing.map(n => [n.path, n]))

  // Remove deleted nodes from index
  const incomingPaths = new Set(incoming.map(n => n.path))
  for (const node of existing) {
    if (!incomingPaths.has(node.path)) {
      removeSubtreeFromIndex(node, index)
    }
  }

  return incoming.map(node => {
    const prev = existingByPath.get(node.path)
    if (prev) {
      // Preserve react-arborist key
      node.id = prev.id
      // Preserve expanded state: keep children the user already loaded
      if (prev.childrenLoaded && prev.children) {
        node.children = prev.children
        node.childrenLoaded = prev.childrenLoaded
      }
    }
    index.set(node.path, node)
    return node
  })
}

// ============================================
// ArtifactTree component
// ============================================

export function ArtifactTree({ spaceId }: ArtifactTreeProps) {
  const { t } = useTranslation()
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const treeHeight = useTreeHeight()
  const watcherInitialized = useRef(false)

  // Whether the initial IPC load has completed (distinguishes "loading" from "truly empty")
  const [hasLoaded, setHasLoaded] = useState(false)

  // Mutable tree data + path→node index (avoids full-tree immutable copies)
  const nodeIndex = useRef<Map<string, ArtifactTreeNode>>(new Map())
  const treeDataRef = useRef<ArtifactTreeNode[]>([])
  // Revision counter — incrementing triggers react-arborist to pick up mutated data
  const [revision, setRevision] = useState(0)

  const openFile = useCanvasStore(state => state.openFile)

  // Load tree data (root level only for lazy loading)
  const loadTree = useCallback(async () => {
    if (!spaceId) return

    try {
      console.log('[ArtifactTree] loadTree START, spaceId:', spaceId)
      const response = await api.listArtifactsTree(spaceId)
      console.log('[ArtifactTree] loadTree IPC response: success=%s, nodeCount=%d',
        response.success, response.data?.length ?? 0)
      if (response.success && response.data) {
        const nodes = response.data as ArtifactTreeNode[]
        treeDataRef.current = nodes
        nodeIndex.current.clear()
        indexNodes(nodes, nodeIndex.current)
        setRevision(r => r + 1)
      } else {
        console.warn('[ArtifactTree] loadTree: response not successful or no data', response)
      }
    } catch (error) {
      console.error('[ArtifactTree] Failed to load tree:', error)
    } finally {
      setHasLoaded(true)
    }
  }, [spaceId])

  // Lazy load children for a folder — mutates ref in place, O(1) lookup
  const loadChildren = useCallback(async (dirPath: string): Promise<void> => {
    if (!spaceId) return

    try {
      console.log('[ArtifactTree] loadChildren START: %s', dirPath)
      setLoadingPaths(prev => new Set(prev).add(dirPath))
      const response = await api.loadArtifactChildren(spaceId, dirPath)

      console.log('[ArtifactTree] loadChildren IPC response: success=%s, childCount=%d, path=%s',
        response.success, response.data?.length ?? 0, dirPath)
      if (response.success && response.data) {
        const children = response.data as ArtifactTreeNode[]
        const parent = nodeIndex.current.get(dirPath)
        if (parent) {
          parent.children = children
          parent.childrenLoaded = true
          indexNodes(children, nodeIndex.current)
          setRevision(r => r + 1)
          console.log('[ArtifactTree] loadChildren OK: %d children attached to "%s", hasChildren=%s',
            children.length, parent.name, Array.isArray(parent.children))
        } else {
          console.warn('[ArtifactTree] loadChildren: parent NOT in nodeIndex — path=%s, indexSize=%d',
            dirPath, nodeIndex.current.size)
        }
      } else {
        console.warn('[ArtifactTree] loadChildren: response not successful or empty — path=%s', dirPath)
      }
    } catch (error) {
      console.error('[ArtifactTree] Failed to load children:', error)
    } finally {
      setLoadingPaths(prev => {
        const next = new Set(prev)
        next.delete(dirPath)
        return next
      })
    }
  }, [spaceId])

  // Handle tree update events from watcher (pre-computed data, zero IPC round-trips)
  // O(1) node lookup via index, mutate in place, single revision bump
  const handleTreeUpdate = useCallback((event: ArtifactTreeUpdateEvent) => {
    if (event.spaceId !== spaceId || event.updatedDirs.length === 0) return

    for (const { dirPath, children } of event.updatedDirs) {
      const incomingChildren = children as ArtifactTreeNode[]
      const parent = nodeIndex.current.get(dirPath)

      if (parent) {
        // Known expanded directory — O(1) lookup, merge children
        parent.children = mergeChildren(incomingChildren, parent.children || [], nodeIndex.current)
        parent.childrenLoaded = true
      } else {
        // Check if this is a root-level update
        const isRoot = treeDataRef.current.length > 0 &&
          treeDataRef.current.some(n => getParentPath(n.path) === dirPath)

        if (isRoot || treeDataRef.current.length === 0) {
          treeDataRef.current = mergeChildren(incomingChildren, treeDataRef.current, nodeIndex.current)
        }
        // Else: untracked directory, skip — will be loaded on first expand
      }
    }

    setRevision(r => r + 1)
  }, [spaceId])

  // Initialize watcher and subscribe to changes
  useEffect(() => {
    if (!spaceId || watcherInitialized.current) return

    api.initArtifactWatcher(spaceId).catch(err => {
      console.error('[ArtifactTree] Failed to init watcher:', err)
    })

    const cleanup = api.onArtifactTreeUpdate(handleTreeUpdate)
    watcherInitialized.current = true

    return () => {
      cleanup()
      watcherInitialized.current = false
    }
  }, [spaceId, handleTreeUpdate])

  // Load on mount and when space changes
  useEffect(() => {
    loadTree()
  }, [loadTree])

  // New shallow root array only when revision changes — internal nodes are same (mutated) objects
  const treeData = useMemo(() => [...treeDataRef.current], [revision])

  const lazyLoadValue = useMemo(() => ({
    loadChildren,
    loadingPaths
  }), [loadChildren, loadingPaths])

  // Three-state empty check: loading → show nothing; loaded & empty → "No files"
  if (treeData.length === 0) {
    if (!hasLoaded) {
      // Still loading — render empty container to avoid "No files" flash
      return null
    }
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-2">
        <div className="w-10 h-10 rounded-lg border border-dashed border-muted-foreground/30 flex items-center justify-center mb-2">
          <ChevronRight className="w-5 h-5 text-muted-foreground/40" />
        </div>
        <p className="text-xs text-muted-foreground">{t('No files')}</p>
      </div>
    )
  }

  return (
    <OpenFileContext.Provider value={openFile}>
      <LazyLoadContext.Provider value={lazyLoadValue}>
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex-shrink-0 bg-card px-2 py-1.5 border-b border-border/50 text-[10px] text-muted-foreground/80 [.light_&]:text-muted-foreground uppercase tracking-wider">
            {t('Files')}
          </div>

          {/* Tree — uses window height based calculation */}
          <div className="flex-1 overflow-hidden">
            <Tree<ArtifactTreeNode>
              data={treeData}
              openByDefault={false}
              width="100%"
              height={treeHeight}
              indent={16}
              rowHeight={26}
              overscanCount={5}
              paddingTop={4}
              paddingBottom={4}
              disableDrag
              disableDrop
              disableEdit
            >
              {TreeNodeComponent}
            </Tree>
          </div>
        </div>
      </LazyLoadContext.Provider>
    </OpenFileContext.Provider>
  )
}

// ============================================
// Tree node renderer — CSS-only hover, no per-node state
// ============================================

function TreeNodeComponent({ node, style, dragHandle }: NodeRendererProps<ArtifactTreeNode>) {
  const { t } = useTranslation()
  const openFile = useContext(OpenFileContext)
  const lazyLoad = useContext(LazyLoadContext)
  const data = node.data
  const isFolder = data.type === 'folder'
  const isLoading = lazyLoad?.loadingPaths.has(data.path) ?? false
  const dimmed = isDimmed(data.name)
  const canViewInCanvas = !isFolder && canOpenInCanvas(data.extension)

  // Handle folder toggle with lazy loading
  const handleToggle = useCallback(async () => {
    if (!isFolder) return
    console.log('[ArtifactTree] handleToggle: name="%s", isOpen=%s, isLeaf=%s, childrenLoaded=%s, dataChildren=%s',
      data.name, node.isOpen, node.isLeaf, data.childrenLoaded,
      Array.isArray(data.children) ? data.children.length : String(data.children))
    if (!node.isOpen && !data.childrenLoaded && lazyLoad) {
      await lazyLoad.loadChildren(data.path)
    }
    node.toggle()
    console.log('[ArtifactTree] handleToggle DONE: name="%s", toggled to open=%s', data.name, !node.isOpen)
  }, [isFolder, node, data.childrenLoaded, data.path, lazyLoad])

  // Handle click — open in canvas, system app, or download
  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isFolder) {
      handleToggle()
      return
    }

    if (canViewInCanvas && openFile) {
      openFile(data.path, data.name)
      return
    }

    if (isWebMode) {
      api.downloadArtifact(data.path)
    } else {
      try {
        await api.openArtifact(data.path)
      } catch (error) {
        console.error('Failed to open file:', error)
      }
    }
  }

  // Handle double-click to force open with system app
  const handleDoubleClickFile = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isFolder) {
      node.toggle()
      return
    }
    if (isWebMode) {
      api.downloadArtifact(data.path)
    } else {
      try {
        await api.openArtifact(data.path)
      } catch (error) {
        console.error('Failed to open file:', error)
      }
    }
  }

  // Handle right-click — show in folder (desktop only)
  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isWebMode) {
      try {
        await api.showArtifactInFolder(data.path)
      } catch (error) {
        console.error('Failed to show in folder:', error)
      }
    }
  }

  return (
    <div
      ref={dragHandle}
      style={style}
      onClick={handleClick}
      onDoubleClick={handleDoubleClickFile}
      onContextMenu={handleContextMenu}
      className={`
        group flex items-center h-full pr-2 cursor-pointer select-none
        transition-colors duration-75
        ${node.isSelected ? 'bg-primary/15' : 'hover:bg-secondary/60'}
        ${node.isFocused ? 'outline outline-1 outline-primary/50 -outline-offset-1' : ''}
      `}
      title={canViewInCanvas
        ? t('Click to preview · double-click to open with system')
        : (isWebMode && !isFolder ? t('Click to download file') : data.path)
      }
    >
      {/* Expand/collapse arrow for folders (or loading spinner) */}
      <span
        className="w-4 h-4 flex items-center justify-center flex-shrink-0"
        onClick={(e) => {
          e.stopPropagation()
          if (isFolder) handleToggle()
        }}
      >
        {isFolder ? (
          isLoading ? (
            <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
          ) : node.isOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/70" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/70" />
          )
        ) : null}
      </span>

      {/* File/folder icon */}
      <span className={`w-4 h-4 flex items-center justify-center flex-shrink-0 mr-1.5 ${dimmed ? 'opacity-50' : ''}`}>
        <FileIcon
          extension={data.extension}
          isFolder={isFolder}
          isOpen={isFolder && node.isOpen}
          size={15}
        />
      </span>

      {/* File name */}
      <span className={`
        text-[13px] truncate flex-1
        ${isFolder ? 'font-medium' : ''}
        ${dimmed ? 'text-muted-foreground/50' : (isFolder ? 'text-foreground/90' : 'text-foreground/80')}
      `}>
        {data.name}
      </span>

      {/* Action icons — CSS-only visibility via group-hover, zero JS overhead */}
      {!isFolder && canViewInCanvas && (
        <Eye className="w-3 h-3 text-primary flex-shrink-0 ml-1 opacity-0 group-hover:opacity-100 transition-opacity duration-75" />
      )}
      {!isFolder && !canViewInCanvas && isWebMode && (
        <Download className="w-3 h-3 text-primary flex-shrink-0 ml-1 opacity-0 group-hover:opacity-100 transition-opacity duration-75" />
      )}
    </div>
  )
}
