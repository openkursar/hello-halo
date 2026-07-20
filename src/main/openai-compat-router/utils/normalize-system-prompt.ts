/**
 * Ensure the system prompt opens with the host's own identity line.
 */

import type { AnthropicRequest } from '../types/anthropic'

const IDENTITY_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

// Set false to keep the prompt unchanged.
const ENABLED = true

export function normalizeSystemPrompt(
  request: AnthropicRequest
): { request: AnthropicRequest; modified: boolean } {
  if (!ENABLED) return { request, modified: false }

  const { system } = request

  if (typeof system === 'string') {
    if (!system.startsWith(IDENTITY_PREFIX)) return { request, modified: false }
    const text = system.slice(IDENTITY_PREFIX.length).replace(/^\s+/, '')
    return { request: { ...request, system: text }, modified: true }
  }

  if (Array.isArray(system)) {
    // The identity line is its own text block and is not necessarily first
    // (other blocks may precede it), so scan every block rather than just [0].
    let modified = false
    const nextSystem: typeof system = []
    for (const block of system) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.startsWith(IDENTITY_PREFIX)) {
        const text = block.text.slice(IDENTITY_PREFIX.length).replace(/^\s+/, '')
        modified = true
        if (text.length > 0) nextSystem.push({ ...block, text })
        continue
      }
      nextSystem.push(block)
    }
    if (!modified) return { request, modified: false }
    return { request: { ...request, system: nextSystem }, modified: true }
  }

  return { request, modified: false }
}
