import { describe, expect, it } from 'vitest'
import {
  convertAnthropicMessagesToOpenAIChat,
  convertAnthropicMessagesToResponsesInput
} from '../../../src/main/openai-compat-router/converters/messages'
import type { AnthropicContentBlock, AnthropicImageBlock, AnthropicMessage } from '../../../src/main/openai-compat-router/types'

const image: AnthropicImageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2UtZml4dHVyZQ==' }
}
const imageUrl = 'data:image/png;base64,aW1hZ2UtZml4dHVyZQ=='
const remoteImage: AnthropicImageBlock = {
  type: 'image', source: { type: 'url', url: 'https://example.com/capture.png' }
}

function toolConversation(content: string | AnthropicContentBlock[]): AnthropicMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'capture', name: 'screenshot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'capture', content }] }
  ]
}

function mixedConversation(): AnthropicMessage[] {
  return [
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
}

const mixedToolText = JSON.stringify([{ type: 'text', text: 'before' }, { type: 'text', text: 'after' }])
const oneImageMoved = 'Image attached in the following user message.'

// Arrives from transcripts written by other clients; must not break conversion.
const sourceless = { type: 'image' } as unknown as AnthropicImageBlock

describe('Chat tool-result images', () => {
  it('uses the vision channel for an image-only tool result', () => {
    const messages = toolConversation([image])

    const result = convertAnthropicMessagesToOpenAIChat(messages, undefined)

    expect(result.hasImages).toBe(true)
    expect(result.messages.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'capture', content: oneImageMoved },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }] }
    ])
  })

  it('counts the images an image-only tool result moved', () => {
    const result = convertAnthropicMessagesToOpenAIChat(toolConversation([image, remoteImage]), undefined)

    expect(result.messages[1]).toEqual({
      role: 'tool', tool_call_id: 'capture', content: '2 images attached in the following user message.'
    })
  })

  it('skips an image without a source instead of failing the request', () => {
    const onlySourceless = convertAnthropicMessagesToOpenAIChat(toolConversation([sourceless]), undefined)
    expect(onlySourceless.messages.slice(1)).toEqual([{ role: 'tool', tool_call_id: 'capture', content: '[]' }])

    const withOther = convertAnthropicMessagesToOpenAIChat(toolConversation([sourceless, image]), undefined)
    expect(withOther.messages.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'capture', content: oneImageMoved },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }] }
    ])
  })

  it('answers every tool call first, then sends tool images and user content as one user message', () => {
    const result = convertAnthropicMessagesToOpenAIChat(mixedConversation(), undefined)

    expect(result.messages.map(message => message.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'assistant'])
    expect(result.messages.slice(1, 3)).toEqual([
      { role: 'tool', tool_call_id: 'first', content: mixedToolText },
      { role: 'tool', tool_call_id: 'second', content: oneImageMoved }
    ])
    expect(result.messages[3]).toEqual({ role: 'user', content: [
      { type: 'image_url', image_url: { url: imageUrl } },
      { type: 'image_url', image_url: { url: 'https://example.com/capture.png' } },
      { type: 'image_url', image_url: { url: 'https://example.com/capture.png' } },
      { type: 'text', text: 'compare' },
      { type: 'image_url', image_url: { url: imageUrl } }
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

describe('Responses tool-result images', () => {
  const callOf = { type: 'function_call', call_id: 'capture', name: 'screenshot', arguments: '{}' }

  it('uses the vision channel for an image-only tool result', () => {
    const result = convertAnthropicMessagesToResponsesInput(toolConversation([image]), undefined)

    expect(result).toEqual([
      callOf,
      { type: 'function_call_output', call_id: 'capture', output: oneImageMoved },
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: imageUrl }] }
    ])
  })

  it('counts the images an image-only tool result moved', () => {
    const result = convertAnthropicMessagesToResponsesInput(toolConversation([image, remoteImage]), undefined)

    expect(result[1]).toEqual({
      type: 'function_call_output', call_id: 'capture', output: '2 images attached in the following user message.'
    })
  })

  it('skips an image without a source instead of failing the request', () => {
    const onlySourceless = convertAnthropicMessagesToResponsesInput(toolConversation([sourceless]), undefined)
    expect(onlySourceless).toEqual([callOf, { type: 'function_call_output', call_id: 'capture', output: '[]' }])

    const withOther = convertAnthropicMessagesToResponsesInput(toolConversation([sourceless, image]), undefined)
    expect(withOther.slice(1)).toEqual([
      { type: 'function_call_output', call_id: 'capture', output: oneImageMoved },
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: imageUrl }] }
    ])

    const direct = convertAnthropicMessagesToResponsesInput([{ role: 'user', content: [{ type: 'text', text: 'look' }, sourceless] }], undefined)
    expect(direct).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }] }])
  })

  it('answers every tool call first, then sends tool images and user content as one user message', () => {
    const result = convertAnthropicMessagesToResponsesInput(mixedConversation(), undefined)

    expect(result.map(item => item.type === 'message' ? item.role : item.type)).toEqual([
      'function_call', 'function_call', 'function_call_output', 'function_call_output', 'user', 'assistant'
    ])
    expect(result.slice(2, 4)).toEqual([
      { type: 'function_call_output', call_id: 'first', output: mixedToolText },
      { type: 'function_call_output', call_id: 'second', output: oneImageMoved }
    ])
    expect(result[4]).toEqual({ type: 'message', role: 'user', content: [
      { type: 'input_image', image_url: imageUrl },
      { type: 'input_image', image_url: 'https://example.com/capture.png' },
      { type: 'input_image', image_url: 'https://example.com/capture.png' },
      { type: 'input_text', text: 'compare' },
      { type: 'input_image', image_url: imageUrl }
    ] })
  })

  it.each([false, true])('routes tool and direct images according to stripImages=%s', stripImages => {
    const messages = toolConversation([{ type: 'text', text: 'captured' }, image])
    messages.push({ role: 'user', content: [image] })

    const result = convertAnthropicMessagesToResponsesInput(messages, undefined, { stripImages })

    const visionParts = result.flatMap(item => item.type === 'message' && Array.isArray(item.content)
      ? item.content.filter(part => part.type === 'input_image') : [])
    expect(visionParts).toHaveLength(stripImages ? 0 : 2)
    expect(result[1]).toEqual({
      type: 'function_call_output', call_id: 'capture', output: JSON.stringify([{ type: 'text', text: 'captured' }])
    })
  })

  it('retains an image-only tool output when images are stripped', () => {
    const result = convertAnthropicMessagesToResponsesInput(toolConversation([image]), undefined, { stripImages: true })

    expect(result).toEqual([callOf, { type: 'function_call_output', call_id: 'capture', output: '[]' }])
  })

  it.each([
    { content: 'plain text' },
    { content: [{ type: 'text', text: 'block text' }] },
    { content: [] }
  ] satisfies { content: string | AnthropicContentBlock[] }[])(
    'preserves text-only tool output $content', ({ content }) => {
      const result = convertAnthropicMessagesToResponsesInput(toolConversation(content), undefined)

      expect(result).toEqual([callOf, {
        type: 'function_call_output', call_id: 'capture', output: typeof content === 'string' ? content : JSON.stringify(content)
      }])
    }
  )
})
