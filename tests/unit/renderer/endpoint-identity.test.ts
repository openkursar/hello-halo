import { describe, expect, it } from 'vitest'

import { endpointIdentity } from '../../../src/renderer/utils/endpoint-identity'

describe('endpointIdentity', () => {
  it('treats path edits on the same origin as the same endpoint', () => {
    expect(endpointIdentity('https://api.deepseek.com'))
      .toBe(endpointIdentity('https://api.deepseek.com/v1'))
  })

  it('treats a different host, scheme or port as another endpoint', () => {
    const base = endpointIdentity('https://api.deepseek.com/v1')
    expect(endpointIdentity('https://api.openai.com/v1')).not.toBe(base)
    expect(endpointIdentity('http://api.deepseek.com/v1')).not.toBe(base)
    expect(endpointIdentity('https://api.deepseek.com:8443/v1')).not.toBe(base)
  })

  it('accepts an endpoint written without a scheme', () => {
    expect(endpointIdentity('api.deepseek.com/v1'))
      .toBe(endpointIdentity('https://api.deepseek.com'))
  })

  it('falls back to the trimmed value when the URL cannot be parsed', () => {
    expect(endpointIdentity('  not a url  ')).toBe('not a url')
    expect(endpointIdentity('   ')).toBe('')
  })
})
