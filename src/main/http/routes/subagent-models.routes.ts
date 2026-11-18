import type { Express } from 'express'
import { subagentModelHandlers } from '../../controllers/subagent-models.controller'
export function registerSubagentModelsRoutes(app: Express): void {
  app.get('/api/subagent-models', (_req, res) => { res.json(subagentModelHandlers.listSubagentModels()) })
  app.post('/api/subagent-models/create', (req, res) => { res.json(subagentModelHandlers.createSubagentModel(req.body)) })
  app.post('/api/subagent-models/update', (req, res) => { res.json(subagentModelHandlers.updateSubagentModel(req.body)) })
  app.post('/api/subagent-models/clear-builtin', (req, res) => { res.json(subagentModelHandlers.clearBuiltinSubagentModel(req.body)) })
  app.post('/api/subagent-models/delete', (req, res) => { res.json(subagentModelHandlers.deleteSubagentModel(req.body)) })
  app.post('/api/subagent-models/set-selection-mode', (req, res) => { res.json(subagentModelHandlers.setSubagentModelSelectionMode(req.body)) })
}
