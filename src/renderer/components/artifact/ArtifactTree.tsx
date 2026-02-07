/**
 * ArtifactTree - Professional tree view using react-arborist
 * VSCode-style file explorer with keyboard navigation, virtual scrolling, and more
 *
 * PERFORMANCE OPTIMIZED:
 * - Lazy loading: children are fetched on-demand when expanding folders
 * - Incremental updates: file watcher events update tree without full refresh
 * - Cached data: tree state is preserved across re-renders
 */

import { useState, useCallback, useEffect, useMemo, createContext, useContext, useRef } from 'react'
import { Tree, NodeRendererProps, NodeApi } from 'react-arborist'
import { api } from '../../api'
import { useCanvasStore } from '../../stores/canvas.store'
import type { ArtifactTreeNode, ArtifactTreeUpdateEvent } from '../../types'
import { FileIcon } from '../icons/ToolIcons'
import { ChevronRight, ChevronDown, Download, Eye, Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { canOpenInCanvas } from '../../constants/file-types'

// Context to pass openFile function to tree nodes without each node subscribing to store
// This prevents massive re-renders when canvas state changes
type OpenFileFn = (path: string, title?: string) => Promise<void>
const OpenFileContext = createContext<OpenFileFn | null>(null)

const isWebMode = api.isRemoteMode()

// Directories that should be visually dimmed (secondary importance)
// These are shown but with reduced opacity to help users focus on source code
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

// Check if a file/folder should be dimmed (shown with reduced opacity)
function isDimmed(name: string): boolean {
  // Hidden files (starting with .) are dimmed
  if (name.startsWith('.')) return true
  // Known secondary directories are dimmed
  return DIMMED_DIRS.has(name)
}

interface ArtifactTreeProps {
  spaceId: string
}

// Fixed offsets for tree height calculation (in pixels)
// App Header (44) + Rail Header (40) + Rail Footer (~60) + Tree Header (28) + buffer
const TREE_HEIGHT_OFFSET = 180

// Simple hook using window height minus fixed offset
// No complex measurement needed - window.innerHeight is always immediately available
function useTreeHeight() {
  const [height, setHeight] = useState(() => window.innerHeight - TREE_HEIGHT_OFFSET)

  useEffect(() => {
    const handleResize = () => {
      setHeight(window.innerHeight - TREE_HEIGHT_OFFSET)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return height
}

// Transform backend tree data to react-arborist format
interface TreeNodeData {
  id: string
  name: string
  path: string
  extension: string
  isFolder: boolean
  children?: TreeNodeData[]
  childrenLoaded?: boolean  // For lazy loading
  isLoading?: boolean       // Loading indicator for this folder
}

// Context for lazy loading children
interface LazyLoadContextType {
  loadChildren: (path: string) => Promise<TreeNodeData[]>
  loadingPaths: Set<string>
}
const LazyLoadContext = createContext<LazyLoadContextType | null>(null)

// Get parent directory path (client-side helper, same logic as backend getParentPath)
function getParentPathClient(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastSep > 0 ? filePath.substring(0, lastSep) : filePath
}

function transformToArboristData(nodes: ArtifactTreeNode[]): TreeNodeData[] {
  return nodes.map(node => ({
    id: node.id,
    name: node.name,
    path: node.path,
    extension: node.extension,
    isFolder: node.type === 'folder',
    children: node.children ? transformToArboristData(node.children) : (node.type === 'folder' ? [] : undefined),
    childrenLoaded: node.childrenLoaded ?? false
  }))
}

export function ArtifactTree({ spaceId }: ArtifactTreeProps) {
  const { t } = useTranslation()
  const [treeData, setTreeData] = useState<TreeNodeData[]>([])
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const treeHeight = useTreeHeight()
  const watcherInitialized = useRef(false)

  // Subscribe to openFile once at parent level, pass down via context
  // This prevents each TreeNodeComponent from subscribing to the store
  const openFile = useCanvasStore(state => state.openFile)

  // Load tree data (root level only for lazy loading)
  const loadTree = useCallback(async () => {
    if (!spaceId) return

    try {
      const response = await api.listArtifactsTree(spaceId)
      if (response.success && response.data) {
        const transformed = transformToArboristData(response.data as ArtifactTreeNode[])
        setTreeData(transformed)
      }
    } catch (error) {
      console.error('[ArtifactTree] Failed to load tree:', error)
    }
  }, [spaceId])

  // Lazy load children for a folder
  const loadChildren = useCallback(async (dirPath: string): Promise<TreeNodeData[]> => {
    if (!spaceId) return []

    try {
      setLoadingPaths(prev => new Set(prev).add(dirPath))
      const response = await api.loadArtifactChildren(spaceId, dirPath)

      if (response.success && response.data) {
        const children = transformToArboristData(response.data as ArtifactTreeNode[])

        // Update tree data with loaded children
        setTreeData(prev => {
          const updateNodeChildren = (nodes: TreeNodeData[]): TreeNodeData[] => {
            return nodes.map(node => {
              if (node.path === dirPath) {
                return { ...node, children, childrenLoaded: true }
              }
              if (node.children) {
                return { ...node, children: updateNodeChildren(node.children) }
              }
              return node
            })
          }
          return updateNodeChildren(prev)
        })

        return children
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
    return []
  }, [spaceId])

  // Handle tree update events from watcher (pre-computed data, zero IPC round-trips)
  const handleTreeUpdate = useCallback((event: ArtifactTreeUpdateEvent) => {
    if (event.spaceId !== spaceId) return

    console.log('[ArtifactTree] Tree update:', event.updatedDirs.length, 'dirs,', event.changes.length, 'changes')

    if (event.updatedDirs.length === 0) {
      // No tracked dirs affected — watcher event for an unloaded directory, ignore.
      // The correct data will be fetched on-demand when user expands that directory.
      return
    }

    setTreeData(prev => {
      let updated = prev

      for (const { dirPath, children } of event.updatedDirs) {
        const incomingChildren = transformToArboristData(children as ArtifactTreeNode[])

        // Merge incoming children with existing nodes: preserve id, children, and
        // childrenLoaded from already-present nodes so react-arborist keeps its
        // open/closed state (it tracks state by node id).
        const mergeChildren = (incoming: TreeNodeData[], existing: TreeNodeData[]): TreeNodeData[] => {
          const existingByPath = new Map(existing.map(n => [n.path, n]))
          return incoming.map(node => {
            const prev = existingByPath.get(node.path)
            if (prev) {
              // Preserve id (react-arborist key), children & childrenLoaded (expanded state)
              return {
                ...node,
                id: prev.id,
                children: prev.childrenLoaded && prev.children ? prev.children : node.children,
                childrenLoaded: prev.childrenLoaded || node.childrenLoaded,
              }
            }
            return node
          })
        }

        // Check if this is the root directory (parent of top-level nodes)
        const isRoot = prev.length > 0 && prev.some(n => {
          const parentOfNode = getParentPathClient(n.path)
          return parentOfNode === dirPath
        })

        if (isRoot || (prev.length === 0 && incomingChildren.length > 0)) {
          // Root update: merge with existing top-level nodes
          updated = mergeChildren(incomingChildren, updated)
        } else {
          // Walk the tree to find the node matching dirPath and merge its children
          const updateNodeInTree = (nodes: TreeNodeData[]): TreeNodeData[] => {
            return nodes.map(node => {
              if (node.path === dirPath) {
                const merged = mergeChildren(incomingChildren, node.children || [])
                return { ...node, children: merged, childrenLoaded: true }
              }
              if (node.children) {
                return { ...node, children: updateNodeInTree(node.children) }
              }
              return node
            })
          }
          updated = updateNodeInTree(updated)
        }
      }

      return updated
    })
  }, [spaceId])

  // Initialize watcher and subscribe to changes
  useEffect(() => {
    if (!spaceId || watcherInitialized.current) return

    // Initialize watcher
    api.initArtifactWatcher(spaceId).catch(err => {
      console.error('[ArtifactTree] Failed to init watcher:', err)
    })

    // Subscribe to tree update events (pre-computed data, zero IPC round-trips)
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

  // Note: no safety-net refresh here. The watcher + incremental update pipeline is the
  // single source of truth. A full loadTree would destroy expanded folder state.

  // Lazy load context value
  const lazyLoadValue = useMemo(() => ({
    loadChildren,
    loadingPaths
  }), [loadChildren, loadingPaths])

  if (treeData.length === 0) {
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

          {/* Tree - uses window height based calculation */}
          <div className="flex-1 overflow-hidden">
            <Tree
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

// Custom node renderer for VSCode-like appearance
// Uses context for openFile to avoid store subscription in each node
function TreeNodeComponent({ node, style, dragHandle }: NodeRendererProps<TreeNodeData>) {
  const { t } = useTranslation()
  const [isHovered, setIsHovered] = useState(false)
  // Get openFile from context (subscribed once at parent ArtifactTree level)
  const openFile = useContext(OpenFileContext)
  // Get lazy loading context
  const lazyLoad = useContext(LazyLoadContext)
  const data = node.data
  const isFolder = data.isFolder
  const isLoading = lazyLoad?.loadingPaths.has(data.path) ?? false
  const dimmed = isDimmed(data.name)  // Check if this item should be dimmed

  // Check if this file can be viewed in the canvas
  const canViewInCanvas = !isFolder && canOpenInCanvas(data.extension)

  // Handle folder toggle with lazy loading
  const handleToggle = useCallback(async () => {
    if (!isFolder) return

    // If opening and children not loaded, trigger lazy load
    if (!node.isOpen && !data.childrenLoaded && lazyLoad) {
      // Load children first, then toggle open
      await lazyLoad.loadChildren(data.path)
    }

    node.toggle()
  }, [isFolder, node, data.childrenLoaded, data.path, lazyLoad])

  // Handle click - open in canvas, system app, or download
  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isFolder) {
      handleToggle()
      return
    }

    // Try to open in Canvas first for viewable files
    if (canViewInCanvas && openFile) {
      openFile(data.path, data.name)
      return
    }

    // Fallback behavior for non-viewable files
    if (isWebMode) {
      // In web mode, trigger download
      api.downloadArtifact(data.path)
    } else {
      // In desktop mode, open with system app
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

  // Handle right-click - show in folder (desktop only)
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
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`
        flex items-center h-full pr-2 cursor-pointer select-none
        transition-colors duration-75
        ${node.isSelected ? 'bg-primary/15' : ''}
        ${isHovered && !node.isSelected ? 'bg-secondary/60' : ''}
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

      {/* Action indicator */}
      {!isFolder && isHovered && (
        canViewInCanvas ? (
          <Eye className="w-3 h-3 text-primary flex-shrink-0 ml-1" />
        ) : isWebMode ? (
          <Download className="w-3 h-3 text-primary flex-shrink-0 ml-1" />
        ) : null
      )}
    </div>
  )
}
