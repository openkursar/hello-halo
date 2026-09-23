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
import { Tree, NodeRendererProps, TreeApi, CreateHandler, RenameHandler, DeleteHandler, MoveHandler, NodeApi } from 'react-arborist'
import { api } from '../../api'
import { useCanvasStore } from '../../stores/canvas.store'
import { useConversationTouchedFiles, type TouchedFileStatus } from '../../hooks/useConversationTouchedFiles'
import type { ArtifactTreeNode, ArtifactTreeUpdateEvent } from '../../types'
import { FileIcon } from '../icons/ToolIcons'
import { ChevronRight, ChevronDown, Download, Eye, Loader2, FilePlus, FolderPlus, Edit3, Trash2, FolderOpen, Copy, RefreshCw } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { canOpenInCanvas, isDocumentExtension } from '../../constants/file-types'
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { useNotificationStore } from '../../stores/notification.store'
import { useFileOperations } from '../../hooks/useFileOperations'
import { copyToClipboard } from '../../utils/clipboard'

// Context to pass openFile function to tree nodes without each node subscribing to store
type OpenFileFn = (path: string, title?: string) => Promise<void>
const OpenFileContext = createContext<OpenFileFn | null>(null)

/** File path → whether the AI created (`Write`) or only edited (`Edit`) it in
 * the currently active conversation (see useConversationTouchedFiles).
 * Passed via context (not per-node store reads) for the same reason as
 * `OpenFileContext`: avoid every virtualized row subscribing individually. */
const TouchedFilesContext = createContext<Map<string, TouchedFileStatus> | null>(null)

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
// 180px accounts for: header (60px) + toolbar (40px) + padding/margins (80px)
const TREE_HEIGHT_OFFSET = 180

