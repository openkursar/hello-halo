/**
 * Tlon Extract Unit Tests
 *
 * Extension classification and text extraction. OOXML fixtures (docx/pptx/xlsx)
 * are built in-test with jszip so no binary fixtures are checked in.
 */

import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'

import {
  fileExtension,
  isImage,
  isExtractable,
  extractText,
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
    it('extracts the shared string table, one entry per line', async () => {
      const buf = await zipBuffer({
        'xl/sharedStrings.xml':
          '<sst count="3" uniqueCount="3">' +
          '<si><t>Header</t></si>' +
          '<si><t xml:space="preserve">Cell &amp; value</t></si>' +
          '<si><r><t>Rich</t></r></si>' +
          '</sst>',
      })
      const text = await extractText('/tmp/book.xlsx', buf)
      expect(text).toBe('Header\nCell & value\nRich')
    })

    it('returns empty string when there is no shared string table', async () => {
      const buf = await zipBuffer({ 'xl/workbook.xml': '<workbook/>' })
      expect(await extractText('/tmp/book.xlsx', buf)).toBe('')
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
