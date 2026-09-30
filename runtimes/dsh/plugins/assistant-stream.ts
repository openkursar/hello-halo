/**
 * Relays the runtime's live assistant stream to Halo.
 *
 * Runs INSIDE the dsh child, compiled into its bundle by
 * `runtimes/dsh/build.mjs` and mounted by
 * `src/main/services/agent/dsh/runtime/cordis-config.ts`; nothing
 * in Halo's main process imports it.
 *
 * The SDK protocol forwards session-log events only, and since session format
 * V3 token chunks are not log events: they are published process-locally on
 * `agent/assistant-stream` and reach the log once, embedded in the finished
 * `assistant/message`. Without this relay every reply would appear only when
 * its model call had ended.
 *
 * Frames go to stdout as JSON-RPC notifications beside the SDK server's own.
 * Both write one complete line per `write` call to the same stream, so lines
 * never interleave.
 *
 * The cordis context is typed structurally: the dsh packages are build inputs
 * of the runtime (`runtimes/dsh/`), not dependencies of the app this file is
 * type-checked with.
 */

interface AssistantStreamPayload {
  agent: { session: { id: unknown } }
  frame: unknown
}

interface RuntimeContext {
  on(event: 'agent/assistant-stream', listener: (payload: AssistantStreamPayload) => void): unknown
}

export const name = 'halo-assistant-stream'

/** Notification method the session adapter subscribes to. Mirrors `DshNotificationMethod.AssistantStream`. */
const METHOD = 'halo.assistant-stream'

export function apply(ctx: RuntimeContext): void {
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: METHOD, params: { sessionId: String(agent.session.id), frame } })}\n`
    )
  })
}
