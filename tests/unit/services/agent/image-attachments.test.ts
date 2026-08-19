/**
 * Non-vision image fallback — invariants under test:
 *   - vision resolution order matches the renderer gate and the compat router:
 *     explicit user override > provider-declared flag > model-id heuristic;
 *   - file names are content-addressed (same bytes → same path, re-send dedupes)
 *     with the extension the ocr_image tool accepts;
 *   - the fallback fires only for non-vision models with images: it persists
 *     the files and returns the prompt block (toolset/MCP availability is the
 *     caller's concern — see module header);
 *   - a missing space degrades to null (image blocks pass through unchanged).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const spaceRef = vi.hoisted(() => ({ value: null as { path: string; isTemp: boolean } | null }))

vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: vi.fn(() => spaceRef.value)
}))

import {
  modelAcceptsImages,
  attachmentFileName,
  formatImageAttachmentBlock,
  prepareNonVisionImageFallback
} from '../../../../src/main/services/agent/image-attachments'
import type { ApiCredentials, ImageAttachment } from '../../../../src/main/services/agent/types'

const creds = (overrides: Partial<ApiCredentials>): ApiCredentials => ({
  baseUrl: 'https://api.example.com',
  apiKey: 'k',
  model: 'deepseek-chat',
  provider: 'openai',
  ...overrides
})

const image = (overrides: Partial<ImageAttachment> = {}): ImageAttachment => ({
  id: 'img-1',
  type: 'image',
  mediaType: 'image/png',
  data: Buffer.from('fake-png-bytes').toString('base64'),
  name: 'shot.png',
  ...overrides
})

const scope = { spaceId: 'space-1', conversationId: 'conv-1', workDir: '/tmp' }

beforeEach(() => {
  spaceRef.value = { path: mkdtempSync(join(tmpdir(), 'halo-attach-test-')), isTemp: false }
})

describe('modelAcceptsImages', () => {
  it('explicit user override wins over everything', () => {
    expect(modelAcceptsImages(creds({ visionOverride: true, supportsVision: false }))).toBe(true)
    expect(modelAcceptsImages(creds({ visionOverride: false, supportsVision: true, model: 'gpt-4o' }))).toBe(false)
  })

  it('provider-declared flag wins over the id heuristic', () => {
    expect(modelAcceptsImages(creds({ supportsVision: true, model: 'deepseek-chat' }))).toBe(true)
    expect(modelAcceptsImages(creds({ supportsVision: false, model: 'gpt-4o' }))).toBe(false)
  })

  it('falls back to the id heuristic: blacklisted → false, unknown → true', () => {
    expect(modelAcceptsImages(creds({ model: 'deepseek-chat' }))).toBe(false)
    expect(modelAcceptsImages(creds({ model: 'some-unknown-model' }))).toBe(true)
  })
})

describe('attachmentFileName', () => {
  it('is content-addressed with the media-type extension', () => {
    const a = attachmentFileName(image())
    const b = attachmentFileName(image({ id: 'img-2', name: 'other.png' }))
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}\.png$/)
    expect(attachmentFileName(image({ mediaType: 'image/jpeg' }))).toMatch(/\.jpg$/)
    expect(attachmentFileName(image({ data: Buffer.from('different').toString('base64') }))).not.toBe(a)
  })
})

describe('formatImageAttachmentBlock', () => {
  it('lists all paths and directs to ocr_image', () => {
    const block = formatImageAttachmentBlock([
      { path: '/a/1.png', name: 'one.png' },
      { path: '/a/2.jpg' }
    ])
    expect(block).toContain('<halo_attachments>')
    expect(block).toContain('2 images')
    expect(block).toContain('1. /a/1.png (one.png)')
    expect(block).toContain('2. /a/2.jpg')
    expect(block).toContain('ocr_image')
    // Read on an image file returns an image block into the loop — the block
    // must forbid it or non-vision upstreams 400 on the next inference round.
    expect(block).toContain('NEVER open these files with the Read tool')
    expect(formatImageAttachmentBlock([{ path: '/a/1.png' }])).toContain('1 image ')
  })

  it('reports images dropped by persistence failures', () => {
    expect(formatImageAttachmentBlock([{ path: '/a/1.png' }])).not.toContain('could not be saved')
    expect(formatImageAttachmentBlock([{ path: '/a/1.png' }], 2)).toContain('2 more images could not be saved')
  })
})

describe('prepareNonVisionImageFallback', () => {
  it('returns null when there are no images or the model has vision', () => {
    expect(prepareNonVisionImageFallback({ scope, credentials: creds({}), images: [] })).toBeNull()
    expect(
      prepareNonVisionImageFallback({ scope, credentials: creds({ model: 'gpt-4o' }), images: [image()] })
    ).toBeNull()
  })

  it('persists images under .halo/attachments and injects their paths', () => {
    const result = prepareNonVisionImageFallback({ scope, credentials: creds({}), images: [image()] })
    expect(result).not.toBeNull()

    const dir = join(spaceRef.value!.path, '.halo', 'attachments')
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    const filePath = join(dir, files[0])
    expect(readFileSync(filePath).toString()).toBe('fake-png-bytes')
    expect(result!.contextBlock).toContain(filePath)
  })

  it('re-sending the same image dedupes to a single file', () => {
    prepareNonVisionImageFallback({ scope, credentials: creds({}), images: [image()] })
    prepareNonVisionImageFallback({ scope, credentials: creds({}), images: [image({ id: 'img-9' })] })
    const dir = join(spaceRef.value!.path, '.halo', 'attachments')
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('temp spaces keep attachments at the space root (no .halo nesting)', () => {
    spaceRef.value!.isTemp = true
    prepareNonVisionImageFallback({ scope, credentials: creds({}), images: [image()] })
    expect(existsSync(join(spaceRef.value!.path, 'attachments'))).toBe(true)
    expect(existsSync(join(spaceRef.value!.path, '.halo'))).toBe(false)
  })

  it('degrades to null when the space is unknown', () => {
    spaceRef.value = null
    expect(prepareNonVisionImageFallback({ scope, credentials: creds({}), images: [image()] })).toBeNull()
  })
})
