import type { Express, Response } from 'express'
import {
  beginEnterpriseLogin,
  cancelEnterpriseLogin,
  getEnterpriseIdentityState,
  pollEnterpriseLogin,
  signOutEnterpriseIdentity,
} from '../../services/enterprise-identity'

async function respond(res: Response, operation: string, task: () => unknown): Promise<void> {
  try {
    res.json({ success: true, data: await task() })
  } catch (error) {
    console.error(`[EnterpriseIdentity] ${operation} error:`, error instanceof Error ? error.message : String(error))
    res.json({ success: false, error: error instanceof Error ? error.message : String(error) })
  }
}

export function registerEnterpriseIdentityRoutes(app: Express): void {
  app.post('/api/enterprise-identity/state', (_req, res) => respond(res, 'state', () => getEnterpriseIdentityState()))
  app.post('/api/enterprise-identity/begin', (req, res) => respond(res, 'begin', () => beginEnterpriseLogin(String(req.body?.methodId ?? ''))))
  app.post('/api/enterprise-identity/poll', (req, res) => respond(res, 'poll', () => pollEnterpriseLogin(String(req.body?.flowId ?? ''))))
  app.post('/api/enterprise-identity/cancel', (req, res) => respond(res, 'cancel', () => cancelEnterpriseLogin(String(req.body?.flowId ?? ''))))
  app.post('/api/enterprise-identity/sign-out', (_req, res) => respond(res, 'sign-out', () => signOutEnterpriseIdentity()))
}