// Row height for virtual scrolling (in pixels)
// Matches the prototype's `.tree-item{padding:5px 8px}` with inherited 1.55
// line-height at the 12px `.rail-body` font size: 5 + 12*1.55 + 5 ≈ 29px.
const TREE_ROW_HEIGHT = 29

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
  index: Map<string, ArtifactTreeNode>,
  recentlyCreatedPaths?: Map<string, number>
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
  const treeRef = useRef<TreeApi<ArtifactTreeNode>>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { showConfirm, DialogComponent } = useConfirmDialog()
  
  // Workspace root — authoritative absolute path from backend, used for path construction
  const workspaceRootRef = useRef<string>('')

  // File operations hook
  const {
    createNewArtifact,
    renameExistingArtifact,
    deleteArtifact,
    moveArtifact,
    recentlyCreatedPaths,
    cleanup: cleanupFileOperations
  } = useFileOperations({ spaceId, workspaceRootRef })

  const touchedFiles = useConversationTouchedFiles()

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
      const response = await api.listArtifactsTree(spaceId)
      if (response.success && response.data) {
        const { workspaceRoot, nodes } = response.data as { workspaceRoot: string; nodes: ArtifactTreeNode[] }
        workspaceRootRef.current = workspaceRoot
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

  // onCreate - Create temporary node
  const handleCreate: CreateHandler<ArtifactTreeNode> = useCallback(async (args) => {
    const { parentNode, index, type } = args
    // Create a temporary node — real file is created in handleRename on submit
    const tempId = `temp-${Date.now()}`
    const parentPath = parentNode?.data.path || workspaceRootRef.current

    const tempNode: ArtifactTreeNode = {
      id: tempId,
      name: '',
      path: parentPath ? `${parentPath}/${tempId}` : tempId,
      relativePath: tempId,
      type: type === 'leaf' ? 'file' : 'folder',
      extension: '',
      icon: type === 'leaf' ? 'file' : 'folder',
      depth: 0,
      children: type === 'internal' ? [] : undefined,
      childrenLoaded: type === 'internal' ? true : false
    }

    // Mutate tree in place then bump revision — avoids deep cloning the full tree.
    // react-arborist virtual scrolling means only ~20-30 visible nodes re-render.
    if (parentNode) {
      if (!parentNode.data.children) {
        parentNode.data.children = []
      }
      parentNode.data.children.splice(index, 0, tempNode)
      parentNode.data.childrenLoaded = true
    } else {
      treeDataRef.current.splice(index, 0, tempNode)
    }

    nodeIndex.current.set(tempNode.path, tempNode)
    setRevision(r => r + 1)

    // Select the temp node once the tree has re-rendered
    requestAnimationFrame(() => {
      const tree = treeRef.current
      if (tree) {
        const newNode = tree.get(tempId)
        if (newNode) {
          // Only select, don't focus - editing mode will handle the input focus
          newNode.select()
        }
      }
    })
    
    return tempNode
  }, [])

  // onRename - Create real file or rename existing file
  const handleRename: RenameHandler<ArtifactTreeNode> = useCallback(async (args) => {
    const { id, name, node } = args
    const newName = name.trim()

    if (!newName) return

    // Check if this is a new file (temp ID) or rename
    const isCreating = id.toString().startsWith('temp-')

    if (isCreating) {
      const result = await createNewArtifact(node, newName)
      if (result.success && result.resolvedPath) {
        // Update node path and index with the real absolute path from backend.
        // This ensures that if the user immediately creates a child inside this node,
        // the parent path is correct (not a stale temp- placeholder).
        const oldPath = node.data.path
        node.data.path = result.resolvedPath
        nodeIndex.current.delete(oldPath)
        nodeIndex.current.set(result.resolvedPath, node.data)
      }
    } else {
      await renameExistingArtifact(node, newName)
    }

    // File watcher will automatically update tree
  }, [createNewArtifact, renameExistingArtifact])

  // onDelete - Delete file/folder with confirmation
  const handleDelete: DeleteHandler<ArtifactTreeNode> = useCallback(async (args) => {
    const { ids, nodes } = args
    const fileName = nodes[0].data.name
    const count = ids.length
    
    // Check if any nodes are temporary (being created)
    const hasTempNodes = nodes.some((n: NodeApi<ArtifactTreeNode>) => n.id.toString().startsWith('temp-'))
    
    if (hasTempNodes) {
      // Cancel in-progress creation — remove temp nodes, no confirmation needed
      for (const node of nodes) {
        const isRootNode = !node.parent || node.parent.id === '__REACT_ARBORIST_INTERNAL_ROOT__'
        
        if (isRootNode) {
          // Remove from root
          const index = treeDataRef.current.findIndex(n => n.id === node.id)
          if (index !== -1) {
            treeDataRef.current.splice(index, 1)
          }
        } else {
          // Remove from parent's children
          const parent = node.parent?.data
          if (parent?.children) {
            const index = parent.children.findIndex((c: ArtifactTreeNode) => c.id === node.id)
            if (index !== -1) {
              parent.children.splice(index, 1)
            }
          }
        }
        
        // Remove from index
        nodeIndex.current.delete(node.data.path)
      }
      
      // Trigger re-render
      setRevision(r => r + 1)
      return
    }
    
    // Show confirmation dialog for real files
    const confirmed = await showConfirm({
      title: count === 1
        ? t("Are you sure you want to delete '{{name}}'?", { name: fileName })
        : t('Are you sure you want to delete {{count}} items?', { count }),
      message: count === 1
        ? t('You can restore this file from the Trash.')
        : t('You can restore these files from the Trash.'),
      confirmLabel: t('Move to Trash'),
      cancelLabel: t('Cancel'),
      variant: 'danger'
    })
    
    if (!confirmed) return

    // Parallel delete — avoids sequential IPC round-trips for multi-file selections
    const results = await Promise.all(nodes.map(n => deleteArtifact(n.data.path)))
    const successCount = results.filter(Boolean).length
    const failCount = results.length - successCount
    
    // Show result notification
    if (successCount > 0) {
      useNotificationStore.getState().show({
        title: t('Deleted'),
        body: count === 1
          ? t("'{{name}}' moved to Trash", { name: fileName })
          : t('{{count}} items moved to Trash', { count: successCount }),
        variant: 'success',
        duration: 3000
      })
    }
    
    if (failCount > 0) {
      useNotificationStore.getState().show({
        title: t('Delete failed'),
        body: t('Failed to delete {{count}} items', { count: failCount }),
        variant: 'error',
        duration: 5000
      })
    }
    
    // File watcher will automatically update tree
  }, [spaceId, t, showConfirm, deleteArtifact])

  // onMove - Drag and drop move
  // Sends (oldPath, newParentPath) — backend constructs the destination path
  const handleMove: MoveHandler<ArtifactTreeNode> = useCallback(async (args) => {
    const { dragNodes, parentNode } = args
    const newParentPath = parentNode?.data.path || ''

    for (const node of dragNodes) {
      const oldPath = node.data.path

      // Prevent moving a folder into one of its own descendants
      if (newParentPath.startsWith(oldPath + '/') || newParentPath === oldPath) {
        useNotificationStore.getState().show({
          title: t('Move failed'),
          body: t('Cannot move a folder into itself'),
          variant: 'error',
          duration: 3000
        })
        continue
      }

      await moveArtifact(oldPath, newParentPath)
    }

    // File watcher will automatically update tree
  }, [t, moveArtifact])

  // Toolbar button handlers
  const handleNewFile = useCallback(() => {
    const focusedNode = treeRef.current?.focusedNode
    
    // Determine parent ID
    let parentId: string | null = null
    if (focusedNode) {
      if (focusedNode.data.type === 'folder') {
        // If folder is selected, create inside it
        parentId = focusedNode.id
        // Auto-expand folder
        if (!focusedNode.isOpen) {
          focusedNode.open()
        }
      } else {
        // If file is selected, create in parent folder
        parentId = focusedNode.parent?.id || null
      }
    }
    
    // Call tree.create()
    treeRef.current?.create({ type: 'leaf', parentId })
  }, [])

  const handleNewFolder = useCallback(() => {
    const focusedNode = treeRef.current?.focusedNode
    
    let parentId: string | null = null
    if (focusedNode) {
      if (focusedNode.data.type === 'folder') {
        parentId = focusedNode.id
        if (!focusedNode.isOpen) {
          focusedNode.open()
        }
      } else {
        parentId = focusedNode.parent?.id || null
      }
    }
    
    treeRef.current?.create({ type: 'internal', parentId })
  }, [])

  // Keyboard shortcuts — scoped to tree container to avoid conflicts with other inputs
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const tree = treeRef.current
      if (!tree) return

      // Skip if an input/textarea is focused (e.g. inline rename)
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return

      // F2 - Rename
      if (e.key === 'F2') {
        e.preventDefault()
        const focusedNode = tree.focusedNode
        if (focusedNode) {
          focusedNode.edit()
        }
      }

      // Delete / Backspace - Delete
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        const selectedNodes = tree.selectedNodes
        if (selectedNodes.length > 0) {
          tree.delete(selectedNodes.map(n => n.id))
        }
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Lazy load children for a folder — mutates ref in place, O(1) lookup
  const loadChildren = useCallback(async (dirPath: string): Promise<void> => {
    if (!spaceId) return

    try {
      setLoadingPaths(prev => new Set(prev).add(dirPath))
      const response = await api.loadArtifactChildren(spaceId, dirPath)

      if (response.success && response.data) {
        const children = response.data as ArtifactTreeNode[]
        const parent = nodeIndex.current.get(dirPath)
        if (parent) {
          parent.children = children
          parent.childrenLoaded = true
          indexNodes(children, nodeIndex.current)
          setRevision(r => r + 1)
        } else {
          console.warn('[ArtifactTree] loadChildren: parent not in index — path=%s', dirPath)
        }
      } else {
        console.warn('[ArtifactTree] loadChildren: empty response — path=%s', dirPath)
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
  const handleTreeUpdate = useCallback((data: {
    spaceId: string
    updatedDirs: Array<{ dirPath: string; children: unknown[] }>
    changes: Array<{
      type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
      path: string
      relativePath: string
      spaceId: string
      item?: unknown
    }>
  }) => {
    if (data.spaceId !== spaceId || data.updatedDirs.length === 0) return

    for (const { dirPath, children } of data.updatedDirs) {
      const incomingChildren = children as ArtifactTreeNode[]
      const parent = nodeIndex.current.get(dirPath)

      if (parent) {
        // Known expanded directory — O(1) lookup, merge children
        parent.children = mergeChildren(incomingChildren, parent.children || [], nodeIndex.current, recentlyCreatedPaths.current)
        parent.childrenLoaded = true
      } else {
        // Root-level update or initial load
        const isRoot = treeDataRef.current.length > 0 &&
          treeDataRef.current.some(n => getParentPath(n.path) === dirPath)
        if (isRoot || treeDataRef.current.length === 0) {
          treeDataRef.current = mergeChildren(incomingChildren, treeDataRef.current, nodeIndex.current, recentlyCreatedPaths.current)
        }
        // Else: untracked directory — loaded on first expand
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

  // Cleanup all pending timeouts on unmount
  useEffect(() => {
    return () => {
      cleanupFileOperations()
    }
  }, [cleanupFileOperations])

  // Auto-select recently created files after each revision commit.
  // useEffect runs after React commits the DOM, so react-arborist has already rendered
  // the new nodes — no requestAnimationFrame timing hack needed.
  useEffect(() => {
    if (recentlyCreatedPaths.current.size === 0) return
    const tree = treeRef.current
    if (!tree) return
    for (const path of Array.from(recentlyCreatedPaths.current.keys())) {
      const nodeData = nodeIndex.current.get(path)
      if (nodeData) {
        const node = tree.get(nodeData.id)
        if (node) {
          node.select()
          recentlyCreatedPaths.current.delete(path)
        }
      }
    }
  }, [revision])

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
      <TouchedFilesContext.Provider value={touchedFiles}>
      <LazyLoadContext.Provider value={lazyLoadValue}>
        <div ref={containerRef} tabIndex={-1} className="flex flex-col h-full outline-none">
          {/* Override react-arborist focus-visible styles */}
          <style>{`
            [role="treeitem"]:focus-visible {
              outline: none !important;
            }
          `}</style>
          
          {/* Header with toolbar */}
          <div className="flex-shrink-0 bg-card px-2 py-1.5 border-b border-border/50">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/80 [.light_&]:text-muted-foreground uppercase tracking-wider">
                {t('Files')}
              </span>
              <div className="flex gap-0.5">
                <button
                  onClick={handleNewFile}
                  className="w-7 h-7 flex items-center justify-center rounded-sm text-subtle-foreground transition-colors ease-halo hover:bg-secondary hover:text-foreground"
                  title={t('New File')}
                >
                  <FilePlus className="w-[15px] h-[15px]" strokeWidth={1.8} />
                </button>
                <button
                  onClick={handleNewFolder}
                  className="w-7 h-7 flex items-center justify-center rounded-sm text-subtle-foreground transition-colors ease-halo hover:bg-secondary hover:text-foreground"
                  title={t('New Folder')}
                >
                  <FolderPlus className="w-[15px] h-[15px]" strokeWidth={1.8} />
                </button>
                <button
                  onClick={() => { api.reconcileArtifacts(spaceId) }}
                  className="w-7 h-7 flex items-center justify-center rounded-sm text-subtle-foreground transition-colors ease-halo hover:bg-secondary hover:text-foreground"
                  title={t('Refresh file tree')}
                >
                  <RefreshCw className="w-[15px] h-[15px]" strokeWidth={1.8} />
                </button>
              </div>
            </div>
          </div>

          {/* Tree — uses window height based calculation. Horizontal inset (px-1.5)
              plus paddingTop/Bottom match the prototype's `.rail-body{padding:8px 6px}`. */}
          <div className="flex-1 overflow-hidden px-1.5">
            <Tree<ArtifactTreeNode>
              ref={treeRef}
              data={treeData}
              openByDefault={false}
              width="100%"
              height={treeHeight}
              indent={16}
              rowHeight={TREE_ROW_HEIGHT}
              overscanCount={5}
              paddingTop={8}
              paddingBottom={8}
              disableDrag={false}
              disableDrop={false}
              disableEdit={false}
              onCreate={handleCreate}
              onRename={handleRename}
              onDelete={handleDelete}
              onMove={handleMove}
            >
              {TreeNodeComponent}
            </Tree>
          </div>
        </div>
        
        {/* Confirmation dialog */}
        {DialogComponent}
      </LazyLoadContext.Provider>
      </TouchedFilesContext.Provider>
    </OpenFileContext.Provider>
  )
}

// ============================================
// Tree node renderer — CSS-only hover, no per-node state
// ============================================

// Editing state node component
function EditingNode({ node, style, dragHandle, tree }: NodeRendererProps<ArtifactTreeNode>) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [inputValue, setInputValue] = useState(node.data.name || '')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const data = node.data
  
  // Auto-focus and select text
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
      
      const value = inputRef.current.value
      if (value) {
        // Select text, but not including extension
        const dotIndex = value.lastIndexOf('.')
        if (dotIndex > 0 && !node.isLeaf) {
          // Folder: select all
          inputRef.current.select()
        } else if (dotIndex > 0) {
          // File: select up to extension
          inputRef.current.setSelectionRange(0, dotIndex)
        } else {
          // No extension: select all
          inputRef.current.select()
        }
      }
    }
  }, [node.isLeaf])
  
  // Check if name already exists in parent directory
  const checkNameExists = useCallback((name: string): boolean => {
    if (!name) return false
    
    const isCreating = node.id.toString().startsWith('temp-')
    
    const siblings: NodeApi<ArtifactTreeNode>[] =
      node.parent && node.parent.id !== '__REACT_ARBORIST_INTERNAL_ROOT__'
        ? node.parent.children || []
        : node.tree.root.children || []

    return siblings.some(sibling => {
      if (!sibling?.data) return false
      if (!isCreating && sibling.id === node.id) return false
      return sibling.data.name === name
    })
  }, [node])
  
  // Validate input value
  const validateInput = useCallback((value: string) => {
    const trimmed = value.trim()
    
    if (!trimmed) {
      setErrorMessage(null)
      return
    }
    
    // Check for invalid characters (platform-specific)
    const invalidChars = /[<>:"|?*\x00-\x1f]/
    if (invalidChars.test(trimmed)) {
      setErrorMessage(t('A file or folder name cannot contain any of the following characters: \\ / : * ? " < > |'))
      return
    }
    
    // Check for forward/backward slashes (path separators)
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      setErrorMessage(t('A file or folder name cannot contain any of the following characters: \\ / : * ? " < > |'))
      return
    }
    
    // Check for names that are only dots (., .., etc.)
    if (/^\.+$/.test(trimmed)) {
      setErrorMessage(t('A file or folder name cannot be "." or ".."'))
      return
    }
    
    // Windows-specific restrictions (only apply on Windows platform)
    const isWindows = window.platform?.isWindows ?? false
    if (isWindows) {
      // Check for trailing dots or spaces (Windows restriction)
      if (trimmed.endsWith('.') || trimmed.endsWith(' ')) {
        setErrorMessage(t('A file or folder name cannot end with a dot or space'))
        return
      }
      
      // Check for reserved names on Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
      const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
      const nameWithoutExt = trimmed.split('.')[0]
      if (reservedNames.test(nameWithoutExt)) {
        setErrorMessage(t('This name is reserved by the system. Please choose a different name.'))
        return
      }
    }
    
    // Check if name already exists
    if (checkNameExists(trimmed)) {
      setErrorMessage(t("A file or folder '{{name}}' already exists at this location. Please choose a different name.", { name: trimmed }))
      return
    }
    
    setErrorMessage(null)
  }, [checkNameExists, t])
  
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setInputValue(value)
    validateInput(value)
  }
  
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Check if this is a new node (temp ID)
    const isCreating = node.id.toString().startsWith('temp-')
    
    if (e.key === 'Enter') {
      e.preventDefault()
      const value = e.currentTarget.value.trim()
      
      // Don't submit if there's an error
      if (errorMessage) {
        return
      }
      
      if (value) {
        node.submit(value)
      } else {
        isCreating ? node.tree.delete(node.id) : node.reset()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      isCreating ? node.tree.delete(node.id) : node.reset()
    }
  }

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const value = e.currentTarget.value.trim()
    const isCreating = node.id.toString().startsWith('temp-')

    if (errorMessage) {
      isCreating ? node.tree.delete(node.id) : node.reset()
      return
    }

    if (value) {
      node.submit(value)
    } else {
      isCreating ? node.tree.delete(node.id) : node.reset()
    }
  }
  
  return (
    <div
      ref={dragHandle}
      style={style}
      className="flex flex-col pr-2 relative"
    >
      <div className="flex items-center h-[29px]">
        {/* Indent space */}
        <span className="w-4 h-4 flex-shrink-0" />
        
        {/* Icon */}
        <span className="w-4 h-4 flex-shrink-0 mr-1.5">
          <FileIcon 
            extension={data.extension} 
            isFolder={data.type === 'folder'}
            size={16} 
          />
        </span>
        
        {/* Input wrapper for error message alignment */}
        <div className="flex-1 relative">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            className={`w-full px-1 py-0.5 text-sm bg-background rounded focus:outline-none focus:ring-1 ${
              errorMessage
                ? 'border border-destructive focus:ring-destructive'
                : 'border border-primary focus:ring-primary'
            }`}
            spellCheck={false}
          />
          
          {/* Error message */}
          {errorMessage && (
            <div className="absolute top-full left-0 right-0 mt-0.5 z-50 px-2 py-1 text-[11px] text-destructive bg-destructive/10 rounded border border-destructive/20 shadow-md">
              {errorMessage}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TreeNodeComponent({ node, style, dragHandle }: NodeRendererProps<ArtifactTreeNode>) {
  const { t } = useTranslation()
  const openFile = useContext(OpenFileContext)
  const lazyLoad = useContext(LazyLoadContext)
  const touchedFiles = useContext(TouchedFilesContext)
  const data = node.data
  const isFolder = data.type === 'folder'
  const isLoading = lazyLoad?.loadingPaths.has(data.path) ?? false
  const dimmed = isDimmed(data.name)
  const canViewInCanvas = !isFolder && canOpenInCanvas(data.extension)
  const showDownload = isWebMode && !isFolder && isDocumentExtension(data.extension)
  const touchedStatus = !isFolder ? touchedFiles?.get(data.path) : undefined

  // Handle folder toggle with lazy loading (must be before early return)
  const handleToggle = useCallback(async () => {
    if (!isFolder) return
    if (!node.isOpen && !data.childrenLoaded && lazyLoad) {
      await lazyLoad.loadChildren(data.path)
    }
    node.toggle()
  }, [isFolder, node, data.childrenLoaded, data.path, lazyLoad])

  // Handle click — select node and open in canvas, system app, or download
  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    
    // Always select and focus the clicked node
    node.select()
    node.focus()
    
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
  }, [node, isFolder, handleToggle, canViewInCanvas, openFile, data.path, data.name])

  // Handle double-click to force open with system app
  const handleDoubleClickFile = useCallback(async (e: React.MouseEvent) => {
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
  }, [isFolder, node, data.path])

  // Check editing state (after all hooks)
  if (node.isEditing) {
    return <EditingNode node={node} style={style} dragHandle={dragHandle} tree={node.tree} />
  }

  // Generate context menu items
  const menuItems: ContextMenuItem[] = [
    // New File (only for folders)
    {
      label: t('New File'),
      icon: <FilePlus className="w-4 h-4" />,
      onClick: () => {
        if (!node.isOpen) node.open()
        node.tree.create({ type: 'leaf', parentId: node.id })
      },
      hidden: !isFolder
    },
    // New Folder (only for folders)
    {
      label: t('New Folder'),
      icon: <FolderPlus className="w-4 h-4" />,
      onClick: () => {
        if (!node.isOpen) node.open()
        node.tree.create({ type: 'internal', parentId: node.id })
      },
      hidden: !isFolder
    },
    // Separator (only for folders)
    {
      label: '',
      onClick: () => {},
      separator: true,
      hidden: !isFolder
    },
    // Rename
    {
      label: t('Rename'),
      icon: <Edit3 className="w-4 h-4" />,
      onClick: () => node.edit()
    },
    // Delete
    {
      label: t('Delete'),
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => node.tree.delete(node.id)
    },
    // Separator
    { label: '', onClick: () => {}, separator: true },
    // Copy relative path
    {
      label: t('Copy relative path'),
      icon: <Copy className="w-4 h-4" />,
      onClick: () => {
        copyToClipboard(data.relativePath).catch(err =>
          console.error('Failed to copy relative path:', err)
        )
      }
    },
    // Show in Folder (only for desktop mode)
    {
      label: t('Show in Folder'),
      icon: <FolderOpen className="w-4 h-4" />,
      onClick: async () => {
        try {
          await api.showArtifactInFolder(data.path)
        } catch (error) {
          console.error('Failed to show in folder:', error)
        }
      },
      hidden: isWebMode
    }
  ]

  return (
    <ContextMenu items={menuItems} className="h-full">
      <div
        ref={dragHandle}
        style={style}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/halo-artifact-relative-path', data.relativePath)
          e.dataTransfer.setData('text/plain', data.relativePath)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClickFile}
        className={`
          group flex items-center gap-[7px] h-full pr-2 rounded-[6px] cursor-pointer select-none
          transition-colors ease-halo
          ${node.isSelected ? 'bg-primary/[0.12] text-accent-on-dark' : 'hover:bg-secondary hover:text-foreground'}
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
            <ChevronDown className="w-3.5 h-3.5 text-subtle-foreground" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-subtle-foreground" />
          )
        ) : null}
      </span>

      {/* File/folder icon — prototype `.tree-item .ic{width:15px;color:var(--text-3)}`.
          Folders stay neutral gray (FileIcon's `text-muted-foreground`) rather
          than the prototype's amber: the icon repeats on every folder row, so
          color there reads as noise instead of information. */}
      <span className={`w-[15px] h-[15px] flex items-center justify-center flex-shrink-0 ${dimmed ? 'opacity-50' : ''}`}>
        <FileIcon
          extension={data.extension}
          isFolder={isFolder}
          isOpen={isFolder && node.isOpen}
          size={15}
        />
      </span>

      {/* File name — prototype inherits `.rail-body{font-size:12px}`; folders
          are `.dir{font-weight:500;color:var(--text)}`, files are the plainer
          `.tree-item{color:var(--text-2)}`. */}
      <span className={`
        text-xs truncate flex-1
        ${isFolder ? 'font-medium' : ''}
        ${node.isSelected
          ? 'text-accent-on-dark'
          : dimmed ? 'text-muted-foreground/50' : (isFolder ? 'text-foreground' : 'text-muted-foreground')}
      `}>
        {data.name}
      </span>

      {/* AI-touched badge — prototype `.tree-item .tag`, scoped to what the
          active conversation wrote/edited (see useConversationTouchedFiles),
          not git status. Always visible (unlike the hover-only icons below):
          it's state, not an action. */}
      {touchedStatus && (
        <span className={`text-[9px] leading-none px-[5px] py-0.5 rounded flex-shrink-0 ${
          touchedStatus === 'created'
            ? 'bg-halo-success/[0.14] text-halo-success'
            : 'bg-primary/[0.12] text-accent-on-dark'
        }`}>
          {touchedStatus === 'created' ? t('NEW') : t('MOD')}
        </span>
      )}

      {/* Action icons — CSS-only visibility via group-hover, zero JS overhead */}
      {!isFolder && canViewInCanvas && (
        <Eye className="w-3 h-3 text-primary flex-shrink-0 ml-1 opacity-0 group-hover:opacity-100 transition-opacity duration-75" />
      )}
      {!isFolder && !canViewInCanvas && isWebMode && (
        <Download className="w-3 h-3 text-primary flex-shrink-0 ml-1 opacity-0 group-hover:opacity-100 transition-opacity duration-75" />
      )}
      {/* Documents in web mode: a real download control next to the preview
          affordance. Always visible, since web mode includes touch clients with
          no hover to reveal it. */}
      {showDownload && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            api.downloadArtifact(data.path)
          }}
          className="p-0.5 rounded flex-shrink-0 ml-1 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          title={t('Download')}
        >
          <Download className="w-3 h-3" />
        </button>
      )}
    </div>
    </ContextMenu>
  )
}
