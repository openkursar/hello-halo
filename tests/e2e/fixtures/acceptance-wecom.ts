import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

export interface AcceptanceWecomText {
  senderId: string
  senderName?: string
  chatId: string
  chatType: 'direct' | 'group'
  text: string
  messageId?: string
  requestId?: string
}

export interface AcceptanceWecomReply {
  index: number
  command: string
  requestId: string
  chatId: string
  messageType: string
  text: string
  streamId?: string
  finished: boolean
}

interface ReplySelection {
  requestId?: string
  chatId?: string
  after?: number
  finished?: boolean
  contains?: string
  timeoutMs?: number
}

export function assertAcceptanceWecomUrl(value: string): string {
  const url = new URL(value)
  if (!/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(value) || url.hostname !== '127.0.0.1' || url.protocol !== 'ws:') {
    throw new Error('The acceptance WeCom endpoint must be ws://127.0.0.1 on an explicit local port')
  }
  return url.toString()
}

function syntheticId(value: string, field: string): void {
  if (!/^acceptance-[A-Za-z0-9._-]+$/.test(value)) throw new Error(`The WeCom fixture requires a synthetic acceptance- identifier for ${field}`)
}

export async function startAcceptanceWecom(options: { botId?: string; secret?: string; host?: string } = {}) {
  if (options.host !== undefined && options.host !== '127.0.0.1') throw new Error('The WeCom fixture may listen only on 127.0.0.1')
  const botId = options.botId ?? `acceptance-bot-${randomUUID()}`
  const secret = options.secret ?? `acceptance-secret-${randomUUID()}`
  syntheticId(botId, 'botId')
  if (!secret) throw new Error('The WeCom fixture requires a nonempty synthetic credential')
  const replies: AcceptanceWecomReply[] = []
  const errors: string[] = []
  const sockets = new Set<WebSocket>()
  const authenticated = new Set<WebSocket>()
  const requestChats = new Map<string, string>()
  const listeners = new Set<() => void>()
  let current: WebSocket | undefined
  let closed = false
  let closePromise: Promise<void> | undefined
  let authenticationCount = 0
  const redact = (value: string) => value.replaceAll(secret, '<redacted>')
  const notify = () => { for (const listener of [...listeners]) listener() }
  const fail = (message: string) => { errors.push(message); notify() }
  const server = createServer((_request, response) => response.writeHead(404).end())
  const websocket = new WebSocketServer({ server, maxPayload: 1024 * 1024 })

  function ack(socket: WebSocket, requestId: string, errcode = 0): void {
    socket.send(JSON.stringify({ headers: { req_id: requestId }, errcode, errmsg: errcode ? 'Local fixture rejected the frame' : 'ok' }))
  }

  function receive(socket: WebSocket, data: RawData): void {
    try {
      const frame = JSON.parse(data.toString()) as { cmd?: string; headers?: { req_id?: string }; body?: Record<string, any> }
      const requestId = frame.headers?.req_id
      if (typeof requestId !== 'string' || !requestId || requestId.length > 512) throw new Error('Invalid frame request identity')
      if (frame.cmd === 'aibot_subscribe') {
        if (frame.body?.bot_id !== botId || frame.body?.secret !== secret) {
          ack(socket, requestId, 40001)
          throw new Error('Unexpected subscription identity')
        }
        authenticated.add(socket)
        current = socket
        authenticationCount++
        ack(socket, requestId)
        notify()
        return
      }
      if (!authenticated.has(socket)) throw new Error('A message arrived before subscription authentication')
      if (frame.cmd === 'ping') { ack(socket, requestId); return }
      if (!['aibot_respond_msg', 'aibot_respond_welcome_msg', 'aibot_respond_update_msg', 'aibot_send_msg'].includes(frame.cmd ?? '')) {
        ack(socket, requestId, 400)
        throw new Error('Unsupported outbound command')
      }
      const body = frame.body
      if (!body || typeof body !== 'object') throw new Error('Missing outbound message body')
      const chatId = typeof body.chatid === 'string' ? body.chatid : requestChats.get(requestId)
      if (!chatId) throw new Error('An outbound reply has no known destination')
      syntheticId(chatId, 'reply chatId')
      const content = body.stream?.content ?? body.markdown?.content ?? body.text?.content ?? ''
      if (typeof content !== 'string') throw new Error('Outbound text has an unsupported shape')
      if (replies.length >= 512) throw new Error('The WeCom fixture reply budget was exceeded')
      replies.push({
        index: replies.length,
        command: frame.cmd!, requestId: redact(requestId), chatId: redact(chatId),
        messageType: typeof body.msgtype === 'string' ? redact(body.msgtype) : 'unknown',
        text: redact(content),
        ...(typeof body.stream?.id === 'string' ? { streamId: redact(body.stream.id) } : {}),
        finished: body.stream ? body.stream.finish === true : true,
      })
      ack(socket, requestId)
      notify()
    } catch {
      fail('The local WeCom fixture received an invalid or unsupported frame')
      socket.close(1008, 'Invalid acceptance frame')
    }
  }

  websocket.on('connection', socket => {
    sockets.add(socket)
    socket.on('message', data => receive(socket, data))
    socket.on('error', () => { if (!closed) fail('A local WeCom WebSocket transport failed') })
    socket.on('close', () => {
      sockets.delete(socket)
      authenticated.delete(socket)
      if (current === socket) current = [...authenticated].findLast(client => client.readyState === WebSocket.OPEN)
      notify()
    })
  })
  websocket.on('error', () => { if (!closed) fail('The local WeCom WebSocket server failed') })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  }).catch(async error => {
    await new Promise<void>(resolve => websocket.close(() => resolve()))
    throw error
  })
  server.on('error', () => { if (!closed) fail('The local WeCom HTTP server failed') })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The local WeCom endpoint did not acquire a port')
  const url = assertAcceptanceWecomUrl(`ws://127.0.0.1:${address.port}`)

  function waitFor<T>(select: () => T | undefined, timeoutMs: number, description: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) return Promise.reject(new Error('The WeCom fixture wait must be between 1 and 120000 milliseconds'))
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => { clearTimeout(timer); listeners.delete(check) }
      const check = () => {
        if (errors.length) { finish(); reject(new Error(errors[0])); return }
        const value = select()
        if (value !== undefined) { finish(); resolve(value); return }
        if (closed) { finish(); reject(new Error(`The WeCom fixture closed before ${description}`)) }
      }
      listeners.add(check)
      timer = setTimeout(() => { finish(); reject(new Error(`Timed out waiting for ${description}`)) }, timeoutMs)
      check()
    })
  }

  const awaitAuthenticated = (timeoutMs = 15000) => waitFor(() => !closed && current?.readyState === WebSocket.OPEN && authenticated.has(current) ? current : undefined, timeoutMs, 'the application to authenticate its local WeCom connection')
  return {
    url, botId, secret, replies, errors,
    get authenticationCount() { return authenticationCount },
    async awaitAuthenticated(timeoutMs = 15000): Promise<void> { await awaitAuthenticated(timeoutMs) },
    async sendText(input: AcceptanceWecomText): Promise<{ messageId: string; requestId: string }> {
      syntheticId(input.senderId, 'senderId')
      syntheticId(input.chatId, 'chatId')
      if (input.chatType !== 'direct' && input.chatType !== 'group') throw new Error('The WeCom fixture requires a direct or group conversation')
      if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('The WeCom fixture requires a nonempty text message')
      const messageId = input.messageId ?? `acceptance-message-${randomUUID()}`
      const requestId = input.requestId ?? `acceptance-request-${randomUUID()}`
      syntheticId(messageId, 'messageId')
      syntheticId(requestId, 'requestId')
      const socket = await awaitAuthenticated()
      requestChats.set(requestId, input.chatId)
      await new Promise<void>((resolve, reject) => socket.send(JSON.stringify({
        cmd: 'aibot_msg_callback', headers: { req_id: requestId },
        body: {
          msgid: messageId, aibotid: botId, chatid: input.chatId,
          chattype: input.chatType === 'group' ? 'group' : 'single',
          from: { userid: input.senderId, name: input.senderName ?? input.senderId },
          create_time: Math.floor(Date.now() / 1000), msgtype: 'text', text: { content: input.text },
        },
      }), error => error ? reject(error) : resolve()))
      return { messageId, requestId }
    },
    waitForReply(selection: ReplySelection = {}): Promise<AcceptanceWecomReply> {
      return waitFor(() => replies.find(reply =>
        reply.index >= (selection.after ?? 0) &&
        (!selection.requestId || reply.requestId === selection.requestId) &&
        (!selection.chatId || reply.chatId === selection.chatId) &&
        reply.finished === (selection.finished ?? true) &&
        (selection.contains === undefined || reply.text.includes(selection.contains)),
      ), selection.timeoutMs ?? 30000, 'the matching application WeCom reply')
    },
    close(): Promise<void> {
      if (closePromise) return closePromise
      closed = true
      notify()
      for (const socket of sockets) socket.terminate()
      server.closeAllConnections()
      closePromise = Promise.all([
        new Promise<void>((resolve, reject) => websocket.close(error => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      ]).then(() => undefined)
      return closePromise
    },
  }
}

export type AcceptanceWecom = Awaited<ReturnType<typeof startAcceptanceWecom>>
