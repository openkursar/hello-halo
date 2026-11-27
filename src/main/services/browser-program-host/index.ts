/**
 * Browser Program Host — lets programs the AI runs in a session use that
 * session's built-in browser, through the WebCLI host protocol v1.
 *
 * See DESIGN.md. Public surface:
 *   applyProgramHostEnvironment() — set or clear the session's host variables
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getHaloDir } from '../../foundation/config.service'
import { browserContextOfServer } from '../ai-browser'
import { ensureListening, registrationFor } from './server'

const ENDPOINT_ENV = 'WEBCLI_HOST_ENDPOINT'
const TOKEN_ENV = 'WEBCLI_HOST_TOKEN'

let stateDirs: Promise<Record<string, string>> | undefined

/**
 * Programs built for a host keep their Adapter and provider state where the
 * host says and refuse to start without it. Halo keeps it in its own data
 * folder, apart from any separately installed copy of the same program.
 */
function programStateEnvironment(): Promise<Record<string, string>> {
  stateDirs ??= (async () => {
    const root = join(getHaloDir(), 'browser-program-host', 'programs')
    const adapters = join(root, 'adapters')
    const data = join(root, 'data')
    const provider = join(root, 'provider')
    await Promise.all([adapters, data, provider].map(dir => mkdir(dir, { recursive: true, mode: 0o700 })))
    return {
      WEWORKER_USER_ADAPTERS_DIR: adapters,
      WEBCLI_ADAPTERS_DIR: adapters,
      WEWORKER_ADAPTER_DATA_DIR: data,
      WEBCLI_HOST_STATE_DIR: provider,
    }
  })().catch(error => {
    stateDirs = undefined
    throw error
  })
  return stateDirs
}

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
    const [{ endpoint }, state] = await Promise.all([ensureListening(), programStateEnvironment()])
    Object.assign(env, state)
    env[ENDPOINT_ENV] = endpoint
    env[TOKEN_ENV] = registrationFor(ctx).token
  } catch (error) {
    console.error('[BrowserProgramHost] Endpoint unavailable; programs in this session cannot use the browser', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
