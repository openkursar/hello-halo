/**
 * Unit tests for apps/runtime/legacy-default-chats.ts — a default chat written
 * by a build that never registered it is listed again, only when its pin proves
 * it still holds a conversation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ImSessionRegistry } from '../../../../src/main/apps/runtime/im-session-registry'
import { restoreLegacyDefaultChats } from '../../../../src/main/apps/runtime/legacy-default-chats'
import type { ActivityStore } from '../../../../src/main/apps/runtime/store'
import type { InstalledApp } from '../../../../src/main/apps/manager'
import type { ExecutionEnvironment } from '../../../../src/shared/apps/app-types'

describe('restoreLegacyDefaultChats', () => {
  let dir: string
  let spacePath: string
  let registry: ImSessionRegistry
  let pins: Map<string, ExecutionEnvironment>
  const store = { getSessionEnvironment: (key: string) => pins.get(key) } as unknown as ActivityStore
  const app = (id: string) => ({ id }) as InstalledApp

  function writeTranscript(appId: string): void {
    const runs = join(spacePath, '.halo', 'apps', appId, 'runs')
    mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'chat.jsonl'), '{"type":"user","_isTrigger":true}\n')
  }

  function pin(appId: string): void {
    pins.set(`legacy-file:${appId}:chat`, { spaceId: 'space-1', spacePath, workDir: spacePath, memoryDir: spacePath })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'legacy-chats-'))
    spacePath = join(dir, 'space')
    registry = new ImSessionRegistry(join(dir, 'im-sessions.json'))
    pins = new Map()
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists a pinned default chat that has no record', () => {
    writeTranscript('app1')
    pin('app1')
    restoreLegacyDefaultChats([app('app1')], store, registry)
    const record = registry.findSession('app1', 'native', 'default')
    expect(record?.source).toBe('native')
    expect(record?.messageCount).toBe(1)
    expect(record?.lastActiveAt).toBeGreaterThan(0)
  })

  it('leaves an existing record alone (a chat cleared in this build stays hidden)', () => {
    writeTranscript('app1')
    pin('app1')
    registry.register('app1', 'native', 'default', 'direct', '')
    registry.resetActivity('app1', 'native', 'default')
    restoreLegacyDefaultChats([app('app1')], store, registry)
    expect(registry.findSession('app1', 'native', 'default')?.messageCount).toBe(0)
  })

  it('skips a digital human without a pin, and a pin whose transcript is gone', () => {
    writeTranscript('unpinned')
    pin('missing')
    restoreLegacyDefaultChats([app('unpinned'), app('missing')], store, registry)
    expect(registry.listAll()).toHaveLength(0)
  })
})
