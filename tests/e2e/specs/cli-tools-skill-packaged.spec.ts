/**
 * Command-line tool skills in an installed (packaged) Halo.
 *
 * A scripted model checks that the tool's skill is offered, loads it through
 * the engine's Skill tool and runs the command by the absolute path the skill
 * names — two tool calls — in ordinary chat and digital-human chat.
 *
 * Needs a package built with npm.cowsay-1.6.0.hcli in resources/cli-preset
 * (git-ignored), so it is not part of any default project. The model is
 * scripted: this shows the wiring, not that a real model picks the skill.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import { test, expect } from '../fixtures/electron-packaged'
import { navigateToChat } from '../fixtures/helpers'

test.setTimeout(300000)

const TOOL_ID = 'npm.cowsay'
/** `<command>-<tool id>-<install id>`; the install id is chosen on this device. */
const SKILL = /cowsay-npm-cowsay-[0-9a-f]{6}/
const ENTRIES = { chat: 'CLI_SKILL_CHAT', dh: 'CLI_SKILL_DH' } as const
type Entry = keyof typeof ENTRIES

interface EntryRecord {
  advertised: boolean
  skillName?: string
  skillTool?: string
  skillResult?: { text: string; isError: boolean }
  launcher?: string
  run?: { text: string; isError: boolean }
}

interface ScriptedModel {
  url: string
  entries: Map<Entry, EntryRecord>
  close(): Promise<void>
}

type Block = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | { type: 'text'; text: string }

function sse(res: http.ServerResponse, block: Block): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const start = block.type === 'tool_use'
    ? [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } },
       { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }]
    : [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
       { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } }]
  const events = [
    { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'cli-skill-mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    ...start,
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
}

function toolResult(messages: Array<{ content: unknown }>, id: string): { text: string; isError: boolean } | undefined {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
      if (part.type !== 'tool_result' || part.tool_use_id !== id) continue
      const pieces = Array.isArray(part.content) ? part.content as Array<{ type: string; text?: string }> : [{ type: 'text', text: String(part.content ?? '') }]
      return { text: pieces.filter(piece => piece.type === 'text').map(piece => piece.text).join('\n'), isError: part.is_error === true }
    }
  }
  return undefined
}

