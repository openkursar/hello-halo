/**
 * Unit tests for apps/runtime/im-session-registry.ts source classification.
 *
 * The registry is the single store for a digital human's external sessions
 * across all channels. The `source` marker decides which sessions are pushable
 * (IM, with a live channel adapter) versus read-only external sessions (HTTP):
 *   - getAllSessions      → every session (UI conversation list)
 *   - getPushableSessions → source==='im' only (notify_bot contact directory)
 *   - getProactiveSessions→ proactive && source==='im' (auto-sync targets)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ImSessionRegistry } from '../../../../src/main/apps/runtime/im-session-registry'

describe('ImSessionRegistry — channel source classification', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'im-reg-'))
    file = join(dir, 'sessions.json')
  })

  afterEach(async () => {
    // register() persists fire-and-forget via queueMicrotask + async writeFile;
    // let any in-flight write settle before removing the directory so the test
    // output stays free of spurious "failed to persist" warnings.
    await new Promise(resolve => setTimeout(resolve, 20))
    rmSync(dir, { recursive: true, force: true })
  })

  it('marks IM channel registrations as source=im', () => {
    const reg = new ImSessionRegistry(file)
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1')
    expect(reg.findSession('app1', 'wecom-bot', 'chat-1')?.source).toBe('im')
  })

  it('marks http registrations as source=http', () => {
    const reg = new ImSessionRegistry(file)
    reg.register('app1', 'http', 'user-9', 'direct', '')
    expect(reg.findSession('app1', 'http', 'user-9')?.source).toBe('http')
  })

  it('excludes http sessions from pushable and proactive results', () => {
    const reg = new ImSessionRegistry(file)
    reg.register('app1', 'http', 'user-9', 'direct', '')
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1')

    // UI list shows both channels
    expect(reg.getAllSessions('app1')).toHaveLength(2)

    // Push targets are IM-only
    const pushable = reg.getPushableSessions('app1')
    expect(pushable).toHaveLength(1)
    expect(pushable[0].channel).toBe('wecom-bot')

    // Even a (defensively) proactive-flagged http session is never returned
    reg.setProactive('app1', 'http', 'user-9', true)
    reg.setProactive('app1', 'wecom-bot', 'chat-1', true)
    const proactive = reg.getProactiveSessions('app1')
    expect(proactive).toHaveLength(1)
    expect(proactive[0].channel).toBe('wecom-bot')
  })

  it('backfills source for legacy records persisted without it', () => {
    const legacy = [{
      appId: 'app1',
      channel: 'feishu-bot',
      instanceId: 'inst-1',
      chatId: 'room-1',
      chatType: 'group',
      displayName: 'Room',
      proactive: false,
      lastActiveAt: Date.now(),
    }]
    writeFileSync(file, JSON.stringify(legacy), 'utf8')

    const reg = new ImSessionRegistry(file)
    expect(reg.findSession('app1', 'feishu-bot', 'room-1')?.source).toBe('im')
  })
})

describe('ImSessionRegistry — HTTP session bounds', () => {
  let dir: string
  let file: string
  const CAP = 500

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'im-reg-'))
    file = join(dir, 'sessions.json')
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    rmSync(dir, { recursive: true, force: true })
  })

  it('caps HTTP sessions per app at the configured maximum', () => {
    const reg = new ImSessionRegistry(file)
    for (let i = 0; i <= CAP; i++) {
      reg.register('app1', 'http', `user-${i}`, 'direct', '')
    }
    const http = reg.getAllSessions('app1').filter(s => s.source === 'http')
    expect(http.length).toBe(CAP)
  })

  it('never caps IM sessions (human-bounded, carry user intent)', () => {
    const reg = new ImSessionRegistry(file)
    // Register a generous number of IM sessions; none should be evicted.
    for (let i = 0; i < CAP + 50; i++) {
      reg.register('app1', 'wecom-bot', `chat-${i}`, 'direct', 'inst-1')
    }
    const im = reg.getAllSessions('app1').filter(s => s.source === 'im')
    expect(im.length).toBe(CAP + 50)
  })

  it('prunes expired HTTP sessions when a new one is registered', () => {
    const stale = [{
      appId: 'app1', channel: 'http', source: 'http', instanceId: '',
      chatId: 'old-user', chatType: 'direct', displayName: 'old-user',
      proactive: false,
      lastActiveAt: Date.now() - 40 * 24 * 60 * 60 * 1000, // 40 days ago
    }]
    writeFileSync(file, JSON.stringify(stale), 'utf8')

    const reg = new ImSessionRegistry(file)
    expect(reg.findSession('app1', 'http', 'old-user')).toBeDefined()

    // Registering a fresh HTTP session triggers TTL pruning of the stale one.
    reg.register('app1', 'http', 'new-user', 'direct', '')

    expect(reg.findSession('app1', 'http', 'old-user')).toBeUndefined()
    expect(reg.findSession('app1', 'http', 'new-user')).toBeDefined()
  })

  it('exempts user-pinned (customName) HTTP sessions from TTL pruning', () => {
    const pinned = [{
      appId: 'app1', channel: 'http', source: 'http', instanceId: '',
      chatId: 'vip', chatType: 'direct', displayName: 'vip', customName: 'VIP',
      proactive: false,
      lastActiveAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
    }]
    writeFileSync(file, JSON.stringify(pinned), 'utf8')

    const reg = new ImSessionRegistry(file)
    reg.register('app1', 'http', 'new-user', 'direct', '')

    // Pinned stale session survives despite being past TTL.
    expect(reg.findSession('app1', 'http', 'vip')).toBeDefined()
  })
})
