/**
 * Re-stamp the Claude Code attribution line with the version Halo pins.
 *
 * The CLI spawned for a session writes its own version into a system-prompt
 * block (`cc_version=<cli version>.<fingerprint>`), and Anthropic gates model
 * access on that value as well as on the user-agent. Overriding the header
 * alone leaves the model rejected for the CLI's version, whatever the header
 * claims.
 */

import type { AnthropicMessage, AnthropicRequest } from '../types/anthropic'
import {
  extractFirstUserMessageText,
  rewriteAttributionVersion,
} from './claude-code-identity'

const DEFERRED_TOOLS_LISTING = '<available-deferred-tools>'

function isDeferredToolsListing(text: string): boolean {
  return text.startsWith(DEFERRED_TOOLS_LISTING)
}

/**
 * The first user message as the CLI saw it when fingerprinting. The CLI
 * fingerprints before prepending its deferred-tools listing as a user message,
 * so the listing — standalone, or merged into the first message as a leading
 * block — is not part of the input.
 */
function firstUserMessageForFingerprint(messages: AnthropicMessage[]): AnthropicMessage[] {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const { content } = message
    if (typeof content === 'string') {
      if (isDeferredToolsListing(content)) continue
      return [message]
    }
    if (!Array.isArray(content)) return [message]
    const rest = content.filter(b => !(b.type === 'text' && isDeferredToolsListing(b.text)))
    if (rest.length === 0) continue
    return [{ ...message, content: rest }]
  }
  return []
}

export function normalizeClaudeCodeAttribution(
  request: AnthropicRequest
): { request: AnthropicRequest; modified: boolean } {
  const { system } = request
  if (!system) return { request, modified: false }

  // The fingerprint covers the version, so it is recomputed rather than
  // carried over from the line being replaced.
  const firstUserText = extractFirstUserMessageText(
    firstUserMessageForFingerprint(request.messages ?? [])
  )

  if (typeof system === 'string') {
    const text = rewriteAttributionVersion(system, firstUserText)
    if (text === null) return { request, modified: false }
    return { request: { ...request, system: text }, modified: true }
  }

  if (Array.isArray(system)) {
    let modified = false
    const nextSystem = system.map(block => {
      if (block?.type !== 'text' || typeof block.text !== 'string') return block
      const text = rewriteAttributionVersion(block.text, firstUserText)
      if (text === null) return block
      modified = true
      return { ...block, text }
    })
    if (!modified) return { request, modified: false }
    return { request: { ...request, system: nextSystem }, modified: true }
  }

  return { request, modified: false }
}
