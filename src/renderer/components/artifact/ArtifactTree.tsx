/**
 * ArtifactTree - Professional tree view using react-arborist
 * VSCode-style file explorer with keyboard navigation, virtual scrolling, and more
 */

import { useState, useCallback, useEffect, useMemo, createContext, useContext } from 'react'
import { Tree, NodeRendererProps } from 'react-arborist'
import { api } from '../../api'
import { useCanvasStore } from '../../stores/canvas.store'
import type { ArtifactTreeNode } from '../../types'
import { FileIcon } from '../icons/ToolIcons'
import { ChevronRight, ChevronDown, Download, Eye } from 'lucide-react'
import { useIsGenerating } from '../../stores/chat.store'
import { useTranslation } from '../../i18n'

// Context to pass openFile function to tree nodes without each node subscribing to store
// This prevents massive re-renders when canvas state changes
type OpenFileFn = (path: string, title?: string) => Promise<void>
const OpenFileContext = createContext<OpenFileFn | null>(null)

const isWebMode = api.isRemoteMode()

// File types that can be viewed in the Content Canvas
const CANVAS_VIEWABLE_EXTENSIONS = new Set([
  // Code
  'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'swift', 'kt', 'php', 'sh', 'bash', 'zsh', 'sql', 'yaml', 'yml', 'xml',
  'vue', 'svelte', 'css', 'scss', 'less',
  // Documents
  'md', 'markdown', 'txt', 'log', 'env', 'pdf',
  // Data
  'json', 'csv',
  // Web
  'html', 'htm',
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp',
])

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
}

function transformToArboristData(nodes: ArtifactTreeNode[]): TreeNodeData[] {
  return nodes.map(node => ({
    id: node.id,
    name: node.name,
    path: node.path,
    extension: node.extension,
    isFolder: node.type === 'folder',
    children: node.children ? transformToArboristData(node.children) : undefined
  }))
}

export function ArtifactTree({ spaceId }: ArtifactTreeProps) {
  const { t } = useTranslation()
  const [treeData, setTreeData] = useState<TreeNodeData[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const isGenerating = useIsGenerating()
  const treeHeight = useTreeHeight()

  // Subscribe to openFile once at parent level, pass down via context
  // This prevents each TreeNodeComponent from subscribing to the store
  const openFile = useCanvasStore(state => state.openFile)

  // Load tree data
  const loadTree = useCallback(async () => {
    if (!spaceId) return

    try {
      setIsLoading(true)
      const response = await api.listArtifactsTree(spaceId)
      if (response.success && response.data) {
        const transformed = transformToArboristData(response.data as ArtifactTreeNode[])
        setTreeData(transformed)
      }
    } catch (error) {
      console.error('[ArtifactTree] Failed to load tree:', error)
    } finally {
      setIsLoading(false)
    }
  }, [spaceId])

  // Load on mount and when space changes
  useEffect(() => {
    loadTree()
  }, [loadTree])

  // Refresh when generation completes
  useEffect(() => {
    if (!isGenerating) {
      const timer = setTimeout(loadTree, 500)
      return () => clearTimeout(timer)
    }
  }, [isGenerating, loadTree])

  // Count total items
  const itemCount = useMemo(() => {
    const count = (nodes: TreeNodeData[]): number => {
      return nodes.reduce((sum, node) => {
        return sum + 1 + (node.children ? count(node.children) : 0)
      }, 0)
    }
    return count(treeData)
  }, [treeData])

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-2">
        <div className="w-6 h-6 rounded-full border-2 border-primary/30 border-t-primary animate-spin mb-2" />
        <p className="text-xs text-muted-foreground">{t('Loading...')}</p>
      </div>
    )
  }

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
      <div className="flex flex-col h-full">
        {/* Header with count */}
        <div className="flex-shrink-0 bg-card/95 backdrop-blur-sm px-2 py-1.5 border-b border-border/50 text-[10px] text-muted-foreground uppercase tracking-wider">
          {t('Files')} ({itemCount})
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
  const data = node.data
  const isFolder = data.isFolder

  // Check if this file can be viewed in the canvas
  const canViewInCanvas = !isFolder && data.extension &&
    CANVAS_VIEWABLE_EXTENSIONS.has(data.extension.toLowerCase())

  // Handle click - open in canvas, system app, or download
  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isFolder) {
      node.toggle()
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
      {/* Expand/collapse arrow for folders */}
      <span
        className="w-4 h-4 flex items-center justify-center flex-shrink-0"
        onClick={(e) => {
          e.stopPropagation()
          if (isFolder) node.toggle()
        }}
      >
        {isFolder ? (
          node.isOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/70" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/70" />
          )
        ) : null}
      </span>

      {/* File/folder icon */}
      <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 mr-1.5">
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
        ${isFolder ? 'font-medium text-foreground/90' : 'text-foreground/80'}
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
