export type ModelFetchErrorCode =
  | 'MODEL_FETCH_UNAUTHORIZED'
  | 'MODEL_FETCH_NOT_FOUND'
  | 'MODEL_FETCH_RATE_LIMITED'
  | 'MODEL_FETCH_TIMEOUT'
  | 'MODEL_FETCH_NETWORK'
  | 'MODEL_FETCH_FAILED'

export interface ModelFetchFailure {
  code: ModelFetchErrorCode
  detail?: string
}

const MAX_DETAIL_LENGTH = 200

export class ModelFetchError extends Error {
  readonly code: ModelFetchErrorCode
  readonly detail?: string

  constructor(failure: ModelFetchFailure) {
    super(failure.detail || 'Failed to fetch models')
    this.name = 'ModelFetchError'
    this.code = failure.code
    this.detail = failure.detail
  }
}

function sanitizeDetail(value: unknown, apiKey: string): string | undefined {
  if (typeof value !== 'string') return undefined

  let detail = apiKey ? value.split(apiKey).join('[REDACTED]') : value
  detail = detail
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!detail) return undefined

  const characters = Array.from(detail)
  if (characters.length > MAX_DETAIL_LENGTH) {
    return `${characters.slice(0, MAX_DETAIL_LENGTH - 1).join('')}…`
  }

  return detail
}

function codeForStatus(status: number): ModelFetchErrorCode {
  if (status === 401 || status === 403) return 'MODEL_FETCH_UNAUTHORIZED'
  if (status === 404) return 'MODEL_FETCH_NOT_FOUND'
  if (status === 429) return 'MODEL_FETCH_RATE_LIMITED'
  return 'MODEL_FETCH_FAILED'
}

export function modelFetchFailureFromResponse(
  status: number,
  body: string,
  apiKey: string
): ModelFetchFailure {
  let detail: string | undefined

  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown }
      message?: unknown
    }
    const nestedMessage = parsed.error?.message
    detail = sanitizeDetail(
      typeof nestedMessage === 'string' ? nestedMessage : parsed.message,
      apiKey
    )
  } catch {
    detail = undefined
  }

  return { code: codeForStatus(status), detail }
}

export function modelFetchFailureFromError(error: unknown): ModelFetchFailure {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : ''
  const normalized = `${name} ${message}`.toLowerCase()
  const isTimeout = name === 'AbortError'
    || name === 'TimeoutError'
    || normalized.includes('timeout')
    || normalized.includes('timed out')
    || normalized.includes('aborted')

  if (isTimeout) {
    return { code: 'MODEL_FETCH_TIMEOUT' }
  }

  const isNetwork = error instanceof TypeError
    || /\b(econnrefused|econnreset|enotfound|enetunreach|ehostunreach)\b/i.test(message)

  if (isNetwork) {
    return { code: 'MODEL_FETCH_NETWORK' }
  }

  return { code: 'MODEL_FETCH_FAILED' }
}
