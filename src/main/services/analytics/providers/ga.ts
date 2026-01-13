/**
 * Analytics Provider - Google Analytics 4
 *
 * Uses GA4 Measurement Protocol for server-side tracking
 *
 * Reference:
 * - https://developers.google.com/analytics/devguides/collection/protocol/ga4
 * - https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events
 *
 * Prerequisites:
 * 1. Create a data stream in GA4 (select Web)
 * 2. Get Measurement ID (format: G-XXXXXXX)
 * 3. Create API Secret: Admin → Data Streams → Select stream → Measurement Protocol API secrets → Create
 */

import { BaseProvider, BaseProviderOptions } from './base'
import type { AnalyticsEvent, UserContext } from '../types'

/**
 * GA4 Provider config
 */
export interface GAProviderConfig extends BaseProviderOptions {
  /** Measurement ID (format: G-XXXXXXX) */
  measurementId: string
  /** API Secret (generated in GA4 admin) */
  apiSecret: string
}

/**
 * GA4 Measurement Protocol request body
 */
interface GA4Payload {
  client_id: string
  user_id?: string
  timestamp_micros?: string
  events: GA4Event[]
}

interface GA4Event {
  name: string
  params?: Record<string, string | number | boolean>
}

/**
 * Google Analytics 4 Provider
 * Uses Measurement Protocol for server-side event tracking
 */
export class GAProvider extends BaseProvider {
  readonly name = 'GA4'

  private measurementId: string
  private apiSecret: string

  // GA4 Measurement Protocol endpoint
  private readonly endpoint = 'https://www.google-analytics.com/mp/collect'
  // Debug endpoint (for validating request format)
  private readonly debugEndpoint = 'https://www.google-analytics.com/debug/mp/collect'

  constructor(config: GAProviderConfig) {
    super(config)
    this.measurementId = config.measurementId
    this.apiSecret = config.apiSecret
  }

  /**
   * Initialize GA4 Provider
   */
  async init(userId: string): Promise<void> {
    await super.init(userId)

    if (!this.measurementId || this.measurementId === 'G-XXXXXXXXXX') {
      this.log('Measurement ID not configured, provider disabled')
      this._initialized = false
      return
    }

    if (!this.apiSecret || this.apiSecret === 'YOUR_GA_API_SECRET') {
      this.log('API Secret not configured, provider disabled')
      this._initialized = false
      return
    }

    this.log('ready')
  }

  /**
   * Track event to GA4
   *
   * GA4 Measurement Protocol format:
   * POST https://www.google-analytics.com/mp/collect?measurement_id=G-XXX&api_secret=XXX
   * Body: { client_id, events: [{ name, params }] }
   */
  async track(event: AnalyticsEvent, context: UserContext): Promise<void> {
    if (!this._initialized) {
      return
    }

    await this.safeTrack(async () => {
      // Build GA4 event
      const ga4Event: GA4Event = {
        name: this.sanitizeEventName(event.name),
        params: {
          // Standard params
          engagement_time_msec: 1,  // Must be > 0 to appear in realtime reports
          // Custom params
          app_version: context.appVersion,
          platform: context.platform,
          arch: context.arch,
          electron_version: context.electronVersion,
          // Merge user-provided properties
          ...this.sanitizeParams(event.properties)
        }
      }

      // Build request body
      const payload: GA4Payload = {
        client_id: this._userId,
        // user_id is optional, for cross-device tracking (can be set after login)
        // user_id: this._userId,
        events: [ga4Event]
      }

      // Add timestamp if provided
      if (event.timestamp) {
        payload.timestamp_micros = (event.timestamp * 1000).toString()
      }

      // Build request URL
      const url = `${this.endpoint}?measurement_id=${this.measurementId}&api_secret=${this.apiSecret}`

      // Send request
      const response = await this.fetchWithRetry(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      // GA4 Measurement Protocol returns 2xx on success with empty body
      if (response.ok) {
        this.log(`tracked: ${event.name}`)
      } else {
        const errorText = await response.text().catch(() => '')
        this.log(`track failed: ${response.status} ${errorText}`)
      }
    })
  }

  /**
   * Sanitize event name to comply with GA4 requirements
   *
   * GA4 event name rules:
   * - Max 40 characters
   * - Only letters, numbers, underscores
   * - Must start with a letter
   */
  private sanitizeEventName(name: string): string {
    // Replace invalid chars with underscore
    let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_')

    // Ensure starts with letter
    if (!/^[a-zA-Z]/.test(sanitized)) {
      sanitized = 'e_' + sanitized
    }

    // Truncate to 40 chars
    return sanitized.slice(0, 40)
  }

  /**
   * Sanitize params to comply with GA4 requirements
   *
   * GA4 param rules:
   * - Param name max 40 characters
   * - Param value max 100 characters (standard properties)
   */
  private sanitizeParams(
    params?: Record<string, unknown>
  ): Record<string, string | number | boolean> {
    if (!params) return {}

    const sanitized: Record<string, string | number | boolean> = {}

    for (const [key, value] of Object.entries(params)) {
      // Sanitize param name
      const sanitizedKey = key.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)

      // Convert param value
      if (typeof value === 'string') {
        sanitized[sanitizedKey] = value.slice(0, 100)
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        sanitized[sanitizedKey] = value
      } else if (value !== null && value !== undefined) {
        // Convert other types to string
        sanitized[sanitizedKey] = String(value).slice(0, 100)
      }
    }

    return sanitized
  }

  /**
   * Validate event format (for debugging)
   * Uses GA4 debug endpoint to validate request format
   */
  async validateEvent(event: AnalyticsEvent, context: UserContext): Promise<{
    valid: boolean
    messages: string[]
  }> {
    const ga4Event: GA4Event = {
      name: this.sanitizeEventName(event.name),
      params: {
        engagement_time_msec: 1,
        ...this.sanitizeParams(event.properties)
      }
    }

    const payload: GA4Payload = {
      client_id: this._userId,
      events: [ga4Event]
    }

    const url = `${this.debugEndpoint}?measurement_id=${this.measurementId}&api_secret=${this.apiSecret}`

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      const result = await response.json()

      // Debug endpoint returns validation results
      const validationMessages = result.validationMessages || []
      return {
        valid: validationMessages.length === 0,
        messages: validationMessages.map((m: { description: string }) => m.description)
      }
    } catch (error) {
      return {
        valid: false,
        messages: [`Validation request failed: ${error}`]
      }
    }
  }
}

/**
 * Create GA4 Provider instance
 */
export function createGAProvider(measurementId: string, apiSecret: string): GAProvider {
  return new GAProvider({
    measurementId,
    apiSecret,
    debug: process.env.NODE_ENV === 'development'
  })
}
