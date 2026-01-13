/**
 * ID Generation Utilities
 */

/**
 * Generate a unique ID with optional prefix
 */
export function generateId(prefix = 'msg'): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 11)
  return prefix ? `${prefix}_${timestamp}_${random}` : `${timestamp}_${random}`
}

/**
 * Generate a message ID
 */
export function generateMessageId(): string {
  return generateId('msg')
}

/**
 * Generate a tool use ID
 */
export function generateToolUseId(): string {
  return generateId('toolu')
}

/**
 * Generate a server tool use ID
 */
export function generateServerToolUseId(): string {
  return `srvtoolu_${generateId('')}`
}

/**
 * Generate a tool call ID (OpenAI format)
 */
export function generateToolCallId(): string {
  return generateId('call')
}
