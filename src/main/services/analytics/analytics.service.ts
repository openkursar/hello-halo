/**
 * Analytics Service - Core Service
 *
 * Core service for analytics module, responsible for:
 * 1. Managing multiple providers (Baidu Analytics, GA4)
 * 2. Unified event tracking interface
 * 3. User ID management
 * 4. Lifecycle event handling (install, launch, update)
 */

import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { v4 as uuidv4 } from 'uuid'
import type {
  AnalyticsEvent,
  AnalyticsEventName,
  AnalyticsProvider,
  UserContext,
  AnalyticsConfig
} from './types'
import { AnalyticsEvents } from './types'
import { createGAProvider } from './providers/ga'
import { createBaiduProvider } from './providers/baidu'
import { getConfig, saveConfig } from '../config.service'

/**
 * Build-time injected analytics credentials
 * These are defined in electron.vite.config.ts and loaded from .env.local
 * In open-source builds without .env.local, these will be empty strings
 */
declare const __HALO_GA_MEASUREMENT_ID__: string
declare const __HALO_GA_API_SECRET__: string
declare const __HALO_BAIDU_SITE_ID__: string

/**
 * Provider configuration (injected at build time)
 * When credentials are empty, the provider will be disabled
 */
const PROVIDER_CONFIG = {
  baidu: {
    siteId: __HALO_BAIDU_SITE_ID__
  },
  ga: {
    measurementId: __HALO_GA_MEASUREMENT_ID__,
    apiSecret: __HALO_GA_API_SECRET__
  }
}

/**
 * Analytics Service class (singleton)
 */
class AnalyticsService {
  private static instance: AnalyticsService | null = null

  private providers: AnalyticsProvider[] = []
  private userContext: UserContext | null = null
  private config: AnalyticsConfig | null = null
  private _initialized = false

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): AnalyticsService {
    if (!AnalyticsService.instance) {
      AnalyticsService.instance = new AnalyticsService()
    }
    return AnalyticsService.instance
  }

  /**
   * Whether the service is initialized
   */
  get initialized(): boolean {
    return this._initialized
  }

  /**
   * Initialize Analytics service
   * Should be called after app.whenReady()
   */
  async init(): Promise<void> {
    // Skip analytics in development mode
    if (is.dev) {
      console.log('[Analytics] Skipping in development mode')
      return
    }

    if (this._initialized) {
      console.log('[Analytics] Already initialized')
      return
    }

    console.log('[Analytics] Initializing...')

    // Load or create config
    this.config = this.loadOrCreateConfig()

    // Build user context
    this.userContext = this.buildUserContext()

    // Initialize providers
    await this.initProviders()

    this._initialized = true
    console.log('[Analytics] Initialized successfully')

    // Handle lifecycle events
    await this.handleLifecycleEvents()
  }

  /**
   * Track an event
   * @param eventName Event name (use AnalyticsEvents constants)
   * @param properties Event properties (optional)
   */
  async track(
    eventName: AnalyticsEventName | string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    if (!this._initialized || !this.userContext) {
      console.warn('[Analytics] Not initialized, event dropped:', eventName)
      return
    }

    const event: AnalyticsEvent = {
      name: eventName,
      properties,
      timestamp: Date.now()
    }

    console.log(`[Analytics] Tracking: ${eventName}`, properties || '')

    // Track to all providers in parallel (isolated from each other)
    await Promise.allSettled(
      this.providers.map(provider =>
        provider.track(event, this.userContext!)
      )
    )
  }

  /**
   * Load or create Analytics config
   */
  private loadOrCreateConfig(): AnalyticsConfig {
    const config = getConfig()
    const currentVersion = app.getVersion()

    // Create new config if not exists
    if (!config.analytics) {
      const newAnalyticsConfig: AnalyticsConfig = {
        userId: uuidv4(),
        lastVersion: currentVersion
      }

      // Save to config file
      saveConfig({ analytics: newAnalyticsConfig })

      console.log('[Analytics] Created new config with userId:', newAnalyticsConfig.userId.slice(0, 8) + '...')
      return newAnalyticsConfig
    }

    return config.analytics
  }

  /**
   * Build user context
   */
  private buildUserContext(): UserContext {
    return {
      userId: this.config!.userId,
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron
    }
  }

  /**
   * Initialize all providers
   */
  private async initProviders(): Promise<void> {
    const userId = this.config!.userId

    // Create and initialize providers
    // Each provider is isolated - one failing won't affect others

    // Baidu Analytics provider (for China)
    try {
      const baiduProvider = createBaiduProvider(PROVIDER_CONFIG.baidu.siteId)
      await baiduProvider.init(userId)
      if (baiduProvider.initialized) {
        this.providers.push(baiduProvider)
      }
    } catch (error) {
      console.warn('[Analytics] Baidu provider init failed:', error)
    }

    // GA4 provider (for international)
    try {
      const gaProvider = createGAProvider(
        PROVIDER_CONFIG.ga.measurementId,
        PROVIDER_CONFIG.ga.apiSecret
      )
      await gaProvider.init(userId)
      if (gaProvider.initialized) {
        this.providers.push(gaProvider)
      }
    } catch (error) {
      console.warn('[Analytics] GA4 provider init failed:', error)
    }

    console.log(`[Analytics] ${this.providers.length} provider(s) active:`,
      this.providers.map(p => p.name).join(', ') || 'none'
    )
  }

  /**
   * Handle lifecycle events
   */
  private async handleLifecycleEvents(): Promise<void> {
    const config = getConfig()
    const currentVersion = app.getVersion()
    const lastVersion = this.config!.lastVersion

    // Detect first install
    if (config.isFirstLaunch) {
      await this.track(AnalyticsEvents.APP_INSTALL)
    }
    // Detect version update
    else if (lastVersion && lastVersion !== currentVersion) {
      await this.track(AnalyticsEvents.APP_UPDATE, {
        from_version: lastVersion,
        to_version: currentVersion
      })
    }

    // Track app launch
    await this.track(AnalyticsEvents.APP_LAUNCH)

    // Update lastVersion
    if (lastVersion !== currentVersion) {
      saveConfig({
        analytics: {
          ...this.config!,
          lastVersion: currentVersion
        }
      })
    }
  }

  /**
   * Get user ID (for future account binding)
   */
  getUserId(): string | null {
    return this.config?.userId || null
  }

  /**
   * Get Baidu Analytics site ID (for renderer process SDK initialization)
   */
  getBaiduSiteId(): string {
    return PROVIDER_CONFIG.baidu.siteId
  }
}

// Export singleton
export const analytics = AnalyticsService.getInstance()

// Export init method (called from main/index.ts)
export async function initAnalytics(): Promise<void> {
  await analytics.init()
}

// Export convenience method
export async function trackEvent(
  eventName: AnalyticsEventName | string,
  properties?: Record<string, unknown>
): Promise<void> {
  await analytics.track(eventName, properties)
}
