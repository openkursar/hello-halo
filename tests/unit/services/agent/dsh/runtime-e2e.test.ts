/**
 * Integration test: services/agent/dsh — the whole adapter against a REAL
 * runtime child process.
 *
 * Every other dsh test stubs something: the normalizer tests replay recorded
 * notifications, the module test fakes the wire client. This one spawns the
 * actual runtime bundle through the real transport and drives it through the
 * real session adapter, so the seams between the three are exercised together.
 * Only the model endpoint is stubbed — a local OpenAI-compatible SSE server, so
 * no API key is needed and the assistant output is deterministic.
 *
 * It is also the only test that proves the bundle boots: every plugin the
 * composition names has to resolve out of the builtins registered by
 * `runtimes/dsh/build.mjs`, and a missing one shows up here as a tool
 * the runtime never advertises. Run it after changing that script or the
 * plugin manifest.
 *
 * Opt-in: it boots a subprocess and takes seconds, which does not belong in
 * the default unit run. Enable with `DSH_E2E=1`.
 *
 *   DSH_E2E=1 npm run test:unit -- tests/unit/services/agent/dsh/runtime-e2e.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { deflateSync } from 'zlib'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'
import { DshSession } from '../../../../../src/main/services/agent/dsh/session-adapter'
import { createDshRuntimeClient } from '../../../../../src/main/services/agent/dsh/transport'
import { SdkMcpBridge } from '../../../../../src/main/services/agent/mcp/sdk-bridge'
import {
  materializeCordisConfig,
  resolveDshInterpreter,
  resolveDshRuntime,
} from '../../../../../src/main/services/agent/dsh/runtime'
import type { MaterializedCordisConfig } from '../../../../../src/main/services/agent/dsh/runtime/cordis-config'
import { startMessagesStub, textReply, type MessagesStub, type StubReply } from './messages-stub'
import { createApp } from '../../../../../src/main/openai-compat-router/server/router'
import { encodeBackendConfig } from '../../../../../src/main/openai-compat-router/utils'

// The router's egress goes through Electron's session-aware fetch; a plain
// fetch is the same request without the app's proxy settings.
vi.mock('../../../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: (url: string, init: RequestInit) => fetch(url, init),
}))

const enabled = process.env.DSH_E2E === '1'

/**
 * What the scripted `bash` call prints. The arithmetic is deliberate: the
 * expansion appears nowhere in the command text, so seeing the result proves a
 * shell evaluated it rather than something echoing the request back.
 */
const SHELL_COMMAND = 'echo dsh-shell-$((6 * 7))'
const SHELL_OUTPUT = 'dsh-shell-42'

/**
 * The scripted turn: a `bash` call, then the reply that follows its result.
 * Calling a tool rather than only answering is what proves the shell the
 * launch environment names is really reachable — the tool list the runtime
 * advertises says only that a plugin mounted.
 */
function toolTurn(requestIndex: number): StubReply {
  return requestIndex % 2 === 0
    ? {
        blocks: [
          { type: 'thinking', thinking: 'The user wants a marker printed.' },
          {
            type: 'tool_use',
            id: 'toolu_e2e_bash',
            name: 'bash',
            input: { command: SHELL_COMMAND, description: 'Print a marker' },
          },
        ],
        stopReason: 'tool_use',
      }
    : textReply('Halo and dsh are connected.')
}

/** A valid opaque red RGB PNG, base64-encoded. */
function redSquarePng(size: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).fill(Buffer.from([255, 0, 0]))])
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

/** Context capacity the runtime resolved for the turn, or undefined for other events. */
function readContextWindow(notification: any): number | undefined {
  const event = notification?.payload?.event
  return event?.type === 'request/context' ? event.data?.contextWindow : undefined
}

