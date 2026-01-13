/**
 * Request Queue
 *
 * Prevents concurrent requests to the same upstream provider
 * This solves 429 errors caused by parallel request behavior
 */

const requestQueues = new Map<string, Promise<void>>()

/**
 * Execute a function with request queue protection
 *
 * Ensures only one request per key is in flight at a time.
 * Subsequent requests wait for the previous one to complete.
 */
export async function withRequestQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any pending request with the same key
  const pending = requestQueues.get(key)
  if (pending) {
    await pending.catch(() => {}) // Ignore errors from previous request
  }

  // Create a new promise for this request
  let resolve: () => void
  const thisRequest = new Promise<void>((r) => {
    resolve = r
  })
  requestQueues.set(key, thisRequest)

  try {
    return await fn()
  } finally {
    resolve!()
    // Clean up if this is still the current request
    if (requestQueues.get(key) === thisRequest) {
      requestQueues.delete(key)
    }
  }
}

/**
 * Generate a queue key from backend URL and API key
 */
export function generateQueueKey(backendUrl: string, apiKey: string): string {
  return `${backendUrl}:${apiKey.slice(0, 16)}`
}

/**
 * Clear all pending requests (for testing)
 */
export function clearRequestQueues(): void {
  requestQueues.clear()
}

/**
 * Get the number of pending requests (for monitoring)
 */
export function getPendingRequestCount(): number {
  return requestQueues.size
}
