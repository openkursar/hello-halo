/**
 * OCR Engine Unit Tests
 *
 * tesseract.js is mocked — no real OCR runs. Covers CJK space collapsing
 * (via ocrImage output), worker reuse, and graceful degradation when the
 * engine fails to initialize or recognition throws.
 *
 * The module caches its worker promise, so each test resets the module
 * registry and re-imports engine.ts fresh.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

type RecognizeResult = { data: { text: string } }

let createWorkerImpl: () => Promise<{
  recognize: (buf: Buffer) => Promise<RecognizeResult>
  terminate?: () => Promise<void>
}>

vi.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => {
    void args
    return createWorkerImpl()
  },
}))

async function importOcr() {
  vi.resetModules()
  return import('../../../../src/main/services/ocr/engine')
}

describe('OCR engine', () => {
  beforeEach(() => {
    // The setup mock reports app.isPackaged=true, so tessdataDir resolves via
    // process.resourcesPath — undefined outside Electron. Point it at a dummy.
    // defineProperty (not plain assignment) so it survives environments where a
    // dependency has already installed resourcesPath as a read-only property.
    Object.defineProperty(process, 'resourcesPath', {
      value: '/tmp/halo-test-resources',
      configurable: true,
      writable: true,
    })
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

  it('shutdownOcr terminates the cached worker and a later image re-creates it', async () => {
    const terminate = vi.fn(async () => {})
    const factory = vi.fn(async () => ({
      recognize: async () => ({ data: { text: 'text' } }),
      terminate,
    }))
    createWorkerImpl = factory
    const { ocrImage, shutdownOcr } = await importOcr()
    await ocrImage(Buffer.from('a'))
    await shutdownOcr()
    expect(terminate).toHaveBeenCalledTimes(1)

    await ocrImage(Buffer.from('b'))
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('shutdownOcr is a no-op when no worker was ever created', async () => {
    const factory = vi.fn(async () => ({
      recognize: async () => ({ data: { text: '' } }),
    }))
    createWorkerImpl = factory
    const { shutdownOcr } = await importOcr()
    await expect(shutdownOcr()).resolves.toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
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
