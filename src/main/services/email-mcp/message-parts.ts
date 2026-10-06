/**
 * Email MCP — Message part plan
 *
 * Decides from a message's BODYSTRUCTURE which parts email_read downloads: the
 * text bodies only. Attachments are listed from the structure and their MIME
 * headers; their content is never fetched. Parts are classified the way
 * mailparser classifies them when it parses the whole message, so both ways
 * of reading return the same body. A structure outside the shapes below
 * returns null, and the caller reads the whole message instead.
 */

/** The fields of an imapflow BODYSTRUCTURE node read here. */
export interface BodyStructureNode {
  part?: string
  type?: string
  encoding?: string
  size?: number
  disposition?: string
  /** Content-ID, present on images an HTML body shows inline. */
  id?: string
  childNodes?: BodyStructureNode[]
}

export interface PlannedAttachment {
  part: string
  /** Decoded size, estimated from the encoded size for base64. */
  size: number
  /** An image the HTML body references by Content-ID. */
  related: boolean
}

export interface MessagePartPlan {
  plainPart?: string
  htmlPart?: string
  attachments: PlannedAttachment[]
}

/** Types mailparser reads as body text when not disposed as an attachment. */
const TEXT_TYPES = new Set(['text/plain', 'text/html', 'message/delivery-status'])

/** Base64 bodies are wrapped at 76 characters plus CRLF. */
const BASE64_LINE_OCTETS = 78

export function planMessageParts(structure: BodyStructureNode | undefined): MessagePartPlan | null {
  // A single-part message has no attachment to leave behind.
  if (!structure?.childNodes?.length) return null

  const attachments: PlannedAttachment[] = []
  const bodies: Array<{ part: string; type: string; alternative: boolean }> = []

  const walk = (node: BodyStructureNode, alternative: boolean, related: boolean): boolean => {
    const type = node.type ?? ''
    if (type.startsWith('multipart/')) {
      if (!node.childNodes?.length) return false
      return node.childNodes.every(child =>
        walk(child, alternative || type === 'multipart/alternative', related || type === 'multipart/related'))
    }
    if (!node.part || !type || isEmbeddedMessage(node)) return false
    if (isAttachment(type, node.disposition)) {
      attachments.push({ part: node.part, size: decodedSize(node), related: related && !!node.id })
      return true
    }
    if (type === 'message/delivery-status') return false
    bodies.push({ part: node.part, type, alternative })
    return true
  }
  if (!walk(structure, false, false)) return null

  const plain = bodies.filter(body => body.type === 'text/plain')
  const html = bodies.filter(body => body.type === 'text/html')
  // One body, or one plain and one HTML alternative of each other. Other
  // combinations are concatenated by mailparser in ways not repeated here.
  const supported = bodies.length <= 1 ||
    (plain.length === 1 && html.length === 1 && bodies.every(body => body.alternative))
  if (!supported) return null

  return { plainPart: plain[0]?.part, htmlPart: html[0]?.part, attachments }
}

/** mailparser's rule: anything but inline body text is an attachment. */
function isAttachment(type: string, disposition: string | undefined): boolean {
  let effective = disposition
  if (effective && effective !== 'attachment' && effective !== 'inline') effective = 'attachment'
  if (!effective) effective = TEXT_TYPES.has(type) ? 'inline' : 'attachment'
  return !TEXT_TYPES.has(type) || effective !== 'inline'
}

/** A message mailparser opens and shows inline instead of listing it. */
function isEmbeddedMessage(node: BodyStructureNode): boolean {
  return node.type === 'message/rfc822' &&
    node.disposition === 'inline' &&
    (!node.encoding || ['7bit', '8bit', 'binary'].includes(node.encoding))
}

export function decodedSize(node: Pick<BodyStructureNode, 'encoding' | 'size'>): number {
  const size = node.size ?? 0
  if (node.encoding !== 'base64') return size
  const lineBreakOctets = Math.ceil(size / BASE64_LINE_OCTETS) * 2
  return Math.max(0, Math.floor((size - lineBreakOctets) * 3 / 4))
}
