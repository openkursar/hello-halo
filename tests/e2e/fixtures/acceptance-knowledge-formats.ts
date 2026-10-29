import JSZip from 'jszip'
import * as XLSX from 'xlsx'

export type KnowledgeDocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'html'

export interface KnowledgeDocument {
  name: string
  bytes: Buffer
  expectedText: string[]
}

const quantity = 87261345.25

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function textPdf(lines: string[]): Buffer {
  if (lines.some(line => /[^\x20-\x7e]/.test(line))) throw new Error('The built-in Helvetica fixture accepts printable ASCII text only')
  const text = lines.map((line, index) => `${index ? '0 -24 Td\n' : ''}(${line.replace(/[\\()]/g, '\\$&')}) Tj`).join('\n')
  const stream = `BT\n/F1 12 Tf\n36 740 Td\n${text}\nET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

async function wordDocument(lines: string[]): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  const paragraphs = lines.map(line => `<w:p><w:r><w:t xml:space="preserve">${xmlText(line)}</w:t></w:r></w:p>`).join('')
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

export async function knowledgeDocument(format: KnowledgeDocumentFormat, marker: string, workbookStrings: 'shared' | 'cell' = 'shared'): Promise<KnowledgeDocument> {
  const expectedText = [marker, String(quantity)]
  const lines = ['Offline knowledge reference', marker, `Quantity: ${quantity}`, 'Review: Alpha & Beta < Gamma']
  let bytes: Buffer
  switch (format) {
    case 'pdf':
      bytes = textPdf(lines)
      break
    case 'docx':
      bytes = await wordDocument(lines)
      break
    case 'xlsx': {
      const workbook = XLSX.utils.book_new()
      const sheet = XLSX.utils.aoa_to_sheet([['Field', 'Value'], ['Reference', marker], ['Quantity', quantity]])
      XLSX.utils.book_append_sheet(workbook, sheet, 'Reference')
      bytes = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', bookSST: workbookStrings === 'shared', compression: true }))
      break
    }
    case 'csv':
      bytes = Buffer.from(`Field,Value\r\nReference,"${marker.replaceAll('"', '""')}"\r\nQuantity,${quantity}\r\n`)
      break
    case 'html':
      bytes = Buffer.from(`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Offline knowledge reference</title></head><body><article><h1>Offline knowledge reference</h1><p>${xmlText(marker)}</p><dl><dt>Quantity</dt><dd>${quantity}</dd></dl></article></body></html>\n`)
      break
  }
  return { name: `imported-reference${format === 'xlsx' ? `-${workbookStrings}` : ''}.${format}`, bytes, expectedText }
}