async function startScriptedModel(): Promise<ScriptedModel> {
  const entries = new Map<Entry, EntryRecord>()
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.includes('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      const request = JSON.parse(body || '{}') as { stream?: boolean; tools?: Array<{ name: string }>; messages?: Array<{ content: unknown }> }
      if (!request.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'msg_plain', type: 'message', role: 'assistant', model: 'cli-skill-mock', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
        return
      }
      const entry = (['dh', 'chat'] as const).find(key => body.includes(ENTRIES[key]))
      // Claude Code and Halo name the tool Skill and take `skill`; DSH names it skill and takes `name`.
      const skillTool = request.tools?.find(tool => tool.name === 'Skill' || tool.name === 'skill')?.name
      const shell = request.tools?.find(tool => tool.name === 'Bash' || tool.name === 'bash')?.name
      if (!entry || !shell) { sse(res, { type: 'text', text: 'done' }); return }
      const record = entries.get(entry) ?? { advertised: false }
      entries.set(entry, record)
      const messages = request.messages ?? []
      const loadId = `toolu_skill_${entry}`
      const runId = `toolu_run_${entry}`
      const loaded = toolResult(messages, loadId)
      const ran = toolResult(messages, runId)
      if (!loaded && !ran) {
        record.skillName = SKILL.exec(body)?.[0]
        record.advertised = !!record.skillName
        record.skillTool = skillTool
        if (skillTool && record.skillName) {
          sse(res, { type: 'tool_use', id: loadId, name: skillTool, input: skillTool === 'skill' ? { name: record.skillName } : { skill: record.skillName } })
          return
        }
      }
      if (loaded && !ran) {
        record.skillResult = loaded
        record.launcher = /- `cowsay`: `([^`]+)`/.exec(loaded.text)?.[1]
        sse(res, { type: 'tool_use', id: runId, name: shell, input: { command: `"${record.launcher ?? 'missing-launcher'}" CLI_SKILL_MOO`, description: 'Run the command the skill names' } })
        return
      }
      record.run = ran
      sse(res, { type: 'text', text: 'done' })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { entries, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

const ENGINE_NAMES = { halo: 'Halo', anthropic: 'Claude Code', dsh: 'DSH (experimental)' } as const

for (const sdkEngine of ['halo', 'anthropic', 'dsh'] as const) {
  test.describe(`Command-line tool skills with ${ENGINE_NAMES[sdkEngine]}`, () => {
    test.use({ sdkEngine, hostCommands: 'system-only', explicitClaudeCode: sdkEngine === 'anthropic' })

    test('a tool skill is offered, loads through the Skill tool and leads to the command, in chat and digital-human chat', {
      annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'capabilities.command-line-tools.skill-runs-tool', evidence: 'app-e2e', mode: 'scripted', variant: { engine: sdkEngine } }) },
    }, async ({ electronApp, window }, testInfo) => {
      expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(true)
      const engine = await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
      const engineState = engine.data as { activeEngine?: string; degradedFrom?: string | null } | undefined
      expect(engineState, 'a fallback engine cannot provide evidence for the requested engine').toMatchObject({ activeEngine: sdkEngine, degradedFrom: null })
      // Built-in skills ship inside the app archive, which only the main process reads.
      const runtime = await electronApp.evaluate(({ app }) => {
        const fsMain = process.getBuiltinModule('fs') as typeof import('fs')
        const builtin = (process.getBuiltinModule('path') as typeof import('path')).join(app.getAppPath(), 'resources', 'builtin-skills')
        const home = (process.getBuiltinModule('os') as typeof import('os')).homedir()
        return { home, userData: app.getPath('userData'), resources: process.resourcesPath, builtinSkills: fsMain.existsSync(builtin) ? fsMain.readdirSync(builtin) : null }
      })
      const cliRoot = path.join(runtime.userData, 'cli')
      const packaged = fs.readdirSync(path.join(runtime.resources, 'cli-preset')).filter(name => name.endsWith('.hcli'))
      expect(packaged).toContain('npm.cowsay-1.6.0.hcli')
      expect(runtime.builtinSkills, 'the package ships its built-in skills').not.toBeNull()
      expect(runtime.builtinSkills, 'the generic tool guide skill no longer ships').not.toContain('halo-cli-tools')
      const skillsDir = path.join(runtime.home, '.agents', 'skills')
      const skillName = () => (fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : []).find(name => SKILL.test(name))
      await expect.poll(skillName, { timeout: 30000 }).toBeTruthy()
      const launcher = path.join(cliRoot, 'tools', TOOL_ID, 'bin', 'cowsay')
      const skillText = fs.readFileSync(path.join(skillsDir, skillName()!, 'SKILL.md'), 'utf8')
      expect(skillText).toContain(`- \`cowsay\`: \`${launcher}\``)
      expect(skillText).not.toMatch(/HALO_CLI_TOOLS_BIN|TOOLS\.md/)

      const model = await startScriptedModel()
      const evidence: Record<string, unknown> = { engine: sdkEngine, packaged }
      try {
        const current = await window.evaluate(async url => {
          const halo = (window as unknown as { halo: HaloAPI }).halo
          const now = new Date().toISOString()
          const scripted = {
            id: 'cli-skill-scripted-model', name: 'Scripted model', provider: 'anthropic', authType: 'api-key',
            apiUrl: url, apiKey: 'sk-cli-skill-scripted', model: 'cli-skill-mock',
            availableModels: [{ id: 'cli-skill-mock', name: 'cli-skill-mock' }], createdAt: now, updatedAt: now,
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
        expect(current).toBe('cli-skill-scripted-model')
        await window.reload()
        await navigateToChat(window)
        await expect(window.getByRole('button', { name: 'cli-skill-mock', exact: true })).toBeVisible()

        const check = (label: string, entry: Entry) => {
          const record = model.entries.get(entry)!
          evidence[entry] = record
          expect.soft(record.advertised, `${label}: the cowsay skill is offered to the model`).toBe(true)
          expect.soft(record.skillTool, `${label}: the session has a Skill tool`).toBeTruthy()
          expect.soft(record.skillResult?.isError, `${label}: loading the skill succeeds`).toBe(false)
          expect.soft(record.launcher, `${label}: the skill names the fixed launcher`).toBe(path.join(cliRoot, 'tools', TOOL_ID, 'bin', 'cowsay'))
          expect.soft(record.run?.isError, `${label}: the command exits 0`).toBe(false)
          expect.soft(record.run?.text ?? '', `${label}: the command ran`).toContain('CLI_SKILL_MOO')
        }

        // Ordinary chat.
        await window.locator('textarea').fill(`${ENTRIES.chat} say moo with the tool`)
        await window.locator('[data-onboarding="send-button"]').click({ force: true })
        await expect.poll(() => model.entries.get('chat')?.run !== undefined, { timeout: 120000 }).toBe(true)
        check('chat', 'chat')

        // Digital-human chat (also the path IM and team members take).
        const installed = await window.evaluate(marker => (globalThis as unknown as { halo: HaloAPI }).halo.appInstall({ spaceId: 'halo-temp', spec: {
          spec_version: '1.0', version: '1.0.0', type: 'automation', name: 'CLI skill human', author: 'CLI skill fixture',
          description: 'Uses a command-line tool.', system_prompt: `${marker}: use the tools you are given.`,
          subscriptions: [], requires: {}, config_schema: [], permissions: [],
        } }), ENTRIES.dh)
        expect(installed.success, `install: ${installed.error ?? ''}`).toBe(true)
        const appId = (installed.data as { appId: string }).appId
        const sent = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSend({ appId: id, spaceId: 'halo-temp', message: 'Say moo with the tool' }), appId)
        expect(sent.success, `appChatSend: ${sent.error ?? ''}`).toBe(true)
        await expect.poll(() => model.entries.get('dh')?.run !== undefined, { timeout: 120000 }).toBe(true)
        check('digital-human chat', 'dh')

        expect(fs.existsSync(path.join(cliRoot, 'views'))).toBe(false)
        evidence.install = JSON.parse(fs.readFileSync(path.join(cliRoot, 'tools', TOOL_ID, 'install.json'), 'utf8'))
      } finally {
        await testInfo.attach('cli-skill-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
        await model.close()
      }
    })
  })
}
