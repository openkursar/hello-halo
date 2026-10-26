/**
 * What the AI's own tools can do in an installed (packaged) Halo.
 *
 * These break only in a packaged build — dev runs and the built-but-unpacked
 * E2E app load everything from real folders — and they broke silently when
 * Electron 43 stopped redirecting the CLI's program launches out of app.asar
 * and electron-builder 26 stopped shipping the Office runtime's libraries.
 * A scripted model asks for each tool once; the assertions read what the CLI
 * sent back to the model.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import type { HaloAPI } from '../../../src/preload'
import { test, expect } from '../fixtures/electron-packaged'
import { navigateToChat } from '../fixtures/helpers'

test.setTimeout(180000)

const AGENT = 'e43-probe-agent'
const COMMAND = 'e43-probe-command'
const NEEDLE = 'e43-needle-text'

type ToolResult = { text: string; isError: boolean; hasImage: boolean }
type ModelBlock =
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'text'; text: string }

interface ScriptedModel {
  url: string
  /** Tool results by tool_use id, once the CLI has sent them back. */
  results: Map<string, ToolResult>
  sawAgent: boolean
  sawCommand: boolean
  close(): Promise<void>
}

function sse(res: http.ServerResponse, blocks: ModelBlock[], stop: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const events: Array<{ type: string } & Record<string, unknown>> = [
    { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'e43-mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    ...blocks.flatMap((block, index): Array<{ type: string } & Record<string, unknown>> => block.type === 'tool_use'
      ? [{ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } },
         { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
         { type: 'content_block_stop', index }]
      : [{ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
         { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
         { type: 'content_block_stop', index }]),
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
}

async function startScriptedModel(workDir: string): Promise<ScriptedModel> {
  const toolCalls: ModelBlock[] = [
    { type: 'tool_use', id: 'toolu_grep', name: 'Grep', input: { pattern: NEEDLE, path: workDir } },
    { type: 'tool_use', id: 'toolu_glob', name: 'Glob', input: { pattern: '**/e43-needle.txt', path: workDir } },
    { type: 'tool_use', id: 'toolu_rg', name: 'Bash', input: { command: 'rg --version', description: 'Show the bundled ripgrep version' } },
    { type: 'tool_use', id: 'toolu_office', name: 'Bash', input: { command: `halo-node -e "require('exceljs'); require('docx'); console.log('office-runtime-ok')"`, description: 'Load the bundled Office libraries' } },
    { type: 'tool_use', id: 'toolu_image', name: 'Read', input: { file_path: path.join(workDir, 'e43-large.png') } },
  ]
  const model: Omit<ScriptedModel, 'url' | 'close'> = { results: new Map(), sawAgent: false, sawCommand: false }

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.includes('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      const request = JSON.parse(body || '{}') as { stream?: boolean; tools?: Array<{ name: string; description?: string }>; messages?: Array<{ content: unknown }> }
      const messages = JSON.stringify(request.messages ?? [])
      if (request.tools?.some(tool => tool.name === 'Agent' && tool.description?.includes(AGENT))) model.sawAgent = true
      if (messages.includes(COMMAND)) model.sawCommand = true

      for (const message of request.messages ?? []) {
        if (!Array.isArray(message.content)) continue
        for (const block of message.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue
          const parts = Array.isArray(block.content) ? block.content as Array<{ type: string; text?: string }> : [{ type: 'text', text: String(block.content ?? '') }]
          model.results.set(block.tool_use_id, {
            text: parts.filter(part => part.type === 'text').map(part => part.text).join('\n'),
            isError: block.is_error === true,
            hasImage: parts.some(part => part.type === 'image'),
          })
        }
      }

      const askForTools = request.tools?.some(tool => tool.name === 'Grep') && !messages.includes('"tool_result"')
      const blocks: ModelBlock[] = askForTools ? toolCalls : [{ type: 'text', text: 'done' }]
      const stop = askForTools ? 'tool_use' : 'end_turn'
      if (request.stream) {
        sse(res, blocks, stop)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_plain', type: 'message', role: 'assistant', model: 'e43-mock', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return Object.assign(model, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  })
}

/** A PNG large enough that the CLI must downscale it through its bundled image library. */
function largePng(width = 2400, height = 1600): Buffer {
  const row = Buffer.alloc(1 + width * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (data: Buffer): number => {
    let c = 0xffffffff
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The folder a new conversation's engine starts in, with a project agent and command of its own. */
function seedProject(workDir: string): void {
  fs.mkdirSync(path.join(workDir, '.claude', 'agents'), { recursive: true })
  fs.mkdirSync(path.join(workDir, '.claude', 'commands'), { recursive: true })
  fs.writeFileSync(path.join(workDir, '.claude', 'agents', `${AGENT}.md`), `---\nname: ${AGENT}\ndescription: Project subagent the packaged check looks for\n---\nYou are a probe.\n`)
  fs.writeFileSync(path.join(workDir, '.claude', 'commands', `${COMMAND}.md`), `---\ndescription: Project command the packaged check looks for\n---\nSay probe.\n`)
  fs.writeFileSync(path.join(workDir, 'e43-needle.txt'), `${NEEDLE}\n`)
  fs.writeFileSync(path.join(workDir, 'e43-large.png'), largePng())
}

test('the packaged AI can search files, run the bundled ripgrep and Office runtime, read large images, and sees project agents and commands', { annotation: { type: 'acceptance', description: "{\"caseId\":\"terminal.environment.packaged-tools\",\"evidence\":\"app-e2e\",\"mode\":\"scripted\",\"variant\":{}}" } }, async ({ electronApp, window }) => {
  expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(true)
  const dataDir = await electronApp.evaluate(() => process.env.HALO_DATA_DIR)
  expect(dataDir).toBeTruthy()
  // The Halo temporary space, where a conversation opened from the rail runs.
  const workDir = path.join(dataDir!, 'temp', 'artifacts')
  seedProject(workDir)

  const model = await startScriptedModel(workDir)
  try {
    // The scripted model becomes the only account, so no turn can reach a real one
    // a profile may have been given through HALO_TEST_* variables.
    const sources = await window.evaluate(async url => {
      const halo = (window as unknown as { halo: HaloAPI }).halo
      const now = new Date().toISOString()
      const scripted = {
        id: 'e43-scripted-model', name: 'Scripted model', provider: 'anthropic', authType: 'api-key',
        apiUrl: url, apiKey: 'sk-e43-scripted', model: 'e43-mock',
        availableModels: [{ id: 'e43-mock', name: 'e43-mock' }], createdAt: now, updatedAt: now,
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
      const final = (await halo.getConfig()).data as { aiSources: { currentId: string; sources: Array<{ id: string }> } }
      return { currentId: final.aiSources.currentId, ids: final.aiSources.sources.map(source => source.id) }
    }, model.url)
    expect(sources).toEqual({ currentId: 'e43-scripted-model', ids: ['e43-scripted-model'] })
    await window.reload()
    await navigateToChat(window)
    await expect(window.getByRole('button', { name: 'e43-mock', exact: true })).toBeVisible()

    await window.locator('textarea').fill('Run the packaged tool check')
    await window.locator('[data-onboarding="send-button"]').click({ force: true })
    await expect.poll(() => model.results.size, { timeout: 120000 }).toBe(5)
    await expect(window.getByText('Halo is working', { exact: true })).toHaveCount(0, { timeout: 60000 })

    // Soft, so one run reports every capability a build lost, not just the first.
    const result = (id: string): ToolResult => model.results.get(id)!
    expect.soft(result('toolu_grep'), 'Grep').toMatchObject({ isError: false, text: expect.stringContaining('e43-needle.txt') })
    expect.soft(result('toolu_glob'), 'Glob').toMatchObject({ isError: false, text: expect.stringContaining('e43-needle.txt') })
    expect.soft(result('toolu_rg').text, 'rg in the shell').toMatch(/^ripgrep \d+\.\d+/m)
    expect.soft(result('toolu_office').text, 'halo-node with the Office libraries').toContain('office-runtime-ok')
    expect.soft(result('toolu_image'), 'Read of an oversized image').toMatchObject({ isError: false, hasImage: true })
    expect.soft(model.sawAgent, 'project subagent offered to the model').toBe(true)
    expect.soft(model.sawCommand, 'project command offered to the model').toBe(true)
  } finally {
    await model.close()
  }
})
