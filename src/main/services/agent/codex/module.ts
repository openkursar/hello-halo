/** Codex sessions and pending creations belong to the captured engine module. */
import { CodexAppServerSession } from './session-adapter'
import { tool, createSdkMcpServer } from '../mcp/sdk-server'
import { CODEX_CAPABILITIES } from './capabilities'
import type { CodexSdkModule } from './types'

export function createCodexSdkModule(): CodexSdkModule {
  const controllers = new Set<AbortController>()
  const sessions = new Set<CodexAppServerSession>()
  const pending = new Set<Promise<CodexAppServerSession>>()
  let closing: Promise<void> | undefined
  const create = (options: Record<string, any>): Promise<CodexAppServerSession> => {
    if (closing) return Promise.reject(new Error('Codex runtime is closing'))
    const controller = new AbortController()
    const parent = options.abortController?.signal as AbortSignal | undefined
    const abort = () => controller.abort(parent?.reason)
    if (parent?.aborted) abort()
    else parent?.addEventListener('abort', abort, { once: true })
    controllers.add(controller)
    const release = () => { controllers.delete(controller); parent?.removeEventListener('abort', abort) }
    const creating = CodexAppServerSession.create({ ...options, abortController: controller }).then(async session => {
      if (controller.signal.aborted) {
        await session.close()
        controller.signal.throwIfAborted()
      }
      sessions.add(session)
      const close = session.close.bind(session)
      session.close = async () => {
        try { await close() } finally { sessions.delete(session); release() }
      }
      return session
    }).catch(error => { release(); throw error }).finally(() => { pending.delete(creating) })
    pending.add(creating)
    return creating
  }
  return {
    tool,
    createSdkMcpServer,
    capabilities: CODEX_CAPABILITIES,
    createSession: create,
    async *query(params: any) {
      const session = await create(params?.options ?? {})
      try {
        session.send(params?.prompt || 'hi')
        yield* session.stream()
      } finally { await session.close() }
    },
    close() {
      closing ??= (async () => {
        for (const controller of controllers) controller.abort()
        const creations = [...pending]
        const retiring = [...sessions].map(session => session.close())
        const results = await Promise.allSettled([...creations, ...retiring])
        for (const result of results.slice(creations.length)) {
          if (result.status === 'rejected') console.warn('[Codex][runtime] Owned session cleanup failed:', result.reason)
        }
      })()
      return closing
    },
  }
}
