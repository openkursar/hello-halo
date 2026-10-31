/**
 * Tlon Extract Unit Tests
 *
 * Extension classification and text extraction. OOXML fixtures (docx/pptx/xlsx)
 * are built in-test with jszip so no binary fixtures are checked in.
 */

import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'

import {
  fileExtension,
  isImage,
  isExtractable,
  extractText,
  decodeTextBuffer,
  EXTRACTABLE_EXTENSIONS,
  IMAGE_EXTENSIONS,
} from '../../../../src/main/services/tlon/extract'

async function zipBuffer(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content)
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function workbookBuffer(sheets: Array<{ name: string; rows: string; dimension?: string }>, shared?: string, extra: Record<string, string> = {}): Promise<Buffer> {
  const relationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const files: Record<string, string> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map(sheet => `<Override PartName="/xl/worksheets/${sheet.name}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}${shared === undefined ? '' : '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'}</Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="workbook" Type="${relationship}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${spreadsheet}" xmlns:r="${relationship}"><sheets>${sheets.map((_sheet, index) => `<sheet name="Sheet ${index + 1}" sheetId="${index + 1}" r:id="sheet${index}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((sheet, index) => `<Relationship Id="sheet${index}" Type="${relationship}/worksheet" Target="worksheets/${sheet.name}"/>`).join('')}${shared === undefined ? '' : `<Relationship Id="strings" Type="${relationship}/sharedStrings" Target="sharedStrings.xml"/>`}</Relationships>`,
    ...extra,
  }
  for (const sheet of sheets) files[`xl/worksheets/${sheet.name}`] = `<worksheet xmlns="${spreadsheet}">${sheet.dimension ? `<dimension ref="${sheet.dimension}"/>` : ''}<sheetData>${sheet.rows}</sheetData></worksheet>`
  if (shared !== undefined) files['xl/sharedStrings.xml'] = `<sst xmlns="${spreadsheet}">${shared}</sst>`
  return zipBuffer(files)
}

