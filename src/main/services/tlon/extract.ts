/**
 * Source text extraction for ingest.
 *
 * Plain-text files are read as UTF-8; PDFs are parsed with unpdf (pdf.js); the
 * OOXML formats (pptx / docx / xlsx) are unzipped and their text runs scraped
 * from the slide/document/sharedStrings XML.
 *
 * The EXTRACTED text is what the model ingests. The file's RAW bytes are still
 * what gets hashed for learned-status (callers pass the buffer for both), so a
 * re-export of the same document re-ingests only when the bytes change.
 *
 * Heavy parsers (unpdf, jszip) are loaded via dynamic import so they stay out
 * of the startup graph and only load when a non-text source is actually seen.
 */

/** Formats that need a parser/unzip before they yield text. */
export const EXTRACTABLE_EXTENSIONS = new Set(['.pdf', '.pptx', '.docx', '.xlsx'])

/** Lowercased extension (including the dot), or '' when there is none. */
export function fileExtension(filePath: string): string {
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot < 0 ? '' : lower.slice(dot)
}

export function isExtractable(filePath: string): boolean {
  return EXTRACTABLE_EXTENSIONS.has(fileExtension(filePath))
}

/**
 * Extract the ingestible text of a source file. `buf` is the file's raw bytes.
 * Throws if a parser fails; returns '' when the document has no text.
 */
export async function extractText(absPath: string, buf: Buffer): Promise<string> {
  switch (fileExtension(absPath)) {
    case '.pdf': return extractPdf(buf)
    case '.pptx': return extractOoxml(buf, 'pptx')
    case '.docx': return extractOoxml(buf, 'docx')
    case '.xlsx': return extractOoxml(buf, 'xlsx')
    default: return buf.toString('utf-8')
  }
}

async function extractPdf(buf: Buffer): Promise<string> {
  const { getDocumentProxy, extractText: pdfExtractText } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await pdfExtractText(pdf, { mergePages: true })
  return (Array.isArray(text) ? text.join('\n') : text).trim()
}

async function extractOoxml(buf: Buffer, kind: 'pptx' | 'docx' | 'xlsx'): Promise<string> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buf)
  const read = (name: string) => zip.file(name)?.async('string') ?? Promise.resolve('')

  if (kind === 'pptx') {
    const slides = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => slideNumber(a) - slideNumber(b))
    const out: string[] = []
    for (const name of slides) {
      const text = xmlTexts(await read(name), 'a:t').join(' ').trim()
      if (text) out.push(text)
    }
    return out.join('\n\n').trim()
  }

  if (kind === 'docx') {
    const doc = await read('word/document.xml')
    // One line per paragraph (<w:p>), runs (<w:t>) concatenated within it.
    return doc
      .split(/<\/w:p>/)
      .map(p => xmlTexts(p, 'w:t').join(''))
      .filter(Boolean)
      .join('\n')
      .trim()
  }

  // xlsx: the shared string table holds the bulk of human text.
  const shared = await read('xl/sharedStrings.xml')
  return xmlTexts(shared, 't').join('\n').trim()
}

/** Extract the inner text of every `<tag …>…</tag>` occurrence (XML-decoded). */
function xmlTexts(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const decoded = decodeXmlEntities(m[1])
    if (decoded) out.push(decoded)
  }
  return out
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function slideNumber(name: string): number {
  return parseInt(name.match(/(\d+)\.xml$/)?.[1] ?? '0', 10)
}
