import type { Express, Response } from 'express'
import * as cliTools from '../../controllers/cli-tools.controller'

async function respond(res: Response, operation: string, task: () => unknown): Promise<void> {
  try {
    res.json({ success: true, data: await task() })
  } catch (error) {
    console.error(`[CliTools] ${operation} error:`, error)
    res.json({ success: false, error: String(error) })
  }
}

function desktopOnly(res: Response): void {
  res.status(403).json({ success: false, error: 'Choose files in the desktop client.', code: 'DESKTOP_ONLY' })
}

export function registerCliToolsRoutes(app: Express): void {
  app.post('/api/cli-tools/overview', (_req, res) => respond(res, 'overview', () => cliTools.overview()))
  app.post('/api/cli-tools/set-current', (req, res) => respond(res, 'set-current', () => cliTools.setCurrent(req.body)))
  app.post('/api/cli-tools/set-disabled', (req, res) => respond(res, 'set-disabled', () => cliTools.setDisabled(req.body)))
  app.post('/api/cli-tools/remove-version', (req, res) => respond(res, 'remove-version', () => cliTools.removeVersion(req.body)))
  app.post('/api/cli-tools/remove-tool', (req, res) => respond(res, 'remove-tool', () => cliTools.removeTool(req.body)))
  app.post('/api/cli-tools/reconfirm-external', (req, res) => respond(res, 'reconfirm-external', () => cliTools.reconfirmExternal(req.body)))
  // Picking, and confirming what was picked, needs the native file dialog.
  app.post('/api/cli-tools/pick-package', (_req, res) => desktopOnly(res))
  app.post('/api/cli-tools/confirm-import', (_req, res) => desktopOnly(res))
  app.post('/api/cli-tools/cancel-import', (_req, res) => desktopOnly(res))
  app.post('/api/cli-tools/pick-external', (_req, res) => desktopOnly(res))
  app.post('/api/cli-tools/register-external', (_req, res) => desktopOnly(res))
}
