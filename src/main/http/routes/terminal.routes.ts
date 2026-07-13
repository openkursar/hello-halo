/**
 * Terminal REST API routes (remote access).
 * Mirrors the IPC terminal surface for remote/mobile clients. Live output and
 * lifecycle arrive over the WebSocket (terminal:data / terminal:lifecycle);
 * keyboard input is posted back here, giving full-duplex remote takeover.
 *
 * Security: a remote bearer token already grants agent (and thus Bash) access,
 * but the terminal is a direct, model-free shell — so remote input is treated
 * as sensitive. Two constraints beyond the shared auth middleware:
 *   - remote callers may NOT choose the shell executable (no arbitrary-binary
 *     spawn); the platform default shell is always used.
 *   - the surface is gated on isTerminalAvailable() so unsupported hosts (Linux)
 *     never expose it.
 */
import type { Express, Request, Response } from 'express'
import { isTerminalAvailable } from '../../services/ai-terminal/available'

/** Reject every terminal route on hosts where the feature is unavailable. */
function ensureAvailable(res: Response): boolean {
  if (isTerminalAvailable()) return true
  res.status(403).json({ success: false, error: 'Terminal is not available on this host' })
  return false
}

export function registerTerminalRoutes(app: Express): void {
  app.get('/api/terminal/list', async (_req: Request, res: Response) => {
    if (!ensureAvailable(res)) return
    try {
      const { listTerminals } = await import('../../services/ai-terminal')
      res.json({ success: true, data: listTerminals() })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/terminal/create', async (req: Request, res: Response) => {
    if (!ensureAvailable(res)) return
    try {
      const { createTerminalForUser } = await import('../../services/ai-terminal')
      const { getWorkingDir } = await import('../../services/agent')
      const spaceId = String(req.body.spaceId ?? '')
      const workDir = getWorkingDir(spaceId)
      // Deliberately drop req.body.shell: remote callers must not be able to
      // spawn an arbitrary executable. cwd/title are safe (a shell can cd itself).
      const cwd = typeof req.body.cwd === 'string' ? req.body.cwd : undefined
      const title = typeof req.body.title === 'string' ? req.body.title : undefined
      const result = createTerminalForUser(spaceId, workDir, { cwd, title })
      res.json(result.ok ? { success: true, data: result.info } : { success: false, error: result.error })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/terminal/input', async (req: Request, res: Response) => {
    if (!ensureAvailable(res)) return
    try {
      if (typeof req.body.sessionId !== 'string' || typeof req.body.data !== 'string') {
        return res.json({ success: false, error: 'sessionId and data (string) are required' })
      }
      const { terminalInput } = await import('../../services/ai-terminal')
      const ok = terminalInput(req.body.sessionId, req.body.data)
      res.json(ok ? { success: true } : { success: false, error: 'No such terminal session' })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/terminal/resize', async (req: Request, res: Response) => {
    if (!ensureAvailable(res)) return
    try {
      const cols = Number(req.body.cols)
      const rows = Number(req.body.rows)
      if (typeof req.body.sessionId !== 'string' || !Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
        return res.json({ success: false, error: 'sessionId and positive integer cols/rows are required' })
      }
      const { terminalResize } = await import('../../services/ai-terminal')
      const ok = terminalResize(req.body.sessionId, cols, rows)
      res.json(ok ? { success: true } : { success: false, error: 'No such terminal session' })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/terminal/kill', async (req: Request, res: Response) => {
    if (!ensureAvailable(res)) return
    try {
      const { killTerminal } = await import('../../services/ai-terminal')
      const ok = killTerminal(req.body.sessionId)
      res.json(ok ? { success: true } : { success: false, error: 'No such terminal session' })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/terminal/replay', async (req: Request, res: Response) => {
    if (!ensureAvailable(res)) return
    try {
      const { getTerminalReplay } = await import('../../services/ai-terminal')
      const replay = getTerminalReplay(req.body.sessionId)
      res.json(replay ? { success: true, data: replay } : { success: false, error: 'No such terminal session' })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })
}
