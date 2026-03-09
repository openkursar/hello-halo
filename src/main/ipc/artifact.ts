/**
 * Artifact IPC Handlers - Handle artifact-related requests from renderer
 *
 * PERFORMANCE OPTIMIZED:
 * - Uses async functions for non-blocking I/O
 * - Supports lazy loading for tree view
 * - Provides incremental updates via file watcher events
 */

import { ipcMain, shell } from 'electron'
import {
  listArtifacts,
  listArtifactsTree,
  loadTreeChildren,
  initArtifactWatcher,
  readArtifactContent,
  saveArtifactContent,
  detectFileType
} from '../services/artifact.service'

// Register all artifact handlers
export function registerArtifactHandlers(): void {
  // List artifacts in a space (flat list for card view)
  ipcMain.handle('artifact:list', async (_event, spaceId: string, maxDepth?: number) => {
    try {
      const artifacts = await listArtifacts(spaceId, maxDepth)
      return { success: true, data: artifacts }
    } catch (error) {
      console.error('[IPC] artifact:list error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // List artifacts as tree structure (for developer view)
  ipcMain.handle('artifact:list-tree', async (_event, spaceId: string) => {
    try {
      const tree = await listArtifactsTree(spaceId)
      return { success: true, data: tree }
    } catch (error) {
      console.error('[IPC] artifact:list-tree error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Load children for lazy tree expansion
  ipcMain.handle('artifact:load-children', async (_event, spaceId: string, dirPath: string) => {
    try {
      console.log(`[IPC] artifact:load-children - spaceId: ${spaceId}, path: ${dirPath}`)
      const children = await loadTreeChildren(spaceId, dirPath)
      return { success: true, data: children }
    } catch (error) {
      console.error('[IPC] artifact:load-children error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Initialize file watcher for a space
  ipcMain.handle('artifact:init-watcher', async (_event, spaceId: string) => {
    try {
      console.log(`[IPC] artifact:init-watcher - spaceId: ${spaceId}`)
      await initArtifactWatcher(spaceId)
      return { success: true }
    } catch (error) {
      console.error('[IPC] artifact:init-watcher error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Open file or folder with system default application
  ipcMain.handle('artifact:open', async (_event, filePath: string) => {
    try {
      console.log(`[IPC] artifact:open - path: ${filePath}`)
      // shell.openPath opens file with default app, or folder with file manager
      const error = await shell.openPath(filePath)
      if (error) {
        console.error('[IPC] artifact:open error:', error)
        return { success: false, error }
      }
      return { success: true }
    } catch (error) {
      console.error('[IPC] artifact:open error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Show file in folder (highlight in file manager)
  ipcMain.handle('artifact:show-in-folder', async (_event, filePath: string) => {
    try {
      console.log(`[IPC] artifact:show-in-folder - path: ${filePath}`)
      // shell.showItemInFolder opens the folder and selects the file
      shell.showItemInFolder(filePath)
      return { success: true }
    } catch (error) {
      console.error('[IPC] artifact:show-in-folder error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Read file content for Content Canvas
  ipcMain.handle('artifact:read-content', async (_event, filePath: string) => {
    try {
      console.log(`[IPC] artifact:read-content - path: ${filePath}`)
      const content = readArtifactContent(filePath)
      return { success: true, data: content }
    } catch (error) {
      console.error('[IPC] artifact:read-content error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Save file content from Content Canvas (edit mode)
  ipcMain.handle('artifact:save-content', async (_event, filePath: string, content: string) => {
    try {
      console.log(`[IPC] artifact:save-content - path: ${filePath}`)
      saveArtifactContent(filePath, content)
      return { success: true }
    } catch (error) {
      console.error('[IPC] artifact:save-content error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Detect file type for Canvas viewability
  // Used by renderer to determine if unknown file types can be opened in Canvas
  ipcMain.handle('artifact:detect-file-type', async (_event, filePath: string) => {
    try {
      console.log(`[IPC] artifact:detect-file-type - path: ${filePath}`)
      const fileTypeInfo = detectFileType(filePath)
      return { success: true, data: fileTypeInfo }
    } catch (error) {
      console.error('[IPC] artifact:detect-file-type error:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}
