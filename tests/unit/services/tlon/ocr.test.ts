/**
 * Tlon OCR Unit Tests
 *
 * tesseract.js is mocked — no real OCR runs. Covers CJK space collapsing
 * (via ocrImage output), worker reuse, and graceful degradation when the
 * engine fails to initialize or recognition throws.
 *
 * The module caches its worker promise, so each test resets the module
 * registry and re-imports ocr.ts fresh.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

type RecognizeResult = { data: { text: string } }

let createWorkerImpl: () => Promise<{ recognize: (buf: Buffer) => Promise<RecognizeResult> }>

vi.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => {
    void args
    return createWorkerImpl()
  },
}))

async function importOcr() {
  vi.resetModules()
  return import('../../../../src/main/services/tlon/ocr')
}

describe('Tlon OCR', () => {
  beforeEach(() => {
    // The setup mock reports app.isPackaged=true, so tessdataDir resolves via
    // process.resourcesPath — undefined outside Electron. Point it at a dummy.
    ;(process as { resourcesPath?: string }).resourcesPath = '/tmp/halo-test-resources'
    createWorkerImpl = async () => ({
      recognize: async () => ({ data: { text: '' } }),
    })
  })

  it('collapses spaces between adjacent CJK characters but keeps CJK/Latin spacing', async () => {
    createWorkerImpl = async () => ({
      recognize: async () => ({ data: { text: ' 深 度 学 习 与 world peace 模 型 ' } }),
    })
    const { ocrImage } = await importOcr()
    expect(await ocrImage(Buffer.from('img'))).toBe('深度学习与 world peace 模型')
  })

  it('collapses across CJK punctuation and fullwidth ranges', async () => {
    createWorkerImpl = async () => ({
      recognize: async () => ({ data: { text: '你 好 ， 世 界 ！' } }),
    })
    const { ocrImage } = await importOcr()
    expect(await ocrImage(Buffer.from('img'))).toBe('你好，世界！')
  })

  it('leaves pure Latin text untouched', async () => {
    createWorkerImpl = async () => ({
      recognize: async () => ({ data: { text: 'Hello OCR world\n' } }),
    })
    const { ocrImage } = await importOcr()
    expect(await ocrImage(Buffer.from('img'))).toBe('Hello OCR world')
  })

  it('reuses one worker across multiple images', async () => {
    const factory = vi.fn(async () => ({
      recognize: async () => ({ data: { text: 'text' } }),
    }))
    createWorkerImpl = factory
    const { ocrImage } = await importOcr()
    await ocrImage(Buffer.from('a'))
    await ocrImage(Buffer.from('b'))
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('returns empty string when the engine fails to initialize, and retries next call', async () => {
    const factory = vi.fn(async () => {
      throw new Error('wasm init failed')
    })
    createWorkerImpl = factory
    const { ocrImage } = await importOcr()
    expect(await ocrImage(Buffer.from('img'))).toBe('')
    // Failed init clears the cached promise so a later image retries.
    expect(await ocrImage(Buffer.from('img'))).toBe('')
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('returns empty string when recognition throws', async () => {
    createWorkerImpl = async () => ({
      recognize: async () => {
        throw new Error('bad image')
      },
    })
    const { ocrImage } = await importOcr()
    expect(await ocrImage(Buffer.from('img'))).toBe('')
  })
})
