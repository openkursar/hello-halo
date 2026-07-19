/**
 * Source text extraction for ingest.
 *
 * Plain-text files are decoded with encoding detection (UTF-8/UTF-16 first,
 * then common legacy CJK/Latin codepages); PDFs are parsed with unpdf (pdf.js);
 * the OOXML formats (pptx / docx / xlsx) are unzipped and their text runs scraped
 * from the slide/document/sharedStrings XML; images are OCR'd locally (see ocr.ts).
 * Scanned PDFs (no text layer) currently yield no text — OCR of rendered pages
 * would need a native canvas dependency and is deferred.
 *
 * The EXTRACTED text is what the model ingests. The file's RAW bytes are still
 * what gets hashed for learned-status (callers pass the buffer for both), so a
 * re-export of the same document re-ingests only when the bytes change.
 *
 * Heavy parsers (unpdf, jszip, the OCR engine) are loaded via dynamic import so
 * they stay out of the startup graph and only load when such a source is seen.
 */

/** Document formats that need a parser/unzip before they yield text. */
export const EXTRACTABLE_EXTENSIONS = new Set(['.pdf', '.pptx', '.docx', '.xlsx'])

/** Image formats whose text is recovered by OCR at ingest. */
export const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif',
])

/** Lowercased extension (including the dot), or '' when there is none. */
export function fileExtension(filePath: string): string {
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot < 0 ? '' : lower.slice(dot)
}

export function isImage(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(filePath))
}

/** True when the file needs a parser or OCR (i.e. is not plain text). */
export function isExtractable(filePath: string): boolean {
  const ext = fileExtension(filePath)
  return EXTRACTABLE_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)
}

/**
 * Extract the ingestible text of a source file. `buf` is the file's raw bytes.
 * Throws if a parser fails; returns '' when the document has no text.
 */
export async function extractText(absPath: string, buf: Buffer): Promise<string> {
  const ext = fileExtension(absPath)
  if (IMAGE_EXTENSIONS.has(ext)) {
    const { ocrImage } = await import('./ocr')
    return ocrImage(buf)
  }
  switch (ext) {
    case '.pdf': return extractPdf(buf)
    case '.pptx': return extractOoxml(buf, 'pptx')
    case '.docx': return extractOoxml(buf, 'docx')
    case '.xlsx': return extractOoxml(buf, 'xlsx')
    default: return decodeTextBuffer(buf)
  }
}

/**
 * Decode a plain-text buffer without assuming UTF-8. Legacy-encoded files
 * (GBK/Big5/Shift_JIS/Windows-1252) would otherwise index as replacement-char
 * soup and become un-greppable. Uses Node's ICU TextDecoder — no dependency.
 */
export function decodeTextBuffer(buf: Buffer): string {
  // UTF-16 BOMs first: NUL-heavy but valid text.
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  }
  const utf8 = tryDecode(buf, 'utf-8')
  if (utf8 !== null) return utf8

  // The CJK codepages overlap so heavily that "decodes without error" is not
  // enough (GBK accepts most Big5/Shift_JIS streams as mojibake): rank the
  // clean decodes by how plausible the result looks instead. Shift_JIS goes
  // first when its distinctive 0x81-0x9F lead bytes are frequent. Latin-heavy
  // buffers (few high bytes) skip the CJK ranking entirely — an accented word
  // would otherwise decode as a stray hanzi — and windows-1252, which never
  // rejects, is the last resort.
  const stats = byteStats(buf)
  if (stats.highFrac >= 0.25) {
    const order = stats.sjisLeadFrac >= 0.2
      ? ['shift_jis', 'gbk', 'big5']
      : ['gbk', 'big5', 'shift_jis']
    let best = ''
    let bestScore = 0
    for (const encoding of order) {
      const text = tryDecode(buf, encoding)
      if (text === null) continue
      const score = cjkPlausibility(text, encoding === 'shift_jis')
      if (score > bestScore) { best = text; bestScore = score }
    }
    if (bestScore > 0) return best
  }
  return tryDecode(buf, 'windows-1252') ?? buf.toString('utf-8')
}

/** Fatal decode; null when the encoding rejects the bytes. */
function tryDecode(buf: Buffer, encoding: string): string | null {
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(buf)
    return text.includes('\ufffd') ? null : text
  } catch {
    return null
  }
}

/** High-byte density and Shift_JIS-lead density over the head of the buffer. */
function byteStats(buf: Buffer): { highFrac: number; sjisLeadFrac: number } {
  const limit = Math.min(buf.length, 65536)
  let high = 0
  let sjisLead = 0
  for (let i = 0; i < limit; i++) {
    const b = buf[i]
    if (b > 0x7f) {
      high++
      if (b >= 0x81 && b <= 0x9f) sjisLead++
    }
  }
  return { highFrac: limit === 0 ? 0 : high / limit, sjisLeadFrac: high === 0 ? 0 : sjisLead / high }
}

/**
 * Plausibility of a candidate CJK decode: ideographs are evidence for it, while
 * kana (unless Shift_JIS produced them), Greek/Cyrillic, box drawing and
 * half-width katakana are the classic wrong-codepage symbol soup against it.
 */
function cjkPlausibility(text: string, kanaExpected: boolean): number {
  let score = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c >= 0x4e00 && c <= 0x9fff) score += 1
    else if (c >= 0x3040 && c <= 0x30ff) score += kanaExpected ? 1 : -2
    else if ((c >= 0x0370 && c <= 0x04ff) || (c >= 0x2500 && c <= 0x25ff) || (c >= 0xff61 && c <= 0xff9f)) score -= 2
  }
  return score
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
