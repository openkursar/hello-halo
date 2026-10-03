/**
 * Guards for main-process resource rules:
 *
 * - Resource numbers come from the health sampler only: no other module reads
 *   process/system memory to decide anything.
 * - User transcripts (JSONL) are never read whole with readFileSync.
 * - Streaming agent events reach clients only through the shared visibility
 *   rule (shared/agent-event-visibility), on IPC and WebSocket alike.
 * - Engine sessions are created under the session budget: resident ones by the
 *   engine's limit, transient automation ones after admitTransientSession.
 */

import { describe, it, expect } from 'vitest'
import { findMatches, formatMatches, listSourceFiles, readSource } from './lib/source-scan'

const MAIN_FILES = listSourceFiles('src/main')

/** Code lines only: drop line and block comment lines. */
function codeMatches(files: readonly string[], pattern: RegExp) {
  return findMatches(files, pattern).filter((m) => !/^(\/\/|\*|\/\*)/.test(m.text))
}

describe('health sampling is the single resource truth', () => {
  const ALLOWED: Record<string, string> = {
    // Developer-mode performance monitor (DevTools panel); displays numbers, decides nothing.
    'src/main/services/perf/perf.service.ts': 'developer display only',
  }

  it('reads process/system memory only inside services/health', () => {
    const offenders = codeMatches(MAIN_FILES, /process\.memoryUsage\(|\.getAppMetrics\(|\bfreemem\(|getSystemMemoryInfo\(/)
      .filter((m) => !m.file.startsWith('src/main/services/health/') && !(m.file in ALLOWED))
    expect(offenders, formatMatches(offenders)).toEqual([])
  })
})

describe('transcripts are never read whole', () => {
  const ALLOWED_LINES: Array<{ file: string; text: string; reason: string }> = [
    {
      file: 'src/main/apps/runtime/session-store.ts',
      text: "const raw = readFileSync(filePath, 'utf8')",
      reason: 'the per-app session-id map (_session-ids.json), a small JSON object, not a transcript',
    },
  ]

  it('no readFileSync in a module that handles .jsonl files, except listed small-file reads', () => {
    const jsonlModules = MAIN_FILES.filter((file) => readSource(file).includes('.jsonl'))
    const offenders = codeMatches(jsonlModules, /\breadFileSync\(/)
      .filter((m) => !ALLOWED_LINES.some((a) => a.file === m.file && m.text === a.text))
    expect(offenders, formatMatches(offenders)).toEqual([])
  })
})

describe('streaming agent events go through the visibility rule', () => {
  it('only ipc/agent.ts forwards engine events to the renderer, and it applies the rule first', () => {
    const forwarders = codeMatches(MAIN_FILES, /\bonAgentEvent\(/)
      .filter((m) => m.file.startsWith('src/main/ipc/') || m.file.startsWith('src/main/http/'))
    expect(forwarders.map((m) => m.file)).toEqual(['src/main/ipc/agent.ts'])

    const source = readSource('src/main/ipc/agent.ts')
    const body = source.slice(source.indexOf('onAgentEvent((e)'), source.indexOf('onAgentBroadcast((e)'))
    expect(body.indexOf('shouldDeliverAgentEvent(')).toBeGreaterThan(-1)
    expect(body.indexOf('shouldDeliverAgentEvent(')).toBeLessThan(body.indexOf('webContents.send('))
  })

  it('the WebSocket conversation broadcast applies the same rule', () => {
    const source = readSource('src/main/http/websocket.ts')
    const body = source.slice(source.indexOf('export function broadcastToWebSocket'), source.indexOf('export function broadcastToAll'))
    expect(body).toContain('shouldDeliverAgentEvent(')
    // The only subscription-only path is office peers (joiner nodes), which consume no status events.
    const bare = body.match(/subscriptions\.has\(/g) ?? []
    expect(bare.length).toBeLessThanOrEqual(1)
    if (bare.length) expect(body).toMatch(/credential\?\.type === 'office-member'\s*\?\s*client\.subscriptions\.has\(conversationId\)/)
  })

  it('nothing sends agent:* events to the renderer directly', () => {
    const offenders = codeMatches(MAIN_FILES, /sendToRenderer\(\s*['"`]agent:/)
    expect(offenders, formatMatches(offenders)).toEqual([])
  })
})

describe('engine sessions are created under the session budget', () => {
  const ALLOWED: Record<string, string> = {
    'src/main/services/agent/session-manager.ts': 'resident sessions: enforces the resident limit before creating',
    'src/main/services/api-validator.service.ts': 'one-shot credential validation session, closed immediately',
    'src/main/services/agent/dsh/module.ts': 'engine adapter: its one-shot query() runs over its own session',
  }

  it('a transient automation session is admitted first', () => {
    const creators = codeMatches(MAIN_FILES, /await createSession\(/)
      .filter((m) => !(m.file in ALLOWED))
    expect(creators.map((m) => m.file)).toEqual(['src/main/apps/runtime/execute.ts'])

    const execute = readSource('src/main/apps/runtime/execute.ts')
    const at = execute.indexOf('await createSession(')
    expect(execute.lastIndexOf('admitTransientSession(', at)).toBeGreaterThan(execute.lastIndexOf('\n    } else {', at))
  })

  it('the engine enforces the resident limit right before creating a new session', () => {
    const manager = readSource('src/main/services/agent/session-manager.ts')
    const create = manager.indexOf('// Create new session')
    expect(manager.indexOf('enforceResidentSessionLimit(conversationId)', create)).toBeGreaterThan(create)
    expect(manager.indexOf('enforceResidentSessionLimit(conversationId)', create))
      .toBeLessThan(manager.indexOf('createSession(sdkOptions)', create))
  })
})
