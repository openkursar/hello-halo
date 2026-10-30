import { resolveCcRuntimeLaunch } from '../../cc-runtime'
import { ANTHROPIC_CAPABILITIES } from '../capabilities'
import { tool, createSdkMcpServer } from '../mcp/sdk-server'
import { CcSession } from './session'
import type { CcOptions } from './options'

/** CC's optional process adapter; runtime acquisition belongs to cc-runtime. */
export function createCcSdkModule() {
  const openCcSession = async (options: CcOptions) => {
    const launch = await resolveCcRuntimeLaunch()
    if (!launch) throw new Error('No compatible Claude Code installation is selected')
    const session = new CcSession(options, launch)
    await session.ready()
    return session
  }
  return {
    tool,
    createSdkMcpServer,
    capabilities: ANTHROPIC_CAPABILITIES,
    createSession: openCcSession,
    async *query({ prompt, options = {} }: { prompt: string | AsyncIterable<any>; options?: CcOptions }) {
      const session = await openCcSession(options)
      try {
        if (typeof prompt === 'string') {
          await session.send(prompt)
          yield* session.stream()
          return
        }
        let finished = false
        let inputError: unknown
        let wake: (() => void) | undefined
        void (async () => {
          try {
            for await (const message of prompt) {
              if (!session.sendIntoLiveTurn(message)) throw new Error('CC query input arrived after its session closed')
              wake?.()
            }
          } catch (error) {
            inputError = error
            console.warn('[CC] Query input stream failed:', error)
            session.close()
          } finally { finished = true; wake?.() }
        })()
        while (!finished || session.hasPendingInput()) {
          if (!session.hasPendingInput() && !finished) await new Promise<void>(resolve => { wake = resolve })
          wake = undefined
          if (inputError) throw inputError
          if (finished && !session.hasPendingInput()) break
          yield* session.stream()
        }
        if (inputError) throw inputError
      } finally { session.close(); await session.flush() }
    },
  }
}
