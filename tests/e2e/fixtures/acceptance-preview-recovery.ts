import { previewDocument } from './acceptance-preview-formats'

export async function damagedPreviewDocument(marker: string) {
  const valid = await previewDocument('docx', marker)
  const damaged = Buffer.from(valid.bytes.subarray(0, Math.floor(valid.bytes.length / 2)))
  return {
    valid: { name: 'readable-reference.docx', bytes: valid.bytes },
    damaged: { name: 'truncated-reference.docx', bytes: damaged },
  }
}
