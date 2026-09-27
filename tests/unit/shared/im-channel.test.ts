/**
 * Unit tests for classifySessionSource in shared/types/im-channel.ts.
 *
 * This classifier is the single gate that decides whether an external session
 * is pushable ('im') or read/write-only ('http'). It must be conservative: only
 * channels registered in IM_CHANNEL_TYPES are 'im'; everything else — the HTTP
 * channel and any unknown/future value — must resolve to 'http' so a non-IM
 * session can never leak into a proactive push path.
 */

import { describe, it, expect } from 'vitest'
import {
  classifySessionSource,
  imCredentialId,
  IM_CHANNEL_TYPES,
  HTTP_SESSION_CHANNEL,
} from '../../../src/shared/types/im-channel'

describe('classifySessionSource', () => {
  it('classifies every registered IM channel as "im"', () => {
    for (const channel of IM_CHANNEL_TYPES) {
      expect(classifySessionSource(channel)).toBe('im')
    }
  })

  it('classifies the HTTP channel as "http"', () => {
    expect(classifySessionSource(HTTP_SESSION_CHANNEL)).toBe('http')
    expect(classifySessionSource('http')).toBe('http')
  })

  it('classifies unknown / future channels as "http" (conservative)', () => {
    expect(classifySessionSource('sms')).toBe('http')
    expect(classifySessionSource('telegram-bot')).toBe('http')
    expect(classifySessionSource('')).toBe('http')
  })

  it('is case-sensitive: a mis-cased channel is not treated as IM', () => {
    expect(classifySessionSource('WeCom-Bot')).toBe('http')
  })
})

describe('imCredentialId', () => {
  it('reads the per-brand credential field', () => {
    expect(imCredentialId('wecom-bot', { botId: 'aib-123', secret: 's' })).toBe('aib-123')
    expect(imCredentialId('feishu-bot', { appId: 'cli_abc', appSecret: 's' })).toBe('cli_abc')
  })

  it('trims whitespace and treats an empty field as no credential', () => {
    expect(imCredentialId('wecom-bot', { botId: '  aib-123  ' })).toBe('aib-123')
    expect(imCredentialId('wecom-bot', { botId: '   ' })).toBeUndefined()
    expect(imCredentialId('feishu-bot', { appId: '' })).toBeUndefined()
    expect(imCredentialId('feishu-bot', {})).toBeUndefined()
    expect(imCredentialId('feishu-bot', undefined)).toBeUndefined()
  })

  it('returns undefined for types without a form-entered credential', () => {
    // weixin-ilink's token comes from a QR flow; such instances must never
    // collide in duplicate-credential checks.
    expect(imCredentialId('weixin-ilink-bot', { botToken: 'tok', accountId: 'a' })).toBeUndefined()
  })

  it('never confuses one brand\'s field with another\'s', () => {
    expect(imCredentialId('feishu-bot', { botId: 'aib-123' })).toBeUndefined()
    expect(imCredentialId('wecom-bot', { appId: 'cli_abc' })).toBeUndefined()
  })
})
