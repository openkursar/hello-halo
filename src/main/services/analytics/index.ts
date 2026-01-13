/**
 * Analytics Module - Entry Point
 *
 * Unified export for analytics module
 *
 * Usage:
 * ```typescript
 * import { initAnalytics, analytics, AnalyticsEvents } from './services/analytics'
 *
 * // Initialize (call once after app.whenReady())
 * await initAnalytics()
 *
 * // Track events
 * analytics.track(AnalyticsEvents.APP_LAUNCH)
 * analytics.track('custom_event', { key: 'value' })
 * ```
 */

// Core service
export { analytics, initAnalytics, trackEvent } from './analytics.service'

// Type definitions
export {
  AnalyticsEvents,
  type AnalyticsEvent,
  type AnalyticsEventName,
  type AnalyticsConfig,
  type AnalyticsProvider,
  type UserContext
} from './types'

// Providers (usually not needed directly)
export { GAProvider, createGAProvider } from './providers/ga'
export { BaiduProvider, createBaiduProvider } from './providers/baidu'
export { BaseProvider } from './providers/base'
