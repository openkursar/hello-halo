/**
 * Unit tests for TelemetryProvider
 *
 * Tests:
 *   - Initialization (enabled / disabled)
 *   - track() enqueue + sanitization
 *   - Per-event whitelist filtering
 *   - Global blocklist enforcement
 *   - Size-triggered flush (hard cap at 100)
 *   - Debounce-triggered flush (5s of quiet after last track)
 *   - Debounce reset on subsequent track() calls
 *   - destroy() flush + timer cancel
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TelemetryProvider } from '../../../../src/main/services/analytics/providers/telemetry'
import type { UserContext } from '../../../../src/main/services/analytics/types'

// Mock proxyFetch globally — TelemetryProvider uses it via BaseProvider.
// The actual path is `src/main/services/proxy-fetch.ts` (two levels up from providers/).
// We mock it by the path as seen from the source file's resolve chain.
vi.mock('../../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: vi.fn(),
}))

// Access mock (imported AFTER vi.mock is hoisted)
import { proxyFetch } from '../../../../src/main/services/proxy-fetch'
const mockFetch = proxyFetch as ReturnType<typeof vi.fn>

// Helpers
const TEST_ENDPOINT = 'https://telemetry.test.local'
const TEST_API_KEY = 'test-api-key-1234'

function makeContext(): UserContext {
  return {
    userId: 'user-001',
    appVersion: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    electronVersion: '29.0.0',
  }
}

describe('TelemetryProvider', () => {
  let provider: TelemetryProvider

  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockResolvedValue({ ok: true, text: async () => '' })
  })

  afterEach(async () => {
    // ensure cleanup
    if (provider) await provider.destroy()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ── Initialization ──────────────────────────────────────────────────

  describe('init', () => {
    it('should become initialized when endpoint + apiKey are provided', async () => {
      provider = new TelemetryProvider({ endpoint: TEST_ENDPOINT, apiKey: TEST_API_KEY })
      await provider.init('user-001')
      expect(provider.initialized).toBe(true)
    })

    it('should remain uninitialized when endpoint is empty', async () => {
      provider = new TelemetryProvider({ endpoint: '', apiKey: TEST_API_KEY })
      await provider.init('user-001')
      expect(provider.initialized).toBe(false)
    })

    it('should remain uninitialized when apiKey is empty', async () => {
      provider = new TelemetryProvider({ endpoint: TEST_ENDPOINT, apiKey: '' })
      await provider.init('user-001')
      expect(provider.initialized).toBe(false)
    })
  })

  // ── Enqueue + Whitelist ──────────────────────────���───────────────────

  describe('track + sanitization', () => {
    beforeEach(async () => {
      provider = new TelemetryProvider({ endpoint: TEST_ENDPOINT, apiKey: TEST_API_KEY })
      await provider.init('user-001')
    })

    it('should enqueue events', async () => {
      await provider.track(
        { name: 'app.installed', properties: { appId: 'a1', specId: 's1', version: '1.0', type: 'automation' } },
        makeContext()
      )
      expect(provider.queueLength).toBe(1)
    })

    it('should filter out non-whitelisted keys for known events', async () => {
      await provider.track(
        {
          name: 'message.sent',
          properties: { source: 'agent', spaceId: 'sp1', randomKey: 'should-be-dropped' },
        },
        makeContext()
      )

      // Flush to observe filtered payload
      await provider.destroy()

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, options] = mockFetch.mock.calls[0]
      const body = JSON.parse(options.body)
      const event = body.events[0]
      expect(event.properties.source).toBe('agent')
      expect(event.properties.spaceId).toBe('sp1')
      expect(event.properties).not.toHaveProperty('randomKey')
    })

    it('should strip blocklisted keys even if they appear in properties', async () => {
      // 'content' and 'message' are blocked globally
      await provider.track(
        {
          name: 'session.start',
          properties: { view: 'home', content: 'leaked text', message: 'secret', startedAt: 123 },
        },
        makeContext()
      )

      await provider.destroy()
      const [, options] = mockFetch.mock.calls[0]
      const body = JSON.parse(options.body)
      const event = body.events[0]
      expect(event.properties).not.toHaveProperty('content')
      expect(event.properties).not.toHaveProperty('message')
      expect(event.properties.view).toBe('home')
    })

    it('should pass unknown events through with only blocklist applied', async () => {
      await provider.track(
        {
          name: 'custom.unknown.event',
          properties: { foo: 'bar', password: 'nope', score: 42 },
        },
        makeContext()
      )

      await provider.destroy()
      const [, options] = mockFetch.mock.calls[0]
      const body = JSON.parse(options.body)
      const event = body.events[0]
      expect(event.properties.foo).toBe('bar')
      expect(event.properties.score).toBe(42)
      expect(event.properties).not.toHaveProperty('password')
    })

    it('should be a no-op when uninitialized', async () => {
      const disabledProvider = new TelemetryProvider({ endpoint: '', apiKey: '' })
      await disabledProvider.init('user-001')
      await disabledProvider.track({ name: 'nope', properties: {} }, makeContext())
      expect(disabledProvider.queueLength).toBe(0)
    })
  })

  // ── Nested identifiers (out of reach of the key-level gate) ───────────

  describe('nested sanitization', () => {
    const toolCalls = [
      { name: 'Bash', count: 3, errors: 1 },
      { name: 'mcp__ai-browser__browser_navigate', count: 2, errors: 0 },
      { name: 'mcp__customer-crm__query', count: 4, errors: 1 },
    ]

    async function trackToolSummary(allowed: string[]): Promise<Record<string, unknown>> {
      provider = new TelemetryProvider({
        endpoint: TEST_ENDPOINT,
        apiKey: TEST_API_KEY,
        allowedSensitiveFields: allowed,
      })
      await provider.init('user-001')
      await provider.track(
        {
          name: 'tool.usage_summary',
          properties: {
            source: 'agent',
            conversationId: 'c1',
            toolCalls,
            skillCalls: [{ skillId: 'code-commit', count: 2 }],
            totalCalls: 9,
            totalErrors: 2,
          },
        },
        makeContext()
      )
      await provider.destroy()
      const [, options] = mockFetch.mock.calls[0]
      return JSON.parse(options.body).events[0].properties
    }

    it('should keep MCP tool names when the build may receive mcpId', async () => {
      const props = await trackToolSummary(['mcpId'])
      expect(props.toolCalls).toEqual(toolCalls)
    })

    it('should fold MCP tool names into one bucket when mcpId is not permitted', async () => {
      const props = await trackToolSummary([])
      expect(props.toolCalls).toEqual([
        { name: 'Bash', count: 3, errors: 1 },
        { name: 'mcp__<redacted>', count: 6, errors: 1 },
      ])
    })

    it('should keep skillCalls only when skillId is permitted', async () => {
      const permitted = await trackToolSummary(['skillId'])
      expect(permitted.skillCalls).toEqual([{ skillId: 'code-commit', count: 2 }])

      mockFetch.mockClear()
      const denied = await trackToolSummary([])
      expect(denied).not.toHaveProperty('skillCalls')
    })

    const appSummaries = [
      { appId: 'a1', specId: 'weoa-approval-agent', type: 'automation', version: '1.0', status: 'active', installedAt: 1 },
      { appId: 'a2', specId: 'meeting-room-booker', type: 'automation', version: '1.0', status: 'active', installedAt: 2 },
    ]

    async function trackSnapshot(allowed: string[]): Promise<Record<string, unknown>> {
      provider = new TelemetryProvider({
        endpoint: TEST_ENDPOINT,
        apiKey: TEST_API_KEY,
        allowedSensitiveFields: allowed,
      })
      await provider.init('user-001')
      await provider.track(
        { name: 'installed_apps.snapshot', properties: { apps: appSummaries, count: 2 } },
        makeContext()
      )
      await provider.destroy()
      const [, options] = mockFetch.mock.calls[0]
      return JSON.parse(options.body).events[0].properties
    }

    it('should keep specId in the snapshot array when the build may receive it', async () => {
      const props = await trackSnapshot(['specId'])
      expect(props.apps).toEqual(appSummaries)
    })

    it('should strip specId from every snapshot element when not permitted, keeping the rest', async () => {
      const props = await trackSnapshot([])
      expect(props.apps).toEqual([
        { appId: 'a1', type: 'automation', version: '1.0', status: 'active', installedAt: 1 },
        { appId: 'a2', type: 'automation', version: '1.0', status: 'active', installedAt: 2 },
      ])
    })
  })

  // ── Flush triggers ────────────────────────────────────────────────────

  describe('flush behavior', () => {
    beforeEach(async () => {
      provider = new TelemetryProvider({ endpoint: TEST_ENDPOINT, apiKey: TEST_API_KEY })
      await provider.init('user-001')
    })

    it('should flush when queue reaches MAX_QUEUE_SIZE (100) — hard cap', async () => {
      const ctx = makeContext()
      for (let i = 0; i < 100; i++) {
        await provider.track({ name: 'app.installed', properties: { appId: `a${i}`, specId: 's', version: '1', type: 'automation' } }, ctx)
      }

      // flushNow() is kicked off via `void` — settle the microtask queue
      await vi.advanceTimersByTimeAsync(0)
      expect(mockFetch).toHaveBeenCalled()
      expect(provider.queueLength).toBe(0)
    })

    it('should NOT flush before hard cap is reached (size-triggered path)', async () => {
      const ctx = makeContext()
      // 99 events: one below the cap
      for (let i = 0; i < 99; i++) {
        await provider.track({ name: 'app.installed', properties: { appId: `a${i}`, specId: 's', version: '1', type: 'automation' } }, ctx)
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(mockFetch).not.toHaveBeenCalled()
      expect(provider.queueLength).toBe(99)
    })

    it('should flush after 5s of quiet since the last track() (debounce)', async () => {
      const ctx = makeContext()
      await provider.track({ name: 'page.view', properties: { view: 'home' } }, ctx)
      expect(mockFetch).not.toHaveBeenCalled()

      // Just before the debounce window elapses — still no flush.
      await vi.advanceTimersByTimeAsync(4_999)
      expect(mockFetch).not.toHaveBeenCalled()

      // Crossing the 5s window — flush fires.
      await vi.advanceTimersByTimeAsync(2)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(provider.queueLength).toBe(0)
    })

    it('should reset the debounce window on each new track()', async () => {
      const ctx = makeContext()
      await provider.track({ name: 'page.view', properties: { view: 'home' } }, ctx)

      // Wait 4s — under the 5s window
      await vi.advanceTimersByTimeAsync(4_000)
      expect(mockFetch).not.toHaveBeenCalled()

      // New event resets the timer
      await provider.track({ name: 'page.view', properties: { view: 'settings' } }, ctx)

      // Another 4s — original would have fired by now (8s total), but timer was reset
      await vi.advanceTimersByTimeAsync(4_000)
      expect(mockFetch).not.toHaveBeenCalled()

      // Reach the reset window's end — flush fires now, carrying both events
      await vi.advanceTimersByTimeAsync(1_001)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      const [, options] = mockFetch.mock.calls[0]
      const body = JSON.parse(options.body)
      expect(body.events).toHaveLength(2)
    })

    it('should schedule no timer when no events are tracked', async () => {
      // No track() calls — long wait must not trigger any flush.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  // ── destroy() ─────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('should flush remaining events', async () => {
      provider = new TelemetryProvider({ endpoint: TEST_ENDPOINT, apiKey: TEST_API_KEY })
      await provider.init('user-001')
      const ctx = makeContext()
      await provider.track({ name: 'session.end', properties: { durationMs: 5000 } }, ctx)
      await provider.track({ name: 'session.end', properties: { durationMs: 6000 } }, ctx)

      expect(mockFetch).not.toHaveBeenCalled()
      await provider.destroy()
      expect(mockFetch).toHaveBeenCalledTimes(1)

      const [, options] = mockFetch.mock.calls[0]
      const body = JSON.parse(options.body)
      expect(body.events).toHaveLength(2)
    })

    it('should not flush when queue is empty', async () => {
      provider = new TelemetryProvider({ endpoint: TEST_ENDPOINT, apiKey: TEST_API_KEY })
      await provider.init('user-001')
      await provider.destroy()
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  // ── HTTP payload shape ──────────────────────────────────────────────

  describe('payload format', () => {
    it('should send correct Authorization header', async () => {
      provider = new TelemetryProvider({ endpoint: TEST_ENDPOINT, apiKey: TEST_API_KEY })
      await provider.init('user-001')
      await provider.track({ name: 'page.view', properties: { view: 'settings' } }, makeContext())
      await provider.destroy()

      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe(`${TEST_ENDPOINT}/v1/events`)
      expect(options.headers['Authorization']).toBe(`Bearer ${TEST_API_KEY}`)
      expect(options.headers['Content-Type']).toBe('application/json')
    })

    it('should include context + events in body', async () => {
      provider = new TelemetryProvider({ endpoint: TEST_ENDPOINT, apiKey: TEST_API_KEY })
      await provider.init('user-001')
      const ctx = makeContext()
      await provider.track({ name: 'page.view', properties: { view: 'home' } }, ctx)
      await provider.destroy()

      const [, options] = mockFetch.mock.calls[0]
      const body = JSON.parse(options.body)
      expect(body).toHaveProperty('sent_at')
      expect(body.context.userId).toBe('user-001')
      expect(body.context.platform).toBe('darwin')
      expect(body.events[0].name).toBe('page.view')
      expect(body.events[0].timestamp).toBeGreaterThan(0)
    })
  })
})
