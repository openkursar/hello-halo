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