/** Tool names the runtime put in front of the model, read off the request header. */
function readAdvertisedTools(notification: any): string[] {
  const event = notification?.payload?.event
  if (event?.type !== 'request/header') return []
  const tools = event.data?.header?.tools
  return Array.isArray(tools) ? tools.map((tool: any) => tool?.name).filter(Boolean) : []
}

describe.skipIf(!enabled)('dsh adapter against a real runtime', () => {
  let stub: MessagesStub
  let workDir = ''
  let dataDir = ''
  /** Replies the stub model serves; each test installs its own. */
  let script: (requestIndex: number) => StubReply = () => textReply('Halo and dsh are connected.')
  /** Request index the current script counts from, so each test starts at 0. */
  let scriptOrigin = 0

  beforeAll(async () => {
    stub = await startMessagesStub((index) => script(index - scriptOrigin))
    workDir = mkdtempSync(path.join(tmpdir(), 'dsh-e2e-work-'))
    dataDir = mkdtempSync(path.join(tmpdir(), 'dsh-e2e-data-'))
  })

  afterAll(async () => {
    await stub.close()
  })

  function useScript(next: (requestIndex: number) => StubReply): number {
    script = next
    scriptOrigin = stub.requests.length
    return scriptOrigin
  }

  /**
   * Boot the adapter on `config`, handing every notification to `observe`
   * before the adapter sees it.
   */
  async function createSession(
    config: MaterializedCordisConfig,
    observe: (notification: any) => void = () => {},
    extraEnv: Record<string, string> = {},
    mcpBridge?: SdkMcpBridge,
    sdkOptions: Record<string, any> = {},
  ): Promise<DshSession> {
    const runtime = resolveDshRuntime()
    expect(runtime, 'no dsh runtime installed in this build').not.toBeNull()
    const interpreter = resolveDshInterpreter()
    expect(interpreter, 'no Node new enough to boot the dsh runtime').not.toBeNull()

    return DshSession.create({
      // The launch spec `options.ts` would build. It is assembled here instead
      // because that module resolves Electron app paths, which do not exist in
      // the test runner.
      command: interpreter!.command,
      args: [runtime!.entryPath, config.path],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...interpreter!.env,
        DEEPSEEK_API_KEY: 'e2e-local-stub-not-a-real-key',
        DEEPSEEK_BASE_URL: stub.baseUrl,
        DEEPSEEK_SEARCH_BASE_URL: stub.baseUrl,
        DSH_HOME: path.join(dataDir, 'home'),
        DSH_CWD: workDir,
        DSH_SHELL_PATH: '/bin/bash',
        ...config.env,
        ...extraEnv,
      },
      cwd: workDir,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      includePartialMessages: true,
      mcpBridge,
      runtimeClientFactory: (launch: any) => {
        const client = createDshRuntimeClient({ launch })
        const subscribe = client.onNotification.bind(client)
        client.onNotification = (handler: any) =>
          subscribe((notification: any) => {
            observe(notification)
            handler(notification)
          })
        return client
      },
      ...sdkOptions,
    })
  }

  async function runTurn(session: DshSession, prompt: string): Promise<Record<string, any>[]> {
    session.send(prompt)
    const frames: Record<string, any>[] = []
    for await (const frame of session.stream()) frames.push(frame as Record<string, any>)
    return frames
  }

  it('runs a shell tool and streams the turn from prompt to result', async () => {
    const advertisedTools: string[] = []
    const captured: any[] = []
    useScript(toolTurn)
    const session = await createSession(materializeCordisConfig(dataDir, { workDir }), (notification) => {
      advertisedTools.push(...readAdvertisedTools(notification))
      captured.push(notification)
    })

    try {
      const frames = await runTurn(session, 'say hi')

      expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' })
      expect(frames[frames.length - 1]).toMatchObject({ type: 'result', is_error: false })

      // The composition in `runtime/cordis-config.ts` is only real if the
      // runtime mounted it. What the model was actually offered rides on the
      // request header, so assert there — a plugin that fails to mount, or a
      // backend package that stops resolving, would otherwise pass unnoticed as
      // a quietly less capable agent.
      expect(advertisedTools).toEqual(
        expect.arrayContaining([
          'read', 'write', 'edit', 'glob', 'grep', 'str_replace_editor', 'todo_write',
          'bash', 'web_search', 'web_fetch', 'subagent', 'skill',
          'terminal_open', 'terminal_send', 'terminal_read',
          'terminal_list', 'terminal_signal', 'terminal_close',
        ])
      )

      // The shell the launch environment names has to be a real one: on
      // Windows the runtime's fixed `bash -c` argv resolves through PATH, and
      // an unresolvable name fails here rather than at mount time.
      const toolResults = frames.filter((f) => f.type === 'user')
      expect(JSON.stringify(toolResults), 'the bash tool never reached a shell').toContain(SHELL_OUTPUT)
      expect(toolResults[0]?.message?.content?.[0]?.tool_use_id).toBe('toolu_e2e_bash')

      const text = frames
        .filter((f) => f.type === 'stream_event' && f.event?.delta?.type === 'text_delta')
        .map((f) => f.event.delta.text)
        .join('')
      expect(text).toContain('Halo and dsh are connected.')

      const thinking = frames
        .filter((f) => f.type === 'stream_event' && f.event?.delta?.type === 'thinking_delta')
        .map((f) => f.event.delta.thinking)
        .join('')
      expect(thinking).toContain('marker printed')

      // Halo's persona is the whole identity the model is given.
      const system = JSON.stringify(stub.requests[scriptOrigin]?.system ?? '')
      expect(system).not.toContain('DeepSeek Harness')

      // The runtime's home is Halo's directory, never the user's `~/.dsh`.
      expect(existsSync(path.join(dataDir, 'home'))).toBe(true)
    } finally {
      // Recorded even when an assertion above fails: the capture is how a
      // vocabulary drift in the runtime is diagnosed.
      if (process.env.DSH_E2E_CAPTURE === '1') {
        const fixture = path.resolve(
          __dirname,
          '../../../../../src/main/services/agent/dsh/__fixtures__/runtime-notifications.jsonl',
        )
        writeFileSync(
          fixture,
          captured.map((n) => JSON.stringify({ method: n.method, params: n.payload })).join('\n') + '\n',
          'utf-8',
        )
      }
      await session.close()
    }
  }, 120_000)

  it('runs on the model limits Halo pinned, not the SDK DeepSeek defaults', async () => {
    // Both limits are decided deep inside the runtime — the output cap in the
    // adapter that builds the request, the capacity in the plugin the token
    // meter and compaction read — so only a real turn shows which values won.
    // Unstated, they are DeepSeek's own 256K and 1M: the first is a flat HTTP
    // 400 from any vendor with a smaller ceiling, the second puts the
    // compaction threshold past a window that overflows first.
    const contextWindows: number[] = []
    const origin = useScript(() => textReply('ok'))
    const session = await createSession(
      materializeCordisConfig(dataDir, { workDir }),
      (notification) => {
        const window = readContextWindow(notification)
        if (window !== undefined) contextWindows.push(window)
      },
      { DSH_CONTEXT_WINDOW: '131072' },
      undefined,
      { maxTokens: 4_096 },
    )

    try {
      await runTurn(session, 'say hi')
      expect(stub.requests[origin]?.max_tokens).toBe(4_096)
      expect(contextWindows, 'the runtime never reported a context capacity').not.toEqual([])
      expect(contextWindows.every((window) => window === 131_072)).toBe(true)
    } finally {
      await session.close()
    }
  }, 120_000)

  it('never puts a denied tool in front of the model', async () => {
    // Omitting a plugin is the whole of Halo's enforcement over this runtime,
    // so the claim has to be checked where it matters — in the request the
    // model receives, not in the config text.
    const advertisedTools: string[] = []
    useScript(() => textReply('ok'))
    const session = await createSession(
      materializeCordisConfig(dataDir, { disallowedTools: ['Bash'] }),
      (notification) => advertisedTools.push(...readAdvertisedTools(notification)),
    )

    try {
      await runTurn(session, 'say hi')
      expect(advertisedTools.length, 'the model was never sent a tool list').toBeGreaterThan(0)
      expect(advertisedTools).not.toContain('bash')
      expect(advertisedTools.filter((tool) => tool.startsWith('terminal_'))).toEqual([])
      // The denial is scoped: the rest of the tool set is untouched.
      expect(advertisedTools).toContain('read')
    } finally {
      await session.close()
    }
  }, 120_000)

  it('offers the model a skill Halo installed into the workspace', async () => {
    // The runtime's frontmatter contract is narrower than Claude Code's — name
    // required and kebab-case — so this asserts a file in Halo's own layout is
    // actually accepted, not just that a provider mounted.
    const skillDir = path.join(workDir, '.claude', 'skills', 'halo-e2e-probe')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: halo-e2e-probe\ndescription: A probe skill installed by Halo.\nuser-invocable: true\n---\n\nDo the probe thing.\n',
      'utf-8',
    )

    const origin = useScript(() => textReply('ok'))
    const session = await createSession(materializeCordisConfig(dataDir, { workDir }), undefined, {
      DSH_SKILL_DIRS: JSON.stringify([path.join(workDir, '.claude', 'skills')]),
    })

    try {
      await runTurn(session, 'say hi')
      const sent = JSON.stringify(stub.requests.slice(origin))
      expect(sent, 'the skill catalogue never reached the model').toContain('halo-e2e-probe')
      expect(sent).toContain('A probe skill installed by Halo.')
    } finally {
      await session.close()
    }
  }, 120_000)

  it('reaches an in-process Halo tool through the runtime MCP client', async () => {
    // The full inversion: a tool whose body lives in Halo's heap, published on
    // loopback, dialled by the runtime's own client, and offered to the model
    // under Halo's `mcp__server__tool` convention.
    const bridge = new SdkMcpBridge({
      halo: {
        version: '1.0.0',
        listTools: () => [
          {
            name: 'echo',
            description: 'Echo the input back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ],
        callTool: async () => ({ content: [{ type: 'text', text: 'echoed' }] }),
      },
    })
    const urls = await bridge.start()

    const advertisedTools: string[] = []
    useScript(() => textReply('ok'))
    const session = await createSession(
      materializeCordisConfig(dataDir, {
        workDir,
        mcpServers: { halo: { transport: 'http', url: urls.halo, headers: {} } },
      }),
      (notification) => advertisedTools.push(...readAdvertisedTools(notification)),
      {},
      bridge,
    )

    try {
      await runTurn(session, 'say hi')
      // The very first turn: the session must not start before the runtime's
      // client has connected, or the tools exist only from turn two.
      expect(advertisedTools).toContain('mcp__halo__echo')
    } finally {
      await session.close()
      await bridge.close()
    }
  }, 120_000)

  it('reaches the model through Halo\'s compat router, without the harness identity', async () => {
    // What production does: the runtime talks Messages to Halo's router, the
    // backend descriptor rides as its key, and the router — not the runtime —
    // addresses the source.
    const router = createApp().listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => router.once('listening', () => resolve()))
    const routerUrl = `http://127.0.0.1:${(router.address() as AddressInfo).port}/v1`
    const descriptor = encodeBackendConfig({
      url: `${stub.baseUrl}/messages`,
      key: 'upstream-secret',
      model: 'deepseek-v4-flash',
      apiType: 'anthropic_passthrough',
    })

    const origin = useScript(() => textReply('through the router'))
    const session = await createSession(materializeCordisConfig(dataDir, { workDir }), undefined, {
      DEEPSEEK_API_KEY: descriptor,
      DEEPSEEK_BASE_URL: routerUrl,
      DEEPSEEK_SEARCH_BASE_URL: routerUrl,
    })

    try {
      const frames = await runTurn(session, 'say hi')
      expect(frames[frames.length - 1]).toMatchObject({ type: 'result', is_error: false, result: 'through the router' })

      const upstream = stub.headers[origin]
      expect(upstream['x-api-key']).toBe('upstream-secret')
      expect(upstream['user-agent'] ?? '').not.toContain('deepseek-harness')
      expect(Object.keys(upstream).filter((name) => name.startsWith('x-deepseek-harness'))).toEqual([])
    } finally {
      await session.close()
      await new Promise<void>((resolve) => router.close(() => resolve()))
    }
  }, 120_000)

  it('puts a pasted image in front of a vision model, through the router', async () => {
    // The runtime admits the inline image into its attachment store (sharp,
    // planted beside the bundle), tries the Files API first — Halo's router
    // has none — and falls back to sending it inline in the Messages request.
    const router = createApp().listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => router.once('listening', () => resolve()))
    const routerUrl = `http://127.0.0.1:${(router.address() as AddressInfo).port}/v1`
    const descriptor = encodeBackendConfig({
      url: `${stub.baseUrl}/messages`,
      key: 'upstream-secret',
      model: 'deepseek-v4-flash',
      apiType: 'anthropic_passthrough',
    })
    const png = redSquarePng(16)

    const origin = useScript(() => textReply('a red square'))
    const session = await createSession(materializeCordisConfig(dataDir, { workDir }), undefined, {
      DEEPSEEK_API_KEY: descriptor,
      DEEPSEEK_BASE_URL: routerUrl,
      DEEPSEEK_SEARCH_BASE_URL: routerUrl,
      DSH_MODEL_CATALOG: JSON.stringify([{ id: 'deepseek-v4-flash', inputModalities: ['text', 'image'] }]),
    })

    try {
      session.send({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
          ],
        },
      })
      const frames: Record<string, any>[] = []
      for await (const frame of session.stream()) frames.push(frame as Record<string, any>)
      expect(frames[frames.length - 1]).toMatchObject({ type: 'result', is_error: false, result: 'a red square' })

      const sent = stub.requests.slice(origin)
      const images = sent.flatMap((body) => body.messages.flatMap((m: any) =>
        Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'image') : []))
      expect(images.length, 'the image never reached the model').toBeGreaterThan(0)
      expect(images[0].source.type).toBe('base64')
    } finally {
      await session.close()
      await new Promise<void>((resolve) => router.close(() => resolve()))
    }
  }, 120_000)

  it('keeps answering a conversation whose runtime was restarted', async () => {
    // Halo replays a conversation's persisted session id into every new
    // runtime, and the runtime persists sessions under that id. A second
    // process meeting the same id must still take the prompt — otherwise every
    // conversation dies on the first model change or app restart.
    const sessionId = `e2e-resume-${Date.now()}`
    useScript(() => textReply('first'))
    const first = await createSession(materializeCordisConfig(dataDir, { workDir }), undefined, {}, undefined, {
      resume: sessionId,
    })
    try {
      const frames = await runTurn(first, 'one')
      expect(frames[frames.length - 1]).toMatchObject({ type: 'result', is_error: false })
    } finally {
      await first.close()
    }

    useScript(() => textReply('second'))
    const second = await createSession(materializeCordisConfig(dataDir, { workDir }), undefined, {}, undefined, {
      resume: sessionId,
    })
    try {
      const frames = await runTurn(second, 'two')
      expect(frames[frames.length - 1]).toMatchObject({ type: 'result', is_error: false })
      const text = frames
        .filter((f) => f.type === 'stream_event' && f.event?.delta?.type === 'text_delta')
        .map((f) => f.event.delta.text)
        .join('')
      expect(text).toContain('second')
    } finally {
      await second.close()
    }
  }, 120_000)
})
