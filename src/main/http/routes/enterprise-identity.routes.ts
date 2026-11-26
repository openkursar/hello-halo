import type { Express, Response } from 'express'
import { getEnterpriseIdentityState } from '../../services/enterprise-identity'

function desktopOnly(res: Response): void {
  console.warn('[EnterpriseIdentity] Refused a desktop-only operation over HTTP')
  res.status(403).json({ success: false, error: 'Open Halo on the desktop to continue.', code: 'DESKTOP_ONLY' })
}

export function registerEnterpriseIdentityRoutes(app: Express): void {
  app.post('/api/enterprise-identity/state', (_req, res) => {
    res.json({ success: true, data: getEnterpriseIdentityState() })
  })
  app.post('/api/enterprise-identity/sign-in', (_req, res) => desktopOnly(res))
  app.post('/api/enterprise-identity/retry', (_req, res) => desktopOnly(res))
  app.post('/api/enterprise-identity/sign-out', (_req, res) => desktopOnly(res))
}
