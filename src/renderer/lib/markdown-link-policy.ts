/**
 * Which links and images in rendered Markdown stay live, for every Streamdown
 * surface.
 *
 * Replaces Streamdown's own hardener, whose sanitizer strips any link that is
 * not http(s)/mailto and then labels what is left " [blocked]" — conversation
 * references, `file://` and app links all read as broken. Here a link stays
 * live unless clicking it would run code in Halo's own window; a link that
 * cannot stay live is shown as its text, with nothing added.
 */

import { defaultRehypePlugins } from 'streamdown'
import type { Pluggable } from 'unified'

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** Schemes that execute in, or render into, the window that follows them. */
const EXECUTING_PROTOCOLS = new Set(['javascript:', 'vbscript:', 'data:'])

/**
 * A fragment, or an absolute URL whose scheme does not execute. Parsed the way
 * the browser will follow it, so obfuscation (case, embedded tabs) is seen
 * through. A relative path has no target outside its page here, so it is not live.
 */
function isLiveHref(href: unknown): boolean {
  if (typeof href !== 'string' || !href) return false
  if (href.startsWith('#')) return true
  try {
    return !EXECUTING_PROTOCOLS.has(new URL(href).protocol)
  } catch {
    return false
  }
}

function replacement(node: HastNode): HastNode[] | null {
  if (node.tagName === 'a' && !isLiveHref(node.properties?.href)) return node.children ?? []
  if (node.tagName === 'img' && !node.properties?.src) {
    const alt = node.properties?.alt
    return typeof alt === 'string' && alt ? [{ type: 'text', value: alt }] : []
  }
  return null
}

function apply(node: HastNode): void {
  const children = node.children
  if (!children) return
  for (let i = 0; i < children.length; i++) {
    const replaced = replacement(children[i])
    if (replaced) {
      children.splice(i, 1, ...replaced)
      i--
      continue
    }
    apply(children[i])
  }
}

/** Rehype plugin: dead links become their text, images without a source their alt text. */
export function rehypeLinkPolicy() {
  return apply
}

const [sanitizePlugin, sanitizeSchema] = defaultRehypePlugins.sanitize as [Pluggable, Record<string, any>]

/** Streamdown's sanitizer, minus its link-scheme allowlist: this policy decides links. */
export const markdownSanitize: Pluggable = [
  sanitizePlugin,
  { ...sanitizeSchema, protocols: { ...sanitizeSchema.protocols, href: null } },
] as Pluggable

export const markdownRaw: Pluggable = defaultRehypePlugins.raw

/** The full chain for a surface with no extra steps. */
export const MARKDOWN_REHYPE_PLUGINS: Pluggable[] = [markdownRaw, markdownSanitize, rehypeLinkPolicy]
