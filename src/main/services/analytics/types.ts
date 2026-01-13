/**
 * Analytics Module - Type Definitions
 */

/**
 * Predefined analytics events
 * Keep it minimal - only track core metrics
 */
export const AnalyticsEvents = {
  // Lifecycle events
  APP_INSTALL: 'app_install',     // First install (first launch)
  APP_LAUNCH: 'app_launch',       // App launch
  APP_UPDATE: 'app_update',       // Version update
} as const

export type AnalyticsEventName = typeof AnalyticsEvents[keyof typeof AnalyticsEvents]

/**
 * Analytics event structure
 */
export interface AnalyticsEvent {
  /** Event name */
  name: string
  /** Event properties (optional) */
  properties?: Record<string, unknown>
  /** Event timestamp */
  timestamp?: number
}

/**
 * User context information
 * Basic info sent with every event
 */
export interface UserContext {
  /** User unique ID (UUID, persisted) */
  userId: string
  /** App version */
  appVersion: string
  /** Operating system platform */
  platform: NodeJS.Platform
  /** System architecture */
  arch: string
  /** Electron version */
  electronVersion: string
}

/**
 * Analytics config (stored in config.json)
 */
export interface AnalyticsConfig {
  /** User unique ID (generated on first launch) */
  userId: string
  /** Last launched version (for detecting updates) */
  lastVersion: string
}

/**
 * Provider config
 */
export interface ProviderConfig {
  baidu: {
    siteId: string
  }
  ga: {
    measurementId: string
    apiSecret: string
  }
}

/**
 * Analytics Provider interface
 * All analytics platforms (Baidu, GA, etc.) must implement this interface
 */
export interface AnalyticsProvider {
  /** Provider name (for logging) */
  readonly name: string

  /** Whether initialized */
  readonly initialized: boolean

  /**
   * Initialize provider
   * @param userId User ID
   */
  init(userId: string): Promise<void>

  /**
   * Track event
   * @param event Event info
   * @param context User context
   */
  track(event: AnalyticsEvent, context: UserContext): Promise<void>
}
