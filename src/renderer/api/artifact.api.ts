/**
 * artifactApi — artifact domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  getAuthToken,
  getRemoteServerUrl,
  httpRequest,
  isElectron,
  onEvent,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'
import { MAX_PREVIEW_DOCUMENT_SIZE, formatPreviewSize } from '../../shared/constants/artifact-preview'

export const artifactApi = {
  // ===== Artifact =====
  listArtifacts: async (spaceId: string, maxDepth: number = 2): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.listArtifacts(spaceId, maxDepth)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}/artifacts?maxDepth=${maxDepth}`)
  },

  listArtifactsTree: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.listArtifactsTree(spaceId)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}/artifacts/tree`)
  },

  // Load children for lazy tree expansion
  loadArtifactChildren: async (spaceId: string, dirPath: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.loadArtifactChildren(spaceId, dirPath)
    }
    return httpRequest('POST', `/api/spaces/${spaceId}/artifacts/children`, { dirPath })
  },

  // Initialize file watcher for a space
  initArtifactWatcher: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.initArtifactWatcher(spaceId)
    }
    // In remote mode, watcher is managed by server
    return { success: true }
  },

  // Subscribe to artifact change events
  onArtifactChanged: (callback: (data: {
    type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
    path: string
    relativePath: string
    spaceId: string
    item?: unknown
  }) => void) => {
    if (isElectron()) {
      return window.halo.onArtifactChanged(callback)
    }
    // In remote mode, use WebSocket events
    return onEvent('artifact:changed', callback)
  },

  // Subscribe to tree update events (pre-computed data, zero IPC round-trips)
  onArtifactTreeUpdate: (callback: (data: {
    spaceId: string
    updatedDirs: Array<{ dirPath: string; children: unknown[] }>
    changes: Array<{
      type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
      path: string
      relativePath: string
      spaceId: string
      item?: unknown
    }>
  }) => void) => {
    if (isElectron()) {
      return window.halo.onArtifactTreeUpdate(callback)
    }
    // In remote mode, use WebSocket events
    return onEvent('artifact:tree-update', callback)
  },

  // Reconcile artifact cache against filesystem (push + pull recovery)
  reconcileArtifacts: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.reconcileArtifacts(spaceId)
    }
    return httpRequest('POST', `/api/spaces/${spaceId}/artifacts/reconcile`)
  },

  openArtifact: async (filePath: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.openArtifact(filePath)
    }
    // Can't open files remotely
    return { success: false, error: 'Cannot open files in remote mode' }
  },

  showArtifactInFolder: async (filePath: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.showArtifactInFolder(filePath)
    }
    // Can't open folder remotely
    return { success: false, error: 'Cannot open folder in remote mode' }
  },

  // Download artifact (remote mode only - triggers browser download)
  downloadArtifact: (filePath: string): void => {
    if (isElectron()) {
      // In Electron, just open the file
      window.halo.openArtifact(filePath)
      return
    }
    // In remote mode, trigger download via browser with token in URL
    const token = getAuthToken()
    const url = `/api/artifacts/download?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token || '')}`
    const link = document.createElement('a')
    link.href = url
    link.download = filePath.split('/').pop() || 'download'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  },

  // Get download URL for an artifact (for use with fetch or direct links)
  getArtifactDownloadUrl: (filePath: string): string => {
    const token = getAuthToken()
    return `/api/artifacts/download?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token || '')}`
  },

  // Read artifact content for Content Canvas
  readArtifactContent: async (filePath: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.readArtifactContent(filePath)
    }
    // In remote mode, fetch content via API
    return httpRequest('GET', `/api/artifacts/content?path=${encodeURIComponent(filePath)}`)
  },

  /**
   * Read a document as raw bytes for the Canvas office/PDF viewers.
   *
   * Both transports are native end to end — IPC structured clone on desktop,
   * the browser's own decoder on the download route in remote mode — so no
   * base64 string is ever built and the main thread never runs a decode loop.
   *
   * The remote half enforces MAX_PREVIEW_DOCUMENT_SIZE here rather than at the
   * route: /api/artifacts/download exists to serve files of any size, so the
   * preview caller is the only place the preview's own ceiling belongs.
   */
  readArtifactBytes: async (filePath: string): Promise<ApiResponse<Uint8Array>> => {
    if (isElectron()) {
      const response = await window.halo.readArtifactBytes(filePath)
      if (!response.success || !response.data) {
        return { success: false, error: response.error || 'Failed to read file' }
      }
      return { success: true, data: response.data }
    }
    const baseUrl = getRemoteServerUrl()
    if (!baseUrl) {
      return { success: false, error: 'Server URL not configured' }
    }
    const token = getAuthToken()
    const tooLarge = (size?: number): ApiResponse<Uint8Array> => ({
      success: false,
      error: size === undefined
        ? `File too large to preview (limit ${formatPreviewSize(MAX_PREVIEW_DOCUMENT_SIZE)})`
        : `File too large to preview: ${formatPreviewSize(size)} ` +
          `(limit ${formatPreviewSize(MAX_PREVIEW_DOCUMENT_SIZE)})`,
    })

    try {
      const res = await fetch(`${baseUrl}/api/artifacts/download?path=${encodeURIComponent(filePath)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!res.ok) {
        // Failures come back as the standard JSON envelope, not file bytes.
        const detail = await res.json().catch(() => null)
        return { success: false, error: detail?.error || `Failed to read file (${res.status})` }
      }

      // Our route sets Content-Length, so an oversized file is normally rejected
      // before a single byte moves.
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_PREVIEW_DOCUMENT_SIZE) {
        return tooLarge(declared)
      }

      // A proxy that re-encodes the response drops Content-Length, so the limit
      // cannot rely on it: read incrementally and abort once the budget is gone.
      // arrayBuffer() would have to buffer the whole body first, which is the
      // thing the limit exists to prevent.
      if (!res.body) return { success: true, data: new Uint8Array(await res.arrayBuffer()) }
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > MAX_PREVIEW_DOCUMENT_SIZE) {
          await reader.cancel()
          return tooLarge(Number.isFinite(declared) && declared > 0 ? declared : undefined)
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(received)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return { success: true, data: bytes }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  },

  // Save artifact content (CodeViewer edit mode)
  saveArtifactContent: async (filePath: string, content: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.saveArtifactContent(filePath, content)
    }
    // In remote mode, save content via API
    return httpRequest('POST', '/api/artifacts/save', { path: filePath, content })
  },

  detectFileType: async (filePath: string): Promise<ApiResponse<{
    isText: boolean
    canViewInCanvas: boolean
    contentType: 'code' | 'markdown' | 'html' | 'image' | 'pdf' | 'text' | 'json' | 'csv' | 'xlsx' | 'docx' | 'pptx' | 'binary'
    language?: string
    mimeType: string
  }>> => {
    if (isElectron()) {
      return window.halo.detectFileType(filePath)
    }
    // In remote mode, detect file type via API
    return httpRequest('GET', `/api/artifacts/detect-type?path=${encodeURIComponent(filePath)}`)
  },

  // ===== File Operations =====
  // Create and move send (parentPath, name) — backend constructs full path via path.join.
  // Responses include { data: { path } } with the resolved absolute path.

  // Create file
  createArtifactFile: async (spaceId: string, parentPath: string, name: string, content: string = ''): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.createArtifactFile(spaceId, parentPath, name, content)
    }
    return httpRequest('POST', `/api/spaces/${spaceId}/artifacts/file`, { parentPath, name, content })
  },

  // Create folder
  createArtifactFolder: async (spaceId: string, parentPath: string, name: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.createArtifactFolder(spaceId, parentPath, name)
    }
    return httpRequest('POST', `/api/spaces/${spaceId}/artifacts/folder`, { parentPath, name })
  },

  // Delete file or folder
  deleteArtifact: async (spaceId: string, targetPath: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.deleteArtifact(spaceId, targetPath)
    }
    return httpRequest('DELETE', `/api/spaces/${spaceId}/artifacts`, { path: targetPath })
  },

  // Rename file or folder
  renameArtifact: async (spaceId: string, oldPath: string, newName: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.renameArtifact(spaceId, oldPath, newName)
    }
    return httpRequest('POST', `/api/spaces/${spaceId}/artifacts/rename`, { oldPath, newName })
  },

  // Move file or folder — sends (oldPath, newParentPath), backend constructs destination
  moveArtifact: async (spaceId: string, oldPath: string, newParentPath: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.moveArtifact(spaceId, oldPath, newParentPath)
    }
    return httpRequest('POST', `/api/spaces/${spaceId}/artifacts/move`, { oldPath, newParentPath })
  },

}
