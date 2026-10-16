import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'

export const name = 'halo-sdk-jsonrpc-server'
export const inject = ['agents']

/** Extends the public SDK server without reaching into its private session registry. */
export function apply(ctx: Context): void {
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout)
  const server = new HarnessSdkJsonRpcServer(ctx, transport)
  let initialized = false
  let stopping = false

  transport.onRequest(async (method, params) => {
    if (method === 'initialize') {
      await ctx.get('loader')?.await()
      const result = await server.handleRequest(method, params)
      initialized = true
      return result
    }
    if (method === 'session/steer') {
      if (!initialized || stopping) throw new Error('Runtime is not accepting steering')
      const sessionId = params?.sessionId
      const blocks = params?.contentBlocks
      if (typeof sessionId !== 'string' || !Array.isArray(blocks)) throw new TypeError('Invalid steering input')
      const agent = ctx.agents.get(brandString(sessionId))
      if (!agent) throw new Error(`No live agent for session ${sessionId}`)
      const images = blocks.filter(block => block?.type === 'image' && typeof block.data === 'string')
      const attachments = ctx.get('attachments')
      if (images.length > 0 && !attachments) throw new Error('Image steering requires an attachment store')
      const refs = images.length > 0
        ? await admitEncodedImages(attachments!, images.map(image => ({ data: image.data, mediaType: image.mimeType })))
        : []
      let nextImage = 0
      const content = blocks.map(block => images.includes(block)
        ? { type: 'image', attachment: refs[nextImage++] }
        : block) as UserMessage['content']
      if (stopping || ctx.agents.get(agent.id) !== agent) throw new Error(`Agent retired during steering: ${sessionId}`)
      const message = createUserMessage({ content, source: { kind: 'user' } })
      // steer wakes an idle driver and the runtime rechecks its inbox before
      // committing a turn end, covering a request that races the final answer.
      agent.steer(message)
      return { messageId: message.id }
    }
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      stopping = true
      setImmediate(async () => {
        try {
          await transport.flush()
          await ctx.root.fiber.dispose()
        } catch (error) {
          process.stderr.write(`[halo-sdk-jsonrpc] Shutdown failed: ${String(error)}\n`)
        } finally {
          process.exit(0)
        }
      })
    }
    return result
  })
  ctx.effect(() => {
    transport.start()
    return async () => {
      stopping = true
      try { await server.shutdown() } finally { transport.close() }
    }
  }, 'halo-jsonrpc.serve')
}
