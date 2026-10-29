import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { unzipSync, strFromU8 } from 'fflate'
import { DOMParser } from '@xmldom/xmldom'
import { extractText, getDocumentProxy, getResolvedPDFJS } from 'unpdf'

const directory = await mkdtemp(path.join(tmpdir(), 'acceptance-preview-documents-'))
after(() => rm(directory, { recursive: true, force: true }))
const compiled = path.join(directory, 'documents.cjs')
await build({ entryPoints: [fileURLToPath(new URL('../../e2e/fixtures/acceptance-preview-documents.ts', import.meta.url))], outfile: compiled, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
const { previewPdf, previewPresentation } = createRequire(import.meta.url)(compiled)

test('the PDF reader resolves one square page, its text and all 64 independently decoded colored cells', async () => {
  const marker = '0123456789abcdefFEDCBA9876543210'
  const fixture = previewPdf(marker)
  const pdf = await getDocumentProxy(new Uint8Array(fixture.bytes))
  try {
    assert.equal(pdf.numPages, 1)
    const extracted = await extractText(pdf, { mergePages: true })
    assert.equal(extracted.totalPages, 1)
    assert.ok(extracted.text.includes(marker))
    assert.ok(extracted.text.includes('87261345.25'))
    const page = await pdf.getPage(1)
    assert.deepEqual(page.view, [0, 0, 400, 400])
    const list = await page.getOperatorList()
    const { OPS } = await getResolvedPDFJS()
    const palette = fixture.palette.map(color => `#${color.map(channel => channel.toString(16).padStart(2, '0')).join('')}`)
    const decoded = []
    let fill
    for (const [index, operation] of list.fnArray.entries()) {
      const args = list.argsArray[index]
      if (operation === OPS.setFillRGBColor) fill = args[0]
      if (operation !== OPS.constructPath) continue
      const color = palette.indexOf(fill)
      assert.ok(color >= 0, `Unexpected parsed fill color ${fill}`)
      const x = 72 + decoded.length % 8 * 32
      const y = 400 - 72 - (Math.floor(decoded.length / 8) + 1) * 32
      assert.equal(args[0], OPS.fill)
      assert.deepEqual(Array.from(args[2]), [x, y, x + 32, y + 32])
      assert.equal(args[1].length, 1)
      assert.deepEqual(Array.from(args[1][0]), [0, x, y, 1, x + 32, y, 1, x + 32, y + 32, 1, x, y + 32, 4])
      decoded.push(color)
    }
    const expected = [...Buffer.from(marker, 'hex')].flatMap(byte => [byte >>> 6, byte >>> 4 & 3, byte >>> 2 & 3, byte & 3])
    assert.equal(decoded.length, 64)
    assert.deepEqual(decoded, expected)
    assert.deepEqual(fixture.pattern, expected)
    const reconstructed = decoded.reduce((bytes, value, index) => {
      bytes[Math.floor(index / 4)] |= value << (6 - index % 4 * 2)
      return bytes
    }, Buffer.alloc(16)).toString('hex')
    assert.equal(reconstructed, marker.toLowerCase())
  } finally { await pdf.destroy() }
})

test('the PDF marker cannot overflow the fixed grid or enter the PDF syntax', () => {
  for (const marker of ['', '0'.repeat(31), '0'.repeat(33), 'g'.repeat(32), `${'0'.repeat(31)}\n`]) {
    assert.throws(() => previewPdf(marker), /32-digit hexadecimal marker/)
  }
})

const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
const officeRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function readPresentation(bytes) {
  const files = unzipSync(new Uint8Array(bytes))
  const xml = new Map()
  const fail = message => { throw new Error(`Invalid fixture XML: ${message}`) }
  const parser = new DOMParser({ errorHandler: { warning: fail, error: fail, fatalError: fail } })
  for (const [name, contents] of Object.entries(files)) {
    if (/\.(?:xml|rels)$/.test(name)) xml.set(name, parser.parseFromString(strFromU8(contents), 'application/xml'))
  }
  for (const [name, document] of xml) {
    if (!name.endsWith('.rels')) continue
    const owner = name === '_rels/.rels' ? '' : path.posix.dirname(name.replace('/_rels/', '/').replace(/\.rels$/, ''))
    for (const relation of Array.from(document.getElementsByTagNameNS(relationships, 'Relationship'))) {
      assert.notEqual(relation.getAttribute('TargetMode'), 'External')
      const target = path.posix.normalize(path.posix.join(owner, relation.getAttribute('Target')))
      assert.ok(!target.startsWith('../') && files[target], `Missing or escaped relationship target ${target}`)
    }
  }
  return { files, xml }
}

test('an independent ZIP and XML reader follows the presentation, slide, layout, master and theme', async () => {
  const marker = 'Preview & review <reference> "42"'
  const fixture = await previewPresentation(marker)
  const { files, xml } = readPresentation(fixture.bytes)
  assert.equal(fixture.name, 'preview-presentation.pptx')
  const root = xml.get('ppt/presentation.xml')
  assert.equal(root.documentElement.namespaceURI, presentation)
  const slides = root.getElementsByTagNameNS(presentation, 'sldId')
  assert.equal(slides.length, 1)
  const slideId = slides[0].getAttributeNS(officeRelationships, 'id')
  const slideRelation = Array.from(xml.get('ppt/_rels/presentation.xml.rels').getElementsByTagNameNS(relationships, 'Relationship')).find(relation => relation.getAttribute('Id') === slideId)
  assert.equal(slideRelation.getAttribute('Type'), `${officeRelationships}/slide`)
  const slide = xml.get(path.posix.join('ppt', slideRelation.getAttribute('Target')))
  assert.deepEqual(Array.from(slide.getElementsByTagNameNS(drawing, 't')).map(text => text.textContent), ['Preview presentation', marker, 'Quantity 87261345.25'])
  assert.equal(slide.getElementsByTagNameNS(presentation, 'sp').length, 1)
  assert.ok(xml.get('ppt/slideLayouts/slideLayout1.xml').getElementsByTagNameNS(presentation, 'cSld').length)
  assert.ok(xml.get('ppt/slideMasters/slideMaster1.xml').getElementsByTagNameNS(presentation, 'sldLayoutId').length)
  assert.ok(xml.get('ppt/theme/theme1.xml').getElementsByTagNameNS(drawing, 'themeElements').length)
  const types = xml.get('[Content_Types].xml')
  for (const override of Array.from(types.getElementsByTagNameNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override'))) {
    assert.ok(files[override.getAttribute('PartName').slice(1)])
  }
})
