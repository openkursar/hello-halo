/**
 * Performance Monitoring Module
 *
 * Developer tool for diagnosing performance issues in Halo.
 *
 * Usage in main process:
 *   import { perfService } from './services/perf'
 *   perfService.start()
 *
 * To track IPC calls, wrap handlers:
 *   import { wrapIpcHandler } from './services/perf'
 *   ipcMain.handle('channel', wrapIpcHandler('channel', handler))
 */

export { perfService } from './perf.service'
export * from './types'

// ============================================
// IPC Handler Wrapper
// ============================================

import { perfService } from './perf.service'

/**
 * Wrap an IPC handler to track performance
 *
 * @example
 * ipcMain.handle('my-channel', wrapIpcHandler('my-channel', async (event, data) => {
 *   // handler logic
 * }))
 */
export function wrapIpcHandler<T extends (...args: any[]) => any>(
  channelName: string,
  handler: T
): T {
  return (async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    const start = performance.now()

    try {
      const result = await handler(...args)
      const duration = performance.now() - start

      perfService.markIpcCall(duration)

      if (duration > 100) {
        console.warn(`[Perf] Slow IPC: ${channelName} took ${duration.toFixed(1)}ms`)
      }

      return result
    } catch (error) {
      perfService.markIpcCall(performance.now() - start)
      throw error
    }
  }) as T
}
