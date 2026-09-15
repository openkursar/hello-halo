/**
 * Global type declarations for renderer process
 * Extends Window interface with Electron preload APIs
 */

import type { HaloAPI } from '../../preload'

declare global {
  interface Window {
    halo: HaloAPI
    platform: {
      platform: 'darwin' | 'win32' | 'linux'
      isMac: boolean
      isWindows: boolean
      isLinux: boolean
    }
  }
}

export {}
