import type { Express, Response } from 'express'
import * as skillsController from '../../controllers/skills.controller'

async function respond(res: Response, operation: string, task: () => unknown): Promise<void> {
  try {
    res.json({ success: true, data: await task() })
  } catch (error) {
    console.error(`[Skills] ${operation} error:`, error)
    res.json({ success: false, error: String(error) })
  }
}

export function registerSkillsRoutes(app: Express): void {
  app.post('/api/skills/list', (req, res) =>
    respond(res, 'list', () => skillsController.listSkills(req.body)))

  app.post('/api/skills/read', (req, res) =>
    respond(res, 'read', () => skillsController.readSkill(req.body)))

  app.post('/api/skills/save', (req, res) =>
    respond(res, 'save', () => skillsController.saveSkill(req.body)))

  app.post('/api/skills/import', (req, res) =>
    respond(res, 'import', () => skillsController.importSkill(req.body)))

  app.post('/api/skills/set-enabled', (req, res) =>
    respond(res, 'set-enabled', () => skillsController.setSkillEnabled(req.body)))

  app.post('/api/skills/move-preview', (req, res) =>
    respond(res, 'move-preview', () => skillsController.previewSkillMove(req.body)))

  app.post('/api/skills/move', (req, res) =>
    respond(res, 'move', () => skillsController.moveSkill(req.body)))

  app.post('/api/skills/copy', (req, res) =>
    respond(res, 'copy', () => skillsController.copySkill(req.body)))

  app.post('/api/skills/delete', (req, res) =>
    respond(res, 'delete', () => skillsController.deleteSkill(req.body)))

  app.post('/api/skills/open-folder', (_req, res) => {
    console.warn('[Skills] open-folder refused: desktop client required')
    res.status(403).json({ success: false, error: 'Please open the skill folder in the desktop client.', code: 'DESKTOP_ONLY' })
  })

  app.post('/api/skills/export', (req, res) =>
    respond(res, 'export', () => skillsController.exportSkill(req.body)))

  app.post('/api/skills/restore-legacy', (req, res) =>
    respond(res, 'restore-legacy', () => skillsController.restoreLegacySkill(req.body)))

  app.post('/api/skills/delete-legacy', (req, res) =>
    respond(res, 'delete-legacy', () => skillsController.deleteLegacySkill(req.body)))
}
