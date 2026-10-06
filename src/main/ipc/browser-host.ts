import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { browserHostManager } from '../services/browser-host'
import type { BrowserHostFailure, BrowserHostFrameReady } from '../../shared/types/browser-host'

let registered = false

function assertHostFrame(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Browser host requires its main frame')
  }
}

/** Registers the minimal attachment bridge before the host's first navigation. */
export function registerBrowserHostHandlers(window?: BrowserWindow): void {
  if (window) browserHostManager.initialize(window)
  if (registered) return
  registered = true
  ipcMain.handle('browser:host-ready', event => {
    try {
      assertHostFrame(event)
    } catch (error) {
      console.warn('[BrowserHost IPC] Rejected readiness request', { senderId: event.sender.id }, error)
      throw error
    }
    return browserHostManager.ready(event.sender)
  })
  ipcMain.on('browser:host-failed', (event, failure: BrowserHostFailure) => {
    try {
      assertHostFrame(event)
      if (!failure || typeof failure.id !== 'string' || typeof failure.token !== 'string' || typeof failure.error !== 'string') {
        console.warn('[BrowserHost IPC] Rejected malformed failure report', { senderId: event.sender.id })
        return
      }
      browserHostManager.failed(event.sender, failure)
    } catch (error) {
      console.warn('[BrowserHost IPC] Rejected failure report', { senderId: event.sender.id }, error)
    }
  })
  ipcMain.on('browser:host-frame-ready', (event, ready: BrowserHostFrameReady) => {
    try {
      assertHostFrame(event)
      if (!ready || typeof ready.id !== 'string' || typeof ready.token !== 'string' || typeof ready.frameLeaseId !== 'string') {
        console.warn('[BrowserHost IPC] Rejected malformed frame acknowledgement', { senderId: event.sender.id })
        return
      }
      browserHostManager.framesReady(event.sender, ready)
    } catch (error) {
      console.warn('[BrowserHost IPC] Rejected frame acknowledgement', { senderId: event.sender.id }, error)
    }
  })
}
