/**
 * Preset CLI tools in an installed (packaged) Halo.
 *
 * The build copies resources/cli-preset/*.hcli into the package; on first use
 * the app imports them and every user-facing entry gets a launcher directory
 * appended to PATH. A scripted model asks each entry to run the tools once;
 * the assertions read what the shell sent back.
 *
 * Needs a package built with prettier 3.9.10, tsc 5.9.3 and js-yaml 5.5.0 in
 * resources/cli-preset (git-ignored), so it is not part of any default project.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import { test, expect } from '../fixtures/electron-packaged'
import { navigateToChat } from '../fixtures/helpers'

test.setTimeout(300000)

const ENTRIES = { chat: 'CLI_PROBE_CHAT', dh: 'CLI_PROBE_DH', auto: 'CLI_PROBE_AUTO' } as const
type Entry = keyof typeof ENTRIES

const PROBE = [
  `printf 'CLI_BIN=%s\\n' "$HALO_CLI_TOOLS_BIN"`,
  `printf 'PRETTIER_PATH=%s\\n' "$(command -v prettier)"`,
  'prettier --version',
  'tsc --version',
  `printf 'a: 1\\n' | js-yaml -`,
  `printf 'PATH_TAIL=%s\\n' "\${PATH##*:}"`,
  `head -3 "$HALO_CLI_TOOLS_BIN/../TOOLS.md"`,
].join('; ')

interface ScriptedModel {
  url: string
  results: Map<Entry, { text: string; isError: boolean }>
  skillAdvertised: boolean
  close(): Promise<void>
}

function sse(res: http.ServerResponse, block: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | { type: 'text'; text: string }): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const start = block.type === 'tool_use'
    ? [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } },
       { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }]
    : [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
       { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } }]
  const events = [
    { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'cli-preset-mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    ...start,
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
}

async function startScriptedModel(): Promise<ScriptedModel> {
  const model = { results: new Map(), skillAdvertised: false } as Omit<ScriptedModel, 'url' | 'close'>
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.includes('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      if (body.includes('halo-cli-tools')) model.skillAdvertised = true
      const request = JSON.parse(body || '{}') as { stream?: boolean; tools?: Array<{ name: string }>; messages?: Array<{ content: unknown }> }
      const entry = (['auto', 'dh', 'chat'] as const).find(key => body.includes(ENTRIES[key]))
      const id = entry ? `toolu_cli_${entry}` : ''
      for (const message of request.messages ?? []) {
        if (!Array.isArray(message.content)) continue
        for (const part of message.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
          if (part.type !== 'tool_result' || !entry || part.tool_use_id !== id) continue
          const pieces = Array.isArray(part.content) ? part.content as Array<{ type: string; text?: string }> : [{ type: 'text', text: String(part.content ?? '') }]
          model.results.set(entry, { text: pieces.filter(p => p.type === 'text').map(p => p.text).join('\n'), isError: part.is_error === true })
        }
      }
      // Claude Code and Halo name the shell tool Bash; DSH names it bash.
      const shell = request.tools?.find(tool => tool.name === 'Bash' || tool.name === 'bash')?.name
      const ask = entry && shell && !body.includes(`"tool_use_id":"${id}"`)
      if (!request.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'msg_plain', type: 'message', role: 'assistant', model: 'cli-preset-mock', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
        return
      }
      sse(res, ask ? { type: 'tool_use', id, name: shell, input: { command: PROBE, description: 'Report the Halo CLI tools this session can run' } } : { type: 'text', text: 'done' })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return Object.assign(model, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  })
}

function parseProbe(text: string) {
  const bin = /CLI_BIN=(.*)/.exec(text)?.[1]?.trim() ?? ''
  return {
    bin,
    prettierPath: /PRETTIER_PATH=(.*)/.exec(text)?.[1]?.trim() ?? '',
    prettier: /^3\.9\.10$/m.test(text),
    tsc: /Version 5\.9\.3/.test(text),
    jsYaml: /"a"\s*:\s*1/.test(text),
    pathTail: /PATH_TAIL=(.*)/.exec(text)?.[1]?.trim() ?? '',
    guide: text.includes('prettier') && text.includes('#'),
  }
}

function expectProbe(label: string, text: string, cliRoot: string) {
  const probe = parseProbe(text)
  expect.soft(probe.bin, `${label}: HALO_CLI_TOOLS_BIN points into the app's own tool views`).toMatch(new RegExp(`^${cliRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/views/[^/]+/bin$`))
  expect.soft(probe.prettierPath, `${label}: prettier resolves to the launcher`).toBe(path.join(probe.bin, 'prettier'))
  expect.soft(probe.prettier, `${label}: prettier 3.9.10 runs`).toBe(true)
  expect.soft(probe.tsc, `${label}: tsc 5.9.3 runs`).toBe(true)
  expect.soft(probe.jsYaml, `${label}: js-yaml (ESM entry) runs`).toBe(true)
  expect.soft(probe.pathTail, `${label}: launchers are appended after every existing PATH entry`).toBe(probe.bin)
  return probe
}

const SHELL_FILES = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile', '.zshenv']

const ENGINE_NAMES = { halo: 'Halo', anthropic: 'Claude Code', dsh: 'DSH (experimental)' } as const

for (const sdkEngine of ['halo', 'anthropic', 'dsh'] as const) {
  test.describe(`Preset CLI tools with ${ENGINE_NAMES[sdkEngine]}`, () => {
    test.use({ sdkEngine, hostCommands: 'system-only', explicitClaudeCode: sdkEngine === 'anthropic' })

    test('preset tools are imported once and reach chat, digital-human chat, automation and the terminal', async ({ electronApp, window }, testInfo) => {
      expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(true)
      const engine = await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
      const engineState = engine.data as { activeEngine?: string; degradedFrom?: string | null; engines?: Array<{ engineId: string; available: boolean; version: string }> } | undefined
      expect(engineState, 'a fallback engine cannot provide evidence for the requested engine').toMatchObject({ activeEngine: sdkEngine, degradedFrom: null })
      const runtime = await electronApp.evaluate(({ app }) => ({
        userData: app.getPath('userData'), resources: process.resourcesPath, mainPath: process.env.PATH ?? '', home: process.env.HOME ?? '',
      }))
      const cliRoot = path.join(runtime.userData, 'cli')
      const shellBefore = Object.fromEntries(SHELL_FILES.map(name => [name, fs.existsSync(path.join(runtime.home, name))]))
      // The trust file ships next to the packages; it is not a tool.
      const packaged = fs.readdirSync(path.join(runtime.resources, 'cli-preset')).filter(name => name.endsWith('.hcli')).sort()
      expect(packaged).toEqual(['com.github.nodeca.js-yaml-5.5.0.hcli', 'io.prettier.cli-3.9.10.hcli', 'org.typescriptlang.tsc-5.9.3.hcli'])

      const model = await startScriptedModel()
      const evidence: Record<string, unknown> = {
        engine: sdkEngine, activeEngine: engineState?.activeEngine,
        engines: engineState?.engines?.map(({ engineId, available, version }) => ({ engineId, available, version })), packaged, cliRoot,
      }
      try {
        const sources = await window.evaluate(async url => {
          const halo = (window as unknown as { halo: HaloAPI }).halo
          const now = new Date().toISOString()
          const scripted = {
            id: 'cli-preset-scripted-model', name: 'Scripted model', provider: 'anthropic', authType: 'api-key',
            apiUrl: url, apiKey: 'sk-cli-preset-scripted', model: 'cli-preset-mock',
            availableModels: [{ id: 'cli-preset-mock', name: 'cli-preset-mock' }], createdAt: now, updatedAt: now,
          }
          const added = await halo.aiSourcesAddSource(scripted)
          if (!added.success) throw new Error(`Could not add the scripted model: ${added.error}`)
          const switched = await halo.aiSourcesSwitchSource(scripted.id)
          if (!switched.success) throw new Error(`Could not select the scripted model: ${switched.error}`)
          const config = (await halo.getConfig()).data as { aiSources: { sources: Array<{ id: string }> } }
          for (const other of config.aiSources.sources.filter(source => source.id !== scripted.id)) {
            const deleted = await halo.aiSourcesDeleteSource(other.id)
            if (!deleted.success) throw new Error(`Could not remove account ${other.id}: ${deleted.error}`)
          }
          return ((await halo.getConfig()).data as { aiSources: { currentId: string } }).aiSources.currentId
        }, model.url)
        expect(sources).toBe('cli-preset-scripted-model')
        await window.reload()
        await navigateToChat(window)
        await expect(window.getByRole('button', { name: 'cli-preset-mock', exact: true })).toBeVisible()

        // Ordinary chat.
        await window.locator('textarea').fill(`${ENTRIES.chat} run the tool check`)
        await window.locator('[data-onboarding="send-button"]').click({ force: true })
        await expect.poll(() => model.results.has('chat'), { timeout: 120000 }).toBe(true)
        evidence.chat = model.results.get('chat')
        expect.soft(model.results.get('chat')!.isError, 'chat: probe command exits 0').toBe(false)
        const chat = expectProbe('chat', model.results.get('chat')!.text, cliRoot)

        // Import happened once and left a stamp; the main process PATH is untouched.
        const stamp = JSON.parse(fs.readFileSync(path.join(cliRoot, 'preset-stamp.json'), 'utf8'))
        const state = JSON.parse(fs.readFileSync(path.join(cliRoot, 'state.json'), 'utf8')) as { tools: Record<string, { current?: string; source?: string; versions: Record<string, { source?: string }> }> }
        evidence.stamp = stamp
        evidence.state = Object.fromEntries(Object.entries(state.tools).map(([id, tool]) => [id, { current: tool.current, versions: Object.fromEntries(Object.entries(tool.versions).map(([v, r]) => [v, r.source])) }]))
        expect(Object.fromEntries(Object.entries(state.tools).map(([id, tool]) => [id, tool.current]))).toEqual({
          'com.github.nodeca.js-yaml': '5.5.0', 'io.prettier.cli': '3.9.10', 'org.typescriptlang.tsc': '5.9.3',
        })
        expect.soft(Object.values(state.tools).every(tool => Object.values(tool.versions).every(record => record.source === 'preset')), 'every version came from the package').toBe(true)
        const mainPath = await electronApp.evaluate(() => process.env.PATH ?? '')
        expect.soft(mainPath.includes(cliRoot), 'the main process PATH never carries the launchers').toBe(false)

        // Digital-human chat (also the path IM and team members take).
        const install = async (name: string, marker: string) => {
          const result = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appInstall({ spaceId: 'halo-temp', spec: {
            spec_version: '1.0', version: '1.0.0', type: 'automation', name: input.name, author: 'CLI preset fixture',
            description: 'Runs the CLI tool probe.', system_prompt: `${input.marker}: when asked, run the requested shell check.`,
            subscriptions: [], requires: {}, config_schema: [], permissions: [],
          } }), { name, marker })
          expect(result.success, `install ${name}: ${result.error ?? ''}`).toBe(true)
          return (result.data as { appId: string }).appId
        }
        const dhId = await install('CLI probe chat human', ENTRIES.dh)
        const sent = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSend({ appId, spaceId: 'halo-temp', message: 'Run the tool check' }), dhId)
        expect(sent.success, `appChatSend: ${sent.error ?? ''}`).toBe(true)
        await expect.poll(() => model.results.has('dh'), { timeout: 120000 }).toBe(true)
        evidence.dh = model.results.get('dh')
        expect.soft(model.results.get('dh')!.isError, 'digital-human chat: probe command exits 0').toBe(false)
        const dh = expectProbe('digital-human chat', model.results.get('dh')!.text, cliRoot)

        // Automation run.
        const autoId = await install('CLI probe automation', ENTRIES.auto)
        const triggered = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appTrigger(appId), autoId)
        expect(triggered.success, `appTrigger: ${triggered.error ?? ''}`).toBe(true)
        await expect.poll(() => model.results.has('auto'), { timeout: 120000 }).toBe(true)
        evidence.auto = model.results.get('auto')
        expect.soft(model.results.get('auto')!.isError, 'automation: probe command exits 0').toBe(false)
        const auto = expectProbe('automation', model.results.get('auto')!.text, cliRoot)

        // Same tool set, same view, for every entry in one process.
        expect.soft(new Set([chat.bin, dh.bin, auto.bin]).size, 'one tool set maps to one view').toBe(1)

        // AI terminal.
        const created = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.createTerminal({ spaceId: 'halo-temp' }))
        expect(created.success, `createTerminal: ${created.error ?? ''}`).toBe(true)
        const sessionId = await window.evaluate(async () => {
          const result = await (globalThis as unknown as { halo: HaloAPI }).halo.listTerminals()
          return (result.data as Array<{ id: string }>)[0].id
        })
        await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.terminalInput({ sessionId: input.sessionId, data: `${input.probe}; printf 'TERM_%s\\n' DONE\r` }), { sessionId, probe: PROBE })
        let replay = ''
        await expect.poll(async () => {
          replay = await window.evaluate(async id => JSON.stringify((await (globalThis as unknown as { halo: HaloAPI }).halo.getTerminalReplay({ sessionId: id })).data), sessionId)
          return replay.includes('TERM_DONE')
        }, { timeout: 30000 }).toBe(true)
        const terminalText = JSON.parse(replay) as unknown
        const flat = typeof terminalText === 'string' ? terminalText : JSON.stringify(terminalText)
        evidence.terminal = flat.slice(-4000)
        expect.soft(/CLI_BIN=\S*\/cli\/views\/[^/\s]+\/bin/.test(flat), 'terminal: HALO_CLI_TOOLS_BIN is set').toBe(true)
        expect.soft(/Version 5\.9\.3/.test(flat), 'terminal: tsc runs').toBe(true)
        expect.soft(/3\.9\.10/.test(flat), 'terminal: prettier runs').toBe(true)
        await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.killTerminal({ sessionId: id }), sessionId)

        // Guidance reaches the model as a Skill; the profile's shell files are untouched.
        evidence.skillAdvertised = model.skillAdvertised
        expect.soft(model.skillAdvertised, 'the halo-cli-tools skill is offered to the model').toBe(true)
        const shellAfter = Object.fromEntries(SHELL_FILES.map(name => [name, fs.existsSync(path.join(runtime.home, name))]))
        evidence.shellFiles = { before: shellBefore, after: shellAfter }
        expect.soft(shellAfter, 'no shell startup file is created or removed').toEqual(shellBefore)
        evidence.views = fs.readdirSync(path.join(cliRoot, 'views'))
        evidence.locks = fs.existsSync(path.join(cliRoot, 'locks')) ? fs.readdirSync(path.join(cliRoot, 'locks')) : []
      } finally {
        await testInfo.attach('cli-preset-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
        await model.close()
      }
    })
  })
}
