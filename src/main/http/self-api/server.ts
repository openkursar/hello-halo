/**
 * The self-API loopback listener — a second, independent Express instance
 * so an AI session can drive Halo's own HTTP surface. Deliberately kept
 * separate from `http/server.ts`'s public listener: no WebSocket, no
 * `clearAccessToken`, no shared port range, no shared token store. The only
 * thing the two share is `registerApiRoutes(app)` — the same handlers,
 * reached through a different, scoped door.
 */

import express, { Express } from 'express'
import { registerApiRoutes } from '../routes'
import { isDeveloperMode } from '../../foundation/logging'
import { issueSelfApiToken } from './token-store'
import { redactResponses } from './redact'
import { rejectNonApi, selfApiAuthMiddleware, selfApiErrorHandler } from './middleware'

/** Distinct from the public listener's 3847 so the two never contend for a port. */
const DEFAULT_PORT = 4791
const MAX_PORT_ATTEMPTS = 20

/**
 * Caller-visible bound on startup. `ensureSelfApiServer` is awaited on the
 * message-send path, so a `listen()` that neither resolves nor errors would
 * hang the user's turn outright rather than degrading to "no self-API this
 * session" — the failure mode the try/catch around it was written for.
 * Generous relative to a loopback bind, which is sub-millisecond in practice.
 */
const START_TIMEOUT_MS = 5000

export interface SelfApiInfo {
  url: string
  token: string
}

// The listener is a process-wide singleton — one loopback port for the whole
// app — while the token is per space (token-store.ts). Caching `url` alone
// rather than the full `{url, token}` pair is what lets the two have different
// lifetimes.
let listenerUrl: string | null = null
let starting: Promise<string> | null = null

function buildApp(): Express {
  const app = express()
  // Express's own final handler writes through res.end(), which the redaction
  // wrapper never sees, and it includes the stack outside production. Several
  // exposed handlers destructure req.body with no try/catch, and a request
  // whose Content-Type is not exactly application/json leaves that undefined —
  // an easy mistake to make with curl, and one that would otherwise answer
  // with a stack trace.
  app.set('env', 'production')
  app.use(express.json())
  app.use(rejectNonApi)
  app.use(redactResponses)
  app.use('/api', selfApiAuthMiddleware)
  registerApiRoutes(app)
  app.use(selfApiErrorHandler)
  return app
}

/**
 * Binds starting at `port`, retrying on the next port for `EADDRINUSE` up to
 * `MAX_PORT_ATTEMPTS` times. A prior `isPortAvailable` probe would still race
 * against whatever else on the machine binds between the probe and the real
 * `listen()` (TOCTOU) — retrying on the actual bind failure is the only
 * version of this that isn't itself racy.
 */
function listenWithRetry(app: Express, port: number, attempt = 0): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    const server = app.listen(port, '127.0.0.1', () => resolveListen(port))
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS) {
        listenWithRetry(app, port + 1, attempt + 1).then(resolveListen, rejectListen)
        return
      }
      rejectListen(error)
    })
  })
}

/**
 * Rejects if `promise` has not settled within `ms`. The bind is not cancelled —
 * if it later succeeds it leaves a listening socket whose port nobody recorded,
 * and the next attempt walks past it on EADDRINUSE. That is the accepted cost
 * of not hanging the caller's turn on a pathological bind.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout
  const bound = new Promise<never>((_, rejectTimeout) => {
    timer = setTimeout(() => rejectTimeout(new Error(message)), ms)
  })
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer)) as Promise<T>
}

async function start(): Promise<string> {
  const app = buildApp()
  const port = await withTimeout(
    listenWithRetry(app, DEFAULT_PORT),
    START_TIMEOUT_MS,
    `Self-API listener did not bind within ${START_TIMEOUT_MS}ms`
  )

  // Guarded, not deleted: worth keeping for diagnosing a deployment where the
  // listener silently never came up, but every unguarded console.log on the
  // main process is a synchronous fs.writeFileSync in production (electron-log
  // takes over console.* with writeAsync off) — a known hot-path regression
  // class this project has already paid for once.
  if (isDeveloperMode()) console.log(`[SelfApi] Listening on 127.0.0.1:${port}`)
  return `http://127.0.0.1:${port}`
}

/**
 * Starts the listener on first call, in-process idempotent thereafter — every
 * agent session past the first reuses the same one. Call before assembling
 * SDK env for a session; never at app boot, so a user who never chats never
 * pays for it. Returns the space's token alongside — reused across sessions in
 * that space, which is authority-equivalent since a token carries nothing else.
 *
 * On listener-start failure, `starting` is cleared so the next call retries
 * from scratch instead of replaying the same rejection for the rest of the
 * process lifetime — a transient port conflict must not permanently disable
 * the self-API for every future session.
 */
export async function ensureSelfApiServer(spaceId: string): Promise<SelfApiInfo> {
  if (!listenerUrl) {
    if (!starting) {
      starting = start().catch((error) => {
        starting = null
        throw error
      })
    }
    listenerUrl = await starting
  }
  return { url: listenerUrl, token: issueSelfApiToken(spaceId) }
}
