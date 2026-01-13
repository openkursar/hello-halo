/**
 * Analytics Provider - Base Class
 *
 * Base class for all analytics providers
 * Provides common functionality: retry, timeout, error handling
 */

import type { AnalyticsEvent, AnalyticsProvider, UserContext } from '../types'

/**
 * Base provider options
 */
export interface BaseProviderOptions {
  /** Request timeout in milliseconds */
  timeout?: number
  /** Max retry attempts */
  maxRetries?: number
  /** Enable debug logging */
  debug?: boolean
}

const DEFAULT_OPTIONS: Required<BaseProviderOptions> = {
  timeout: 10000,    // 10 second timeout
  maxRetries: 2,     // Max 2 retries
  debug: false
}

/**
 * Analytics Provider base class
 */
export abstract class BaseProvider implements AnalyticsProvider {
  abstract readonly name: string

  protected _initialized = false
  protected _userId: string = ''
  protected options: Required<BaseProviderOptions>

  constructor(options?: BaseProviderOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  get initialized(): boolean {
    return this._initialized
  }

  /**
   * Initialize provider
   */
  async init(userId: string): Promise<void> {
    this._userId = userId
    this._initialized = true
    this.log(`initialized with userId: ${userId.slice(0, 8)}...`)
  }

  /**
   * Track event (implemented by subclass)
   */
  abstract track(event: AnalyticsEvent, context: UserContext): Promise<void>

  /**
   * HTTP request with retry
   */
  protected async fetchWithRetry(
    url: string,
    options: RequestInit,
    retries = this.options.maxRetries
  ): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.options.timeout)

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      // Retry if request failed and retries remaining
      if (!response.ok && retries > 0) {
        this.log(`request failed with ${response.status}, retrying... (${retries} left)`)
        return this.fetchWithRetry(url, options, retries - 1)
      }

      return response
    } catch (error) {
      clearTimeout(timeoutId)

      // Retry on timeout or network error if retries remaining
      if (retries > 0) {
        this.log(`request error: ${error}, retrying... (${retries} left)`)
        return this.fetchWithRetry(url, options, retries - 1)
      }

      throw error
    }
  }

  /**
   * Safe track (won't throw exceptions)
   */
  protected async safeTrack(
    trackFn: () => Promise<void>
  ): Promise<void> {
    try {
      await trackFn()
    } catch (error) {
      // Silent failure, only log
      this.log(`track failed: ${error}`)
    }
  }

  /**
   * Log output
   */
  protected log(message: string): void {
    if (this.options.debug || process.env.NODE_ENV === 'development') {
      console.log(`[Analytics:${this.name}] ${message}`)
    }
  }
}
