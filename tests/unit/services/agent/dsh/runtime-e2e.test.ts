/**
 * Integration test: services/agent/dsh — the whole adapter against a REAL
 * runtime child process.
 *
 * Every other dsh test stubs something: the normalizer tests replay recorded
 * notifications, the module test fakes the wire client. This one spawns the
 * actual `@deepseek-ai/dsh-sdk-jsonrpc-demo` runtime through the real
 * transport and drives it through the real session adapter, so the seams
 * between the three are exercised together. Only the model endpoint is
 * stubbed — a local OpenAI-compatible SSE server, so no API key is needed and
 * the assistant output is deterministic.
 *
 * Opt-in: it boots a subprocess and takes seconds, which does not belong in
 * the default unit run. Enable with `DSH_E2E=1`.
 *
 *   DSH_E2E=1 npm run test:unit -- tests/unit/services/agent/dsh/runtime-e2e.test.ts
 */

import { createServer, type Server } from 'http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DshSession } from '../../../../../src/main/services/agent/dsh/session-adapter'
import { createDshRuntimeClient } from '../../../../../src/main/services/agent/dsh/transport'
import { SdkMcpBridge } from '../../../../../src/main/services/agent/mcp/sdk-bridge'
import {
  materializeCordisConfig,
  resolveDshInterpreter,
  resolveDshRuntime,
} from '../../../../../src/main/services/agent/dsh/runtime'
import type { MaterializedCordisConfig } from '../../../../../src/main/services/agent/dsh/runtime/cordis-config'

const enabled = process.env.DSH_E2E === '1'

/**
 * What the scripted `bash` call prints. The arithmetic is deliberate: the
 * expansion appears nowhere in the command text, so seeing the result proves a
 * shell evaluated it rather than something echoing the request back.
 */
const SHELL_COMMAND = 'echo dsh-shell-$((6 * 7))'
const SHELL_OUTPUT = 'dsh-shell-42'

/**
 * Two scripted assistant turns: a `bash` call, then the reply that follows its
 * result. Calling a tool rather than only answering is what proves the shell
 * the launch environment names is really reachable — the tool list the runtime
 * advertises says only that a plugin mounted.
 */
function respond(res: any, turn: number): void {
  const chunks =
    turn === 0
      ? [
          { choices: [{ delta: { role: 'assistant', content: null } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_e2e_bash',
                      type: 'function',
                      function: {
                        name: 'bash',
                        arguments: JSON.stringify({
                          command: SHELL_COMMAND,
                          description: 'Print a marker',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]
      : [
          { choices: [{ delta: { role: 'assistant', content: null } }] },
          { choices: [{ delta: { content: 'Halo and dsh are connected.' } }] },
          {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 21, completion_tokens: 7 },
          },
        ]

  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.end('data: [DONE]\n\n')
}

/** Tool names the runtime put in front of the model, read off the request header. */
function readAdvertisedTools(notification: any): string[] {
  const event = notification?.payload?.event
  if (event?.type !== 'request/header') return []
  const tools = event.data?.header?.tools
  return Array.isArray(tools) ? tools.map((tool: any) => tool?.name).filter(Boolean) : []
}

describe.skipIf(!enabled)('dsh adapter against a real runtime', () => {
  let modelServer: Server
  let baseUrl = ''
  let workDir = ''
  let dataDir = ''
  /** Which scripted turn the stub model serves next. */
  let nextTurn = 0
  /** Every completion request body, for assertions about what the model saw. */
  const modelRequests: any[] = []

  beforeAll(async () => {
    modelServer = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try { modelRequests.push(JSON.parse(body)) } catch { /* not a completion request */ }
        respond(res, nextTurn++)
      })
    })
    await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(modelServer.address() as any).port}`

    workDir = mkdtempSync(path.join(tmpdir(), 'dsh-e2e-work-'))
    dataDir = mkdtempSync(path.join(tmpdir(), 'dsh-e2e-data-'))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => modelServer.close(() => resolve()))
  })

  /**
   * Boot the adapter on `configPath`, recording into `advertisedTools` the
   * tools every request put in front of the model.
   */
  async function createSession(
    config: MaterializedCordisConfig,
    advertisedTools: string[],
    extraEnv: Record<string, string> = {},
    mcpBridge?: SdkMcpBridge,
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
        DEEPSEEK_BASE_URL: baseUrl,
        DSH_CWD: workDir,
        DSH_SESSION_ROOT: path.join(dataDir, 'sessions'),
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
            advertisedTools.push(...readAdvertisedTools(notification))
            handler(notification)
          })
        return client
      },
    })
  }

  it('runs a shell tool and streams the turn from prompt to result', async () => {
    const advertisedTools: string[] = []
    const session = await createSession(materializeCordisConfig(dataDir, { workDir }), advertisedTools)

    try {
      session.send('say hi')

      const frames: Record<string, any>[] = []
      for await (const frame of session.stream()) {
        frames.push(frame as Record<string, any>)
      }

      expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' })
      expect(frames[frames.length - 1]).toMatchObject({ type: 'result' })

      // The composition in `runtime/cordis-config.ts` is only real if the
      // runtime mounted it. What the model was actually offered rides on the
      // request header, so assert there — a plugin that fails to mount, or a
      // backend package that stops resolving from npm, would otherwise pass
      // unnoticed as a quietly less capable agent.
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
      expect(JSON.stringify(frames), 'the bash tool never reached a shell').toContain(SHELL_OUTPUT)

      const text = frames
        .filter((f) => f.type === 'stream_event' && f.event?.delta?.type === 'text_delta')
        .map((f) => f.event.delta.text)
        .join('')
      expect(text).toContain('Halo and dsh are connected.')
    } finally {
      await session.close()
    }
  }, 120_000)

  it('never puts a denied tool in front of the model', async () => {
    // Omitting a plugin is the whole of Halo's enforcement over this runtime,
    // so the claim has to be checked where it matters — in the request the
    // model receives, not in the config text.
    const advertisedTools: string[] = []
    const config = materializeCordisConfig(dataDir, { disallowedTools: ['Bash'] })

    // Skip the scripted tool call: this session has no shell to call.
    nextTurn = 1
    const session = await createSession(config, advertisedTools)

    try {
      session.send('say hi')
      for await (const _frame of session.stream()) {
        // Drain: the assertion is about the request, not the reply.
      }

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

    nextTurn = 1
    const before = modelRequests.length
    const session = await createSession(materializeCordisConfig(dataDir, { workDir }), [], {
      DSH_SKILL_DIRS: JSON.stringify([path.join(workDir, '.claude', 'skills')]),
    })

    try {
      session.send('say hi')
      for await (const _frame of session.stream()) {
        // Drain: the assertion is about the request.
      }

      const sent = JSON.stringify(modelRequests.slice(before))
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
    nextTurn = 1
    const session = await createSession(
      materializeCordisConfig(dataDir, {
        workDir,
        mcpServers: { halo: { transport: 'http', url: urls.halo, headers: {} } },
      }),
      advertisedTools,
      {},
      bridge,
    )

    try {
      session.send('say hi')
      for await (const _frame of session.stream()) {
        // Drain: the assertion is about the request.
      }

      // The very first turn: the session must not start before the runtime's
      // client has connected, or the tools exist only from turn two.
      expect(advertisedTools).toContain('mcp__halo__echo')
    } finally {
      await session.close()
      await bridge.close()
    }
  }, 120_000)
})
