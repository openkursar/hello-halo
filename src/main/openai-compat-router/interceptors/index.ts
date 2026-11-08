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
export { imageBudgetInterceptor } from './image-budget'

import type { AnthropicRequest } from '../types'
import type { RequestInterceptor, InterceptorContext } from './types'
import { warmupInterceptor } from './warmup'
import { preflightInterceptor } from './preflight'
import { imageBudgetInterceptor } from './image-budget'

/**
 * Default interceptor chain - order matters!
 *
 * Chain order rationale:
 *   1. warmup — exact string match ("Warmup"), cheapest check; terminal (responds)
 *   2. preflight — tools.length check + system prompt match; terminal (responds)
 *   3. image-budget — filters unsupported images or evicts oldest images over 3.5MB
 *
 * warmup and preflight are terminal (send their own response) and never reach
 * image-budget. For normal agent-loop requests, only image-budget runs.
 */
const defaultInterceptors: RequestInterceptor[] = [
  warmupInterceptor,
  preflightInterceptor,
  imageBudgetInterceptor,
]

/** Interceptors that answer a request themselves, so no model is ever asked. */
const localAnswerInterceptors: RequestInterceptor[] = [warmupInterceptor, preflightInterceptor]

/**
 * Whether the request is one the router answers on its own (warmup, preflight).
 * Such a request needs no model, so no member of a group should be chosen for it.
 */
export function answersLocally(request: AnthropicRequest, context: InterceptorContext): boolean {
  return localAnswerInterceptors.some(interceptor => interceptor.shouldIntercept(request, context))
}

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
