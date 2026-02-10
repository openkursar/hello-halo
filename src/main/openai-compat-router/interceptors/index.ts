/**
 * Request Interceptors
 *
 * Centralized interceptor management for request processing pipeline.
 * Interceptors operate on Anthropic Messages API format (the SDK's native format)
 * and run BEFORE any format conversion to OpenAI.
 */

export * from './types'
export { warmupInterceptor } from './warmup'
export { preflightInterceptor } from './preflight'

import type { AnthropicRequest } from '../types'
import type { RequestInterceptor, InterceptorContext } from './types'
import { warmupInterceptor } from './warmup'
import { preflightInterceptor } from './preflight'

/**
 * Default interceptor chain - order matters!
 * First matching interceptor wins.
 *
 * Chain order rationale:
 *   1. warmup — exact string match ("Warmup"), cheapest check
 *   2. preflight — tools.length check + system prompt match, short-circuits CC SDK internal calls
 */
const defaultInterceptors: RequestInterceptor[] = [
  warmupInterceptor,
  preflightInterceptor,
]

/**
 * Run request through interceptor chain
 *
 * @returns { intercepted: false } if no interceptor handled the request
 * @returns { intercepted: true, request } if request was modified
 * @returns { intercepted: true, responded: true } if response was already sent
 */
export async function runInterceptors(
  request: AnthropicRequest,
  context: InterceptorContext,
  interceptors: RequestInterceptor[] = defaultInterceptors
): Promise<
  | { intercepted: false; request: AnthropicRequest }
  | { intercepted: true; request: AnthropicRequest }
  | { intercepted: true; responded: true }
> {
  let currentRequest = request

  for (const interceptor of interceptors) {
    if (!interceptor.shouldIntercept(currentRequest, context)) {
      continue
    }

    const result = await Promise.resolve(interceptor.intercept(currentRequest, context))

    if (!result.handled) {
      continue
    }

    // Response was sent, stop processing
    if ('responded' in result && result.responded) {
      return { intercepted: true, responded: true }
    }

    // Request was modified, continue with modified request
    if ('modified' in result && result.modified) {
      currentRequest = result.modified
      return { intercepted: true, request: currentRequest }
    }
  }

  return { intercepted: false, request: currentRequest }
}
