const FENCE_OR_RULE = /^\s*(?:```|~~~|(?:[-*_]\s*){3,}$|\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$)/

/**
 * Markdown as the plain lines it reads as, for a clamped preview where rendering
 * would cost too much: syntax marks and blank lines dropped, list items kept as bullets.
 */
export function markdownPreview(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .split(/\r?\n/)
    .filter(line => !FENCE_OR_RULE.test(line))
    .map(line => line
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/, '• ')
      .replace(/\*\*|__|~~|`/g, '')
      .trim())
    .filter(Boolean)
    .join('\n')
}

const HEADING = /^\s*#{1,6}\s+(.+?)[\s#]*$/
const BOLD_LINE = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*[:：]?\s*$/
const TOP_ITEM = /^(?:[-*+]|\d+[.)])\s+(.+)$/
const FENCE = /^\s*(?:```|~~~)/

export interface MarkdownDigest {
  /** The opening paragraph as one plain line. */
  lead: string
  /** Section headings, else top-level items, when there are at least two. */
  outline: string[]
  /** Whether the lead already says everything the text does. */
  whole: boolean
}

/** A Markdown report as a glance takes it in: what it opens with, and what it covers. */
export function markdownDigest(markdown: string): MarkdownDigest {
  const lead: string[] = []
  const headings: string[] = []
  const items: string[] = []
  let fenced = false
  let leadClosed = false
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced
    if (fenced || FENCE.test(line)) { leadClosed ||= lead.length > 0; continue }
    const heading = HEADING.exec(line) ?? BOLD_LINE.exec(line)
    const item = heading ? null : TOP_ITEM.exec(line)
    if (heading) headings.push(heading[1])
    if (item) items.push(item[1])
    if (heading || item || !line.trim() || /^\s/.test(line) || FENCE_OR_RULE.test(line)) leadClosed ||= lead.length > 0
    else if (!leadClosed) lead.push(line)
  }
  const plain = (text: string) => markdownPreview(text).replace(/\n/g, ' ')
  const list = headings.length >= 2 ? headings : items.length >= 2 ? items : []
  // A bold lead-in such as "**Why:**" names its section; the colon only introduces the body.
  const outline = list.map(entry => plain(entry).replace(/\s*[:：]\s*$/, '')).filter(Boolean)
  const opening = lead.length ? plain(lead.join('\n')) : outline.length ? '' : plain(markdown)
  return { lead: opening, outline, whole: !outline.length && opening === plain(markdown) }
}
