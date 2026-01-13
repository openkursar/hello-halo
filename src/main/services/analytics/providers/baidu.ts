/**
 * Analytics Provider - Baidu Analytics (Baidu Tongji)
 *
 * Baidu Analytics Provider implementation
 *
 * How it works:
 * Baidu Analytics Web SDK needs to run in the renderer process (browser environment).
 * This provider communicates with renderer via IPC, and renderer executes the actual tracking.
 *
 * Renderer process needs to:
 * 1. Load Baidu Analytics JS SDK: hm.js
 * 2. Expose window._hmt object
 * 3. Listen for tracking requests from main process
 *
 * Reference: https://tongji.baidu.com/
 */

import { BrowserWindow } from 'electron'
import { BaseProvider, BaseProviderOptions } from './base'
import type { AnalyticsEvent, UserContext } from '../types'

/**
 * Baidu Analytics Provider config
 */
export interface BaiduProviderConfig extends BaseProviderOptions {
  /** Baidu Analytics Site ID (from Baidu Analytics admin) */
  siteId: string
}

/**
 * Baidu Analytics Provider
 * Tracks via renderer process Web SDK
 */
export class BaiduProvider extends BaseProvider {
  readonly name = 'Baidu'

  private siteId: string

  constructor(config: BaiduProviderConfig) {
    super(config)
    this.siteId = config.siteId
  }

  /**
   * Initialize Baidu Analytics Provider
   */
  async init(userId: string): Promise<void> {
    await super.init(userId)

    if (!this.siteId || this.siteId === 'YOUR_BAIDU_SITE_ID') {
      this.log('Site ID not configured, provider disabled')
      this._initialized = false
      return
    }

    this.log('ready (will track via renderer process)')
  }

  /**
   * Track event to Baidu Analytics
   * Sends message to renderer process to call _hmt.push
   */
  async track(event: AnalyticsEvent, context: UserContext): Promise<void> {
    if (!this._initialized) {
      return
    }

    await this.safeTrack(async () => {
      // Get main window
      const windows = BrowserWindow.getAllWindows()
      const mainWindow = windows.find(w => !w.isDestroyed())

      if (!mainWindow) {
        this.log('No window available for tracking')
        return
      }

      // Build Baidu Analytics event params
      // _hmt.push(['_trackEvent', category, action, opt_label, opt_value])
      const trackData = {
        type: 'trackEvent',
        category: 'app',
        action: event.name,
        label: context.appVersion,
        value: event.timestamp || Date.now(),
        // Extra info (Baidu Analytics custom variables)
        customVars: {
          userId: this._userId,
          platform: context.platform,
          arch: context.arch,
          ...event.properties
        }
      }

      // Wait for renderer to load before sending
      const sendTrackData = () => {
        if (mainWindow.isDestroyed()) return
        mainWindow.webContents.send('analytics:track', trackData)
        this.log(`tracked: ${event.name}`)
      }

      // If page is loaded, send immediately; otherwise wait for did-finish-load
      if (mainWindow.webContents.isLoading()) {
        mainWindow.webContents.once('did-finish-load', sendTrackData)
      } else {
        // Small delay to ensure preload script has executed
        setTimeout(sendTrackData, 100)
      }
    })
  }

  /**
   * Get site ID (for renderer process SDK initialization)
   */
  getSiteId(): string {
    return this.siteId
  }
}

/**
 * Create Baidu Analytics Provider instance
 */
export function createBaiduProvider(siteId: string): BaiduProvider {
  return new BaiduProvider({
    siteId,
    debug: process.env.NODE_ENV === 'development'
  })
}
