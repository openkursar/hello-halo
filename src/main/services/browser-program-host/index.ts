/**
 * Browser Program Host — lets programs the AI runs in a session use that
 * session's built-in browser, through the WebCLI host protocol v1.
 *
 * See DESIGN.md. Public surface:
 *   applyProgramHostEnvironment() — set or clear the session's host variables
 */

import { browserContextOfServer } from '../ai-browser'
import { ensureListening, registrationFor } from './server'

const ENDPOINT_ENV = 'WEBCLI_HOST_ENDPOINT'
const TOKEN_ENV = 'WEBCLI_HOST_TOKEN'

/**
 * Point a session's programs at the browser its mounted AI Browser server acts
 * on. Without such a server, or if the endpoint cannot start, the variables
 * are removed, so a session never inherits another's or Halo's own.
 */
export async function applyProgramHostEnvironment(
  env: Record<string, string | number | undefined> | undefined,
  mcpServers: Record<string, unknown> | null | undefined,
): Promise<void> {
  if (!env) return
  delete env[ENDPOINT_ENV]
  delete env[TOKEN_ENV]
  const ctx = Object.values(mcpServers ?? {}).map(browserContextOfServer).find(found => found && !found.isReleased)
  if (!ctx) return
  try {
    const { endpoint } = await ensureListening()
    env[ENDPOINT_ENV] = endpoint
    env[TOKEN_ENV] = registrationFor(ctx).token
  } catch (error) {
    console.error('[BrowserProgramHost] Endpoint unavailable; programs in this session cannot use the browser', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
