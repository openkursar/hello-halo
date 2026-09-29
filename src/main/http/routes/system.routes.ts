/**
 * System REST API routes (remote access).
 * Split from the monolithic routes/index.ts; mirrors the IPC API for this domain.
 */
import type { Express, Request, Response } from 'express'
import {
  analytics,
  RENDERER_ALLOWED_EVENTS,
  electronApp,
  getEnabledAuthProviderConfigs,
} from './_shared'

/** Matches the client's batch size with headroom; anything beyond is dropped, not queued. */
const MAX_REPORTS_PER_REQUEST = 100

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A client on an older or newer event list repeats the same names; log each once. */
const warnedRejectedEvents = new Set<string>()
function warnRejectedOnce(event: string): void {
  if (warnedRejectedEvents.has(event) || warnedRejectedEvents.size >= 100) return
  warnedRejectedEvents.add(event)
  console.warn(`[Analytics/HTTP] Rejected unknown event: ${event.slice(0, 80)}`)
}

export function registerSystemRoutes(app: Express): void {
  // ===== Auth Routes (Read-only for remote access) =====
  // Remote clients use host machine's auth state, no login operations needed
  app.get('/api/auth/providers', async (req: Request, res: Response) => {
    try {
      const providers = getEnabledAuthProviderConfigs()
      res.json({ success: true, data: providers })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })


  // ===== System Routes =====
  app.get('/api/system/version', async (req: Request, res: Response) => {
    try {
      const version = electronApp.getVersion()
      res.json({ success: true, data: version })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })


  // ===== Analytics =====
  // POST /api/analytics/report — fire-and-forget telemetry from remote/Capacitor clients.
  // Body is one report `{ event, properties }` (older clients) or a batch `{ events: [...] }`.
  app.post('/api/analytics/report', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { event?: unknown; properties?: unknown; events?: unknown }

      if (Array.isArray(body.events)) {
        const reports = body.events.slice(0, MAX_REPORTS_PER_REQUEST)
        let accepted = 0
        for (const report of reports) {
          if (!isPlainObject(report)) continue
          const { event, properties } = report
          if (typeof event !== 'string' || !event) continue
          if (properties !== undefined && !isPlainObject(properties)) continue
          if (!RENDERER_ALLOWED_EVENTS.has(event)) {
            warnRejectedOnce(event)
            continue
          }
          void analytics.track(event, properties ?? {})
          accepted++
        }
        res.json({ success: true, data: { accepted, rejected: body.events.length - accepted } })
        return
      }

      const { event, properties } = body as { event?: string; properties?: Record<string, unknown> }

      if (!event || typeof event !== 'string') {
        res.status(400).json({ success: false, error: 'Missing event name' })
        return
      }

      // Same boundary the IPC handler enforces (RENDERER_ALLOWED_EVENTS) —
      // a remote/Capacitor client must not be able to report an event this
      // check would reject on desktop.
      if (!RENDERER_ALLOWED_EVENTS.has(event)) {
        res.status(403).json({ success: false, error: `Event not allowed: ${event}` })
        return
      }

      // Delegate to the same analytics pipeline the IPC handler uses
      void analytics.track(event, properties ?? {})

      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })
}
