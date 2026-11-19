import type { ElectronApplication } from '@playwright/test'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'

export const pdfDistributionText = ['PDF distribution reference', '中文知识测试', 'Second page reference 87261345.25']

export function distributionPdf() {
  const stream = (body: string) => `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}endstream`
  const page = (content: number) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /Latin 5 0 R /Chinese 6 0 R >> /XObject << /Image 8 0 R >> >> /Contents ${content} 0 R >>`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    page(9), page(10),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [7 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 /FontDescriptor 11 0 R >>',
    '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 24 /Filter /ASCIIHexDecode >>\nstream\nE018301090501860E0E8B810>\nendstream',
    stream('BT /Latin 18 Tf 32 350 Td (PDF distribution reference) Tj ET\nBT /Chinese 24 Tf 32 300 Td <4E2D658777E58BC66D4B8BD5> Tj ET\nq 128 0 0 128 32 120 cm /Image Do Q\n'),
    stream('BT /Latin 16 Tf 32 350 Td (Second page reference 87261345.25) Tj ET\n0.1 0.7 0.4 rg 32 120 128 128 re f\n'),
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const start = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return { name: 'distribution-reference.pdf', bytes: Buffer.from(pdf, 'latin1') }
}

export async function validateDistributionPdf(bytes: Buffer) {
  const { getDocumentProxy, extractText } = await import('unpdf')
  const require = createRequire(import.meta.url)
  const cMapUrl = join(dirname(require.resolve('pdfjs-dist/package.json')), 'cmaps') + sep
  const document = await getDocumentProxy(new Uint8Array(bytes), { cMapUrl, cMapPacked: true })
  try {
    if (document.numPages !== 2) throw new Error('The independent PDF reader did not find both pages')
    const extracted = await extractText(document, { mergePages: true })
    for (const text of pdfDistributionText) if (!extracted.text.includes(text)) throw new Error(`The independent PDF reader did not extract ${text}`)
    return extracted.text
  } finally { await document.destroy() }
}

export async function assertPackagedWithoutNativeCanvas(application: ElectronApplication) {
  const observation = await application.evaluate(({ app }) => {
    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const path = process.getBuiltinModule('node:path') as typeof import('node:path')
    const root = app.getAppPath()
    const matches: string[] = []
    let visited = 0
    const visit = (directory: string) => {
      if (!fs.existsSync(directory)) return
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (++visited > 150000) throw new Error('Packaged canvas inventory exceeded its bounded entry budget')
        const target = path.join(directory, entry.name)
        if (entry.name === '@napi-rs') for (const item of fs.readdirSync(target)) if (item === 'canvas' || item.startsWith('canvas-')) matches.push(path.relative(root, path.join(target, item)))
        if (entry.isDirectory() && !entry.isSymbolicLink()) visit(target)
      }
    }
    if (!app.isPackaged) throw new Error('PDF distribution acceptance requires the controlled packaged application')
    visit(path.join(root, 'node_modules'))
    visit(path.join(process.resourcesPath, 'office-runtime'))
    visit(path.join(process.resourcesPath, 'dsh-runtime'))
    if (matches.length) throw new Error(`The packaged application still contains native canvas: ${matches.join(', ')}`)
    return { packaged: app.isPackaged, nativeCanvas: matches, visited }
  })
  return observation
}
