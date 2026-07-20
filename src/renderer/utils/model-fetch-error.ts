import type { ModelFetchErrorCode } from '../../shared/model-fetch-error'

type Translate = (text: string) => string

export function formatModelFetchError(
  t: Translate,
  code?: string,
  detail?: string
): string {
  let message: string

  switch (code as ModelFetchErrorCode) {
    case 'MODEL_FETCH_UNAUTHORIZED':
      message = t('Invalid API Key or no permission')
      break
    case 'MODEL_FETCH_NOT_FOUND':
      message = t('Endpoint not found, check the URL')
      break
    case 'MODEL_FETCH_RATE_LIMITED':
      message = t('Rate limited or out of quota')
      break
    case 'MODEL_FETCH_TIMEOUT':
      message = t('Request timed out, check the server or proxy')
      break
    case 'MODEL_FETCH_NETWORK':
      message = t('Cannot reach server, check network or proxy')
      break
    default:
      message = t('Failed to fetch models')
  }

  return detail ? `${message}: ${detail}` : message
}
