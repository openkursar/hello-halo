import { ipcRenderer } from 'electron'
import type { BrowserHostBridge, BrowserHostCommand } from '../shared/types/browser-host'

export const browserHostBridge: BrowserHostBridge = {
  browserHostReady: () => ipcRenderer.invoke('browser:host-ready'),
  browserHostFailed: failure => ipcRenderer.send('browser:host-failed', failure),
  browserHostFrameReady: ready => ipcRenderer.send('browser:host-frame-ready', ready),
  onBrowserHostCommand: callback => {
    const listener = (_event: Electron.IpcRendererEvent, command: BrowserHostCommand) => callback(command)
    ipcRenderer.on('browser:host-command', listener)
    return () => ipcRenderer.removeListener('browser:host-command', listener)
  },
}
