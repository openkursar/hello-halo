/**
 * Codex engine facade implementing Halo's SDK module contract.
 *
 * The factory no longer takes a runtime parameter — the app-server adapter
 * spawns its own child process via `transport/connection.ts`. We keep the
 * exported factory API stable for `resolved-sdk.ts` which calls it during
 * `initSdk()`.
 */

import { CodexAppServerSession } from './session-adapter'
import { tool, createSdkMcpServer } from '../mcp/sdk-server'
import { CODEX_CAPABILITIES } from './capabilities'
import type { CodexSdkModule } from './types'

export function createCodexSdkModule(): CodexSdkModule {
  return {
    tool,
    createSdkMcpServer,
    capabilities: CODEX_CAPABILITIES,
    async createSession(options: Record<string, any>) {
      return CodexAppServerSession.create(options)
    },
    query(params: any) {
      return queryCodex(params)
    },
  }
}

async function* queryCodex(params: any): AsyncGenerator<any> {
  const session = await CodexAppServerSession.create({
    ...(params?.options || {}),
    resume: params?.options?.resume,
  })
  try {
    session.send(params?.prompt || 'hi')
    yield* session.stream()
  } finally {
    await session.close()
  }
}
