import type { Response as ExpressResponse } from 'express'
import { describe, expect, it } from 'vitest'
import { runInterceptors, type InterceptorContext } from '../../../src/main/openai-compat-router/interceptors'
import type { AnthropicContentBlock, AnthropicImageBlock, AnthropicRequest } from '../../../src/main/openai-compat-router/types'

const context: InterceptorContext = { originalModel: 'text-only', stripImages: true, res: {} as ExpressResponse }
const image = (data = 'image-data'): AnthropicImageBlock => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })
const request = (): AnthropicRequest => ({
  model: 'text-only', max_tokens: 100,
  messages: [
    { role: 'user', content: 'Please inspect this.' },
    { role: 'user', content: [{ type: 'text', text: 'Attached image' }, image()] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'screenshot', name: 'browser_screenshot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'screenshot', is_error: false, content: [{ type: 'text', text: 'Screenshot captured' }, image(), image()] }] }
  ]
})

async function transform(input: AnthropicRequest, ctx = context) {
  const result = await runInterceptors(input, ctx)
  if ('responded' in result) throw new Error('Unexpected terminal interceptor')
  return result
}

describe('image budget and passthrough capability', () => {
  it('replaces unsupported user and tool images without changing the original history or untouched objects', async () => {
    const input = request()
    const original = JSON.stringify(input)
    const result = await transform(input)
    expect(result.intercepted).toBe(true)
    expect(JSON.stringify(result.request)).not.toContain('image-data')
    expect(JSON.stringify(result.request).match(/current model cannot view images/g)).toHaveLength(3)
    expect(result.request.messages[0]).toBe(input.messages[0])
    expect(result.request.messages[2]).toBe(input.messages[2])
    expect((result.request.messages[1].content as unknown[])[0]).toBe((input.messages[1].content as unknown[])[0])
    expect(result.request.messages[3].content).toMatchObject([{ tool_use_id: 'screenshot', is_error: false, content: [{ text: 'Screenshot captured' }, { type: 'text' }, { type: 'text' }] }])
    expect(JSON.stringify(input)).toBe(original)
  })

  it('replaces URL images only for the unsupported-image policy and preserves cache markers', async () => {
    const urlImage: AnthropicImageBlock = { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' }, cache_control: { type: 'ephemeral' } }
    const input = request()
    input.messages = [{ role: 'user', content: [urlImage, { type: 'tool_result', tool_use_id: 'screenshot', content: [urlImage] }] }]
    const normal = await transform(input, { ...context, stripImages: false })
    expect(normal.intercepted).toBe(false)
    expect(normal.request).toBe(input)

    const result = await transform(input)
    const placeholder = { type: 'text', text: expect.stringContaining('cannot view images'), cache_control: { type: 'ephemeral' } }
    expect(result.request.messages[0].content).toEqual([placeholder, { type: 'tool_result', tool_use_id: 'screenshot', content: [placeholder] }])
    expect(input.messages[0].content).toEqual([urlImage, { type: 'tool_result', tool_use_id: 'screenshot', content: [urlImage] }])
  })

  it.each([undefined, false])('keeps under-budget images when stripImages is %s', async stripImages => {
    const input = request()
    const result = await transform(input, { ...context, stripImages })
    expect(result.intercepted).toBe(false)
    expect(result.request).toBe(input)
  })

  it.each([false, true])('returns the same request when there are no images (stripImages: %s)', async stripImages => {
    const input = request()
    input.messages = [input.messages[0], input.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'screenshot', content: [{ type: 'text', text: 'File contents' }] }] }]
    const result = await transform(input, { ...context, stripImages })
    expect(result.request).toBe(input)
    expect(result.intercepted).toBe(false)
  })

  it('uses the same history scan with or without the unsupported-image policy when no images are present', async () => {
    const reads: number[] = []
    for (const stripImages of [false, true]) {
      let count = 0
      const text = (): AnthropicContentBlock => ({ get type() { count++; return 'text' as const }, text: 'No image here' })
      const input = request()
      input.messages = Array.from({ length: 100 }, () => ({
        role: 'user' as const,
        content: [text(), { type: 'tool_result' as const, tool_use_id: 'read', content: [text()] }]
      }))
      await transform(input, { ...context, stripImages })
      reads.push(count)
    }
    expect(reads[0]).toBeGreaterThan(0)
    expect(reads[1]).toBe(reads[0])
  })

  it('removes every unsupported image in one policy decision regardless of payload size', async () => {
    const input = request()
    input.messages[1].content = [image('x'.repeat(4 * 1024 * 1024))]
    const result = await transform(input)
    expect(JSON.stringify(result.request)).not.toContain('exceeded image budget')
    expect(JSON.stringify(result.request).match(/current model cannot view images/g)).toHaveLength(3)
  })

  it('evicts only the oldest base64 images for ordinary budgets and preserves original data and cache markers', async () => {
    const input = request()
    const cached = { ...image('x'.repeat(4 * 1024 * 1024)), cache_control: { type: 'ephemeral' as const } }
    const urlImage: AnthropicImageBlock = { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } }
    input.messages[1].content = [cached, urlImage]
    const result = await transform(input, { ...context, stripImages: false })
    expect(result.request.messages[1].content).toEqual([
      { type: 'text', text: expect.stringContaining('exceeded image budget'), cache_control: { type: 'ephemeral' } },
      urlImage
    ])
    expect(result.request.messages[3]).toBe(input.messages[3])
    expect(input.messages[1].content).toEqual([cached, urlImage])
  })
})
