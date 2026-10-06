import { describe, expect, it } from 'vitest'
import { convertAnthropicMessagesToOpenAIChat } from '../../../src/main/openai-compat-router/converters/messages'
import type { AnthropicContentBlock, AnthropicImageBlock, AnthropicMessage } from '../../../src/main/openai-compat-router/types'

const image: AnthropicImageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2UtZml4dHVyZQ==' }
}
const imageUrl = 'data:image/png;base64,aW1hZ2UtZml4dHVyZQ=='

function toolConversation(content: string | AnthropicContentBlock[]): AnthropicMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'capture', name: 'screenshot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'capture', content }] }
  ]
}

describe('Chat tool-result images', () => {
  it('uses the vision channel for an image-only tool result', () => {
    const messages = toolConversation([image])

    const result = convertAnthropicMessagesToOpenAIChat(messages, undefined)

    expect(result.hasImages).toBe(true)
    expect(result.messages.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'capture', content: '[]' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }] }
    ])
  })

  it('keeps every tool response before images and preserves mixed content', () => {
    const remoteImage: AnthropicImageBlock = {
      type: 'image', source: { type: 'url', url: 'https://example.com/capture.png' }
    }
    const messages: AnthropicMessage[] = [
      { role: 'assistant', content: ['first', 'second'].map(id => ({ type: 'tool_use', id, name: 'screenshot', input: {} })) },
      { role: 'user', content: [
        { type: 'text', text: 'compare' },
        { type: 'tool_result', tool_use_id: 'first', content: [
          { type: 'text', text: 'before' }, image, { type: 'text', text: 'after' }, remoteImage
        ] },
        { type: 'tool_result', tool_use_id: 'second', is_error: true, content: [remoteImage] },
        image
      ] },
      { role: 'assistant', content: 'done' }
    ]

    const result = convertAnthropicMessagesToOpenAIChat(messages, undefined)

    expect(result.messages.map(message => message.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'user', 'assistant'])
    expect(result.messages.slice(1, 3)).toEqual([
      { role: 'tool', tool_call_id: 'first', content: JSON.stringify([{ type: 'text', text: 'before' }, { type: 'text', text: 'after' }]) },
      { role: 'tool', tool_call_id: 'second', content: '[]' }
    ])
    expect(result.messages[3]).toEqual({ role: 'user', content: [
      { type: 'image_url', image_url: { url: imageUrl } },
      { type: 'image_url', image_url: { url: 'https://example.com/capture.png' } },
      { type: 'image_url', image_url: { url: 'https://example.com/capture.png' } }
    ] })
    expect(result.messages[4]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'compare' }, { type: 'image_url', image_url: { url: imageUrl } }
    ] })
    expect(result.hasImages).toBe(true)
  })

  it.each([false, true])('routes tool and direct images according to stripImages=%s', stripImages => {
    const messages = toolConversation([{ type: 'text', text: 'captured' }, image])
    messages.push({ role: 'user', content: [image] })

    const result = convertAnthropicMessagesToOpenAIChat(messages, undefined, { stripImages })

    const visionParts = result.messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(part => part.type === 'image_url') : [])
    expect(visionParts).toHaveLength(stripImages ? 0 : 2)
    expect(result.messages[1]).toEqual({
      role: 'tool', tool_call_id: 'capture', content: JSON.stringify([{ type: 'text', text: 'captured' }])
    })
    expect(result.hasImages).toBe(true)
  })

  it('retains an image-only tool response when images are stripped', () => {
    const result = convertAnthropicMessagesToOpenAIChat(toolConversation([image]), undefined, { stripImages: true })

    expect(result.messages.slice(1)).toEqual([{ role: 'tool', tool_call_id: 'capture', content: '[]' }])
    expect(result.hasImages).toBe(true)
  })

  it.each([
    { content: 'plain text' },
    { content: [{ type: 'text', text: 'block text' }] },
    { content: [] }
  ] satisfies { content: string | AnthropicContentBlock[] }[])(
    'preserves text-only tool content $content', ({ content }) => {
      const result = convertAnthropicMessagesToOpenAIChat(toolConversation(content), undefined)

      expect(result.messages.slice(1)).toEqual([{
        role: 'tool', tool_call_id: 'capture', content: typeof content === 'string' ? content : JSON.stringify(content)
      }])
      expect(result.hasImages).toBe(false)
    }
  )

  it.each([false, true])('leaves caller input and cached image data unchanged with stripImages=%s', stripImages => {
    const messages = toolConversation([image])
    const snapshot = JSON.stringify(messages)
    Object.freeze(image.source)
    Object.freeze(image)

    convertAnthropicMessagesToOpenAIChat(messages, undefined, { stripImages })

    expect(JSON.stringify(messages)).toBe(snapshot)
    expect(image.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'aW1hZ2UtZml4dHVyZQ==' })
  })
})