describe('Tlon Extract', () => {
  describe('fileExtension', () => {
    it('returns the lowercased extension including the dot', () => {
      expect(fileExtension('/a/b/Report.PDF')).toBe('.pdf')
      expect(fileExtension('notes.md')).toBe('.md')
      expect(fileExtension('archive.tar.gz')).toBe('.gz')
    })

    it('returns empty string when there is no extension', () => {
      expect(fileExtension('Makefile')).toBe('')
    })
  })

  describe('isImage / isExtractable', () => {
    it('classifies image extensions', () => {
      for (const ext of IMAGE_EXTENSIONS) {
        expect(isImage(`photo${ext}`), ext).toBe(true)
      }
      expect(isImage('doc.pdf')).toBe(false)
      expect(isImage('notes.md')).toBe(false)
    })

    it('extractable = document formats plus images, not plain text', () => {
      for (const ext of EXTRACTABLE_EXTENSIONS) {
        expect(isExtractable(`file${ext}`), ext).toBe(true)
      }
      expect(isExtractable('scan.png')).toBe(true)
      expect(isExtractable('notes.md')).toBe(false)
      expect(isExtractable('plain.txt')).toBe(false)
    })
  })

  describe('plain text', () => {
    it('reads .txt as UTF-8 (multibyte preserved)', async () => {
      const content = 'Hello 世界 — naïve café'
      const text = await extractText('/tmp/a.txt', Buffer.from(content, 'utf-8'))
      expect(text).toBe(content)
    })

    it('treats unknown extensions as plain text passthrough', async () => {
      const text = await extractText('/tmp/a.md', Buffer.from('# md'))
      expect(text).toBe('# md')
    })
  })

  describe('decodeTextBuffer (encoding detection)', () => {
    it('decodes GBK Chinese', () => {
      // 中文 in GBK
      expect(decodeTextBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe('中文')
    })

    it('decodes Big5 Chinese', () => {
      // 中文 in Big5
      expect(decodeTextBuffer(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]))).toBe('中文')
    })

    it('decodes Shift_JIS Japanese', () => {
      // 日本語 in Shift_JIS
      expect(decodeTextBuffer(Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]))).toBe('日本語')
    })

    it('decodes UTF-16LE with BOM', () => {
      const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo 世界', 'utf16le')])
      expect(decodeTextBuffer(buf)).toBe('héllo 世界')
    })

    it('decodes UTF-16BE with BOM', () => {
      const le = Buffer.from('héllo 世界', 'utf16le')
      const be = Buffer.from(le)
      be.swap16()
      expect(decodeTextBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('héllo 世界')
    })

    it('falls back to windows-1252 for lone high bytes', () => {
      // "café" in windows-1252: lone 0xE9 at end rejects UTF-8 and the CJK codepages
      expect(decodeTextBuffer(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe('café')
    })

    it('prefers UTF-8 when the bytes are valid UTF-8', () => {
      const content = 'mixed 中文 café ✓'
      expect(decodeTextBuffer(Buffer.from(content, 'utf-8'))).toBe(content)
    })

    it('extractText routes plain text through detection', async () => {
      const text = await extractText('/tmp/gbk.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
      expect(text).toBe('中文')
    })
  })

  describe('docx', () => {
    it('joins runs within a paragraph and emits one line per paragraph', async () => {
      const buf = await zipBuffer({
        'word/document.xml':
          '<w:document><w:body>' +
          '<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t xml:space="preserve">world</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>' +
          '<w:p></w:p>' +
          '</w:body></w:document>',
      })
      const text = await extractText('/tmp/doc.docx', buf)
      expect(text).toBe('Hello world\nSecond paragraph')
    })

    it('decodes XML entities in runs', async () => {
      const buf = await zipBuffer({
        'word/document.xml':
          '<w:document><w:body><w:p><w:r>' +
          '<w:t>A &amp; B &lt;tag&gt; &quot;q&quot; &apos;s&apos;</w:t>' +
          '</w:r></w:p></w:body></w:document>',
      })
      const text = await extractText('/tmp/doc.docx', buf)
      expect(text).toBe(`A & B <tag> "q" 's'`)
    })

    it('returns empty string for a docx without document.xml', async () => {
      const buf = await zipBuffer({ 'word/other.xml': '<x/>' })
      expect(await extractText('/tmp/doc.docx', buf)).toBe('')
    })
  })

  describe('pptx', () => {
    it('orders slides numerically (slide2 before slide10) and joins with blank lines', async () => {
      const slide = (t: string) => `<p:sld><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sld>`
      const buf = await zipBuffer({
        'ppt/slides/slide10.xml': slide('Tenth slide'),
        'ppt/slides/slide2.xml': slide('Second slide'),
        'ppt/slides/slide1.xml': slide('First slide'),
        'ppt/slides/_rels/slide1.xml.rels': '<Relationships/>',
        'ppt/notesSlides/notesSlide1.xml': slide('Speaker notes ignored'),
      })
      const text = await extractText('/tmp/deck.pptx', buf)
      expect(text).toBe('First slide\n\nSecond slide\n\nTenth slide')
    })

    it('skips slides with no text', async () => {
      const buf = await zipBuffer({
        'ppt/slides/slide1.xml': '<p:sld><a:t>Only slide</a:t></p:sld>',
        'ppt/slides/slide2.xml': '<p:sld></p:sld>',
      })
      expect(await extractText('/tmp/deck.pptx', buf)).toBe('Only slide')
    })
  })

  describe('xlsx', () => {
    it('extracts referenced shared strings in worksheet order', async () => {
      const buf = await workbookBuffer([{ name: 'sheet1.xml', rows: [0, 1, 2].map((index) => `<row r="${index + 1}"><c r="A${index + 1}" t="s"><v>${index}</v></c></row>`).join('') }],
          '<si><t>Header</t></si>' +
          '<si><t xml:space="preserve">Cell &amp; value</t></si>' +
          '<si><r><t>Rich</t></r></si>')
      const text = await extractText('/tmp/book.xlsx', buf)
      expect(text).toBe('Header\nCell & value\nRich')
    })

    it('returns empty string when there is no shared string table', async () => {
      const buf = await workbookBuffer([{ name: 'sheet1.xml', rows: '' }])
      expect(await extractText('/tmp/book.xlsx', buf)).toBe('')
    })

    it.each([true, false])('reads text and numeric cells from a real workbook with bookSST=%s', async (bookSST) => {
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Reference', 'Cedar record'], ['Quantity', 87261345.25]]), 'Reference')
      const buf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', bookSST })
      expect(await extractText('/tmp/book.xlsx', buf)).toBe('Reference\tCedar record\nQuantity\t87261345.25')
    })

    it('reads rich inline strings, XML entities and stored numeric values without a shared table', async () => {
      const buf = await workbookBuffer([{ name: 'sheet1.xml', rows: '<row r="1"><c r="A1" t="inlineStr"><is><r><t>Alpha &amp; </t></r><r><t>Beta &#x4e2d;</t></r><rPh sb="0" eb="1"><t>phonetic hint</t></rPh></is></c><c r="B1"><v>-12.5</v></c><c r="C1" t="b"><v>1</v></c></row>' }])
      expect(await extractText('/tmp/book.xlsx', buf)).toBe('Alpha & Beta 中\t-12.5\t1')
    })

    it('preserves shared-string indexes and rich text without indexing unused entries', async () => {
      const buf = await workbookBuffer([{ name: 'sheet1.xml', rows: '<row r="1"><c r="A1" t="s"><v>2</v></c><c r="B1" t="s"><v>0</v></c><c r="C1" t="str"><v>Tail</v></c></row>' }], '<si><t></t></si><si><t>Unused ghost content</t></si><si><r><t>Rich </t></r><r><t>text</t></r><rPh sb="0" eb="1"><t>phonetic hint</t></rPh></si>')
      expect(await extractText('/tmp/book.xlsx', buf)).toBe('Rich text\t\tTail')
    })

    it('uses workbook relationships for sheet order and ignores unreferenced worksheet parts', async () => {
      const buf = await workbookBuffer([
        { name: 'later-name.xml', rows: '<row r="1"><c r="A1" t="str"><v>First tab</v></c></row>' },
        { name: 'earlier-name.xml', rows: '<row r="1"><c r="A1" t="str"><v>Second tab</v></c></row>' },
      ], undefined, { 'xl/worksheets/ghost.xml': '<worksheet><sheetData><row><c t="str"><v>Unreferenced part</v></c></row></sheetData></worksheet>' })
      expect(await extractText('/tmp/book.xlsx', buf)).toBe('First tab\n\nSecond tab')
    })

    it('reads cached formula results without indexing formulas or external-link content', async () => {
      const buf = await workbookBuffer([{ name: 'sheet1.xml', rows: '<row r="1"><c r="A1"><f>WEBSERVICE("https://example.invalid/private")</f><v>19.5</v></c><c r="B1" t="str"><f>ExternalName</f><v>Cached result</v></c><c r="C1"><f>1+2</f></c></row>' }], undefined, { 'xl/externalLinks/externalLink1.xml': '<externalLink>External content must not be read</externalLink>' })
      expect(await extractText('/tmp/book.xlsx', buf)).toBe('19.5\tCached result')
    })

    it('does not expand a sparse worksheet dimension into empty cells', async () => {
      const buf = await workbookBuffer([{ name: 'sheet1.xml', dimension: 'A1:XFD1048576', rows: '<row r="1048576"><c r="XFD1048576"><v>42</v></c></row>' }])
      expect(await extractText('/tmp/book.xlsx', buf)).toBe('42')
    })

    it('preserves text across decompression and XML parser chunk boundaries', async () => {
      const text = 'Cedar 中 & '.repeat(9000)
      const buf = await workbookBuffer([{ name: 'sheet1.xml', rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>${text.replaceAll('&', '&amp;')}</t></is></c></row>` }])
      expect(await extractText('/tmp/book.xlsx', buf)).toBe(text.trim())
    })

    it('rejects missing referenced shared strings and malformed sheet XML', async () => {
      const missing = await workbookBuffer([{ name: 'sheet1.xml', rows: '<row><c t="s"><v>8</v></c></row>' }], '<si><t>Only entry</t></si>')
      await expect(extractText('/tmp/book.xlsx', missing)).rejects.toThrow('shared string 8 is missing')
      const malformed = await workbookBuffer([{ name: 'sheet1.xml', rows: '<row><c><v>12</c></row>' }])
      await expect(extractText('/tmp/book.xlsx', malformed)).rejects.toThrow()
    })

    it.each(['"Hidden entity text"', 'SYSTEM "file:///acceptance-nonexistent-entity"'])('does not expand a declared XML entity (%s)', async (entity) => {
      const buf = await workbookBuffer([{ name: 'sheet1.xml', rows: '<row><c t="inlineStr"><is><t>&external;</t></is></c></row>' }])
      const zip = await JSZip.loadAsync(buf)
      const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
      zip.file('xl/worksheets/sheet1.xml', `<!DOCTYPE worksheet [<!ENTITY external ${entity}>]>${sheet}`)
      await expect(extractText('/tmp/book.xlsx', await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('Invalid character entity')
    })

    it('does not treat an orphan shared-string table as workbook content', async () => {
      const buf = await zipBuffer({ 'xl/sharedStrings.xml': '<sst><si><t>Ghost content</t></si></sst>' })
      await expect(extractText('/tmp/book.xlsx', buf)).rejects.toThrow('Spreadsheet part is missing')
    })
  })

  describe('malformed inputs', () => {
    it('throws on a malformed zip for OOXML formats', async () => {
      const garbage = Buffer.from('definitely not a zip archive')
      await expect(extractText('/tmp/x.docx', garbage)).rejects.toThrow()
      await expect(extractText('/tmp/x.pptx', garbage)).rejects.toThrow()
      await expect(extractText('/tmp/x.xlsx', garbage)).rejects.toThrow()
    })

    it('throws on an invalid PDF', async () => {
      await expect(extractText('/tmp/x.pdf', Buffer.from('not a pdf'))).rejects.toThrow()
    })
  })
})
