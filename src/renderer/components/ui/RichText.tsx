/**
 * RichText — restricted markdown for short, untrusted copy.
 *
 * Sized for compact surfaces (toasts, banners) and hardened for content that
 * arrives from a server rather than from the user: update release notes and
 * the announcement feed are both authored outside the app and delivered over
 * plain HTTP on internal deployments.
 *
 * Three boundaries make that safe, and none of them may be relaxed without a
 * security review:
 * 1. `allowedElements` is a whitelist. `img` is absent on purpose — a remote
 *    image is a tracking beacon and an unbounded layout hazard. Headings and
 *    tables are absent because they cannot render sanely at this size.
 * 2. `skipHtml` plus the absence of `rehype-raw` means embedded HTML is
 *    dropped, never executed. The renderer holds privileged bridge APIs, so an
 *    injected script would be arbitrary code execution, not a cosmetic bug.
 * 3. `urlTransform` allows only http/https/mailto, so `javascript:` and
 *    `file:` hrefs cannot survive into the DOM.
 *
 * For long-form assistant output use `chat/MarkdownRenderer` instead — it is
 * built for streaming and carries syntax highlighting and math.
 */

import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Elements this renderer will emit. Anything else is unwrapped to its text. */
const ALLOWED_ELEMENTS = [
  'p', 'br', 'strong', 'em', 'del', 'code',
  'ul', 'ol', 'li', 'a', 'blockquote',
]

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * Drop any href whose protocol is not explicitly safe.
 *
 * Relative URLs have no meaning here (there is no server origin to resolve
 * against), so anything unparseable is dropped rather than passed through.
 */
function safeUrl(url: string): string {
  try {
    return SAFE_PROTOCOLS.has(new URL(url).protocol) ? url : ''
  } catch {
    return ''
  }
}

const components = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-1.5 last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-1.5 last:mb-0 pl-4 space-y-0.5 list-disc">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-1.5 last:mb-0 pl-4 space-y-0.5 list-decimal">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="leading-relaxed">{children}</li>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  // Colours are deliberately inherited rather than themed: this renderer is
  // dropped into surfaces that set their own foreground (the toast card paints
  // its own dark background), so anything absolute would break on one of them.
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="font-mono text-[0.9em]">{children}</code>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-1.5 pl-2 border-l-2 border-current opacity-80">{children}</blockquote>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
}

interface RichTextProps {
  content: string
  className?: string
}

export const RichText = memo(function RichText({ content, className = '' }: RichTextProps) {
  if (!content) return null

  return (
    <div className={`break-words ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        skipHtml
        urlTransform={safeUrl}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
