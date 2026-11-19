import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import type { EngineSessionBinding } from '../../../src/shared/types/engine-session'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { modelTool } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'
import { openManagedConversation } from '../fixtures/acceptance-management'

const reference = 'copper-runtime-582'
const firstAnswer = `The local capability completed. Reference: ${reference}.`
const resumedAnswer = `The original reference remains ${reference}.`

test.describe('Selected external Codex runtime', () => {
  test.use({ sdkEngine: 'codex', aiSource: async ({ model }, use) => {
    await use({ provider: 'openai', apiType: 'chat_completions', apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: 'gpt-4o' })
  } })

  test('executes a host MCP capability and resumes the same native conversation after restart', acceptance('models.engines.codex-runtime'), async ({ acceptanceApp, model, window }, testInfo) => {
    test.setTimeout(180000)
    const errors: string[] = []
    let capabilityCompleted = false
    let capturedToolResult = ''
    let resumedContext = false
    model.respond(request => {
      if (request.text.includes('CODEX_RUNTIME_RESUME')) {
        resumedContext = request.text.includes(reference) && request.text.includes(firstAnswer) && request.toolResults.some(result => result.id === 'runtime-doc' && result.text === capturedToolResult)
        return { text: resumedAnswer }
      }
      const result = request.toolResults.find(result => result.id === 'runtime-doc')
      if (result) {
        capturedToolResult = result.text
        capabilityCompleted = !result.error && capturedToolResult.trim().length > 0
        if (!capabilityCompleted) errors.push('The local collaboration board capability returned no successful content.')
        return { text: firstAnswer }
      }
      const name = request.tools.find(name => name === 'record_receipt' || name.endsWith('__record_receipt'))
      if (!name && request.tools.includes('ToolSearch') && !request.toolResults.some(result => result.id === 'runtime-discovery')) {
        return { tools: [modelTool(request, 'ToolSearch', { query: 'record_receipt', max_results: 1 }, 'runtime-discovery')] }
      }
      if (!name) {
        errors.push('The selected runtime did not expose the local collaboration board capability.')
        return { text: 'The capability is unavailable.' }
      }
      return { tools: [modelTool(request, name, { reference }, 'runtime-doc')] }
    })
    const effects = join(acceptanceApp.profile, 'codex-tool-effects.jsonl')
    const server = join(acceptanceApp.profile, 'codex-tool-server.cjs')
    await writeFile(server, `const readline = require('node:readline'); const fs = require('node:fs');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'runtime-receipt', version: '1.0.0' } };
  if (request.method === 'tools/list') result = { tools: [{ name: 'record_receipt', description: 'Record a local test receipt', inputSchema: { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'], additionalProperties: false } }] };
  if (request.method === 'tools/call') { fs.appendFileSync(process.argv[2], JSON.stringify({ name: request.params.name, arguments: request.params.arguments }) + '\\n'); result = { content: [{ type: 'text', text: 'Recorded receipt ' + request.params.arguments.reference }] }; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});`)
    const firstPage = await acceptanceApp.restart(async profile => {
      const configPath = join(profile, '.halo/config.json')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      config.mcpServers = { 'runtime-receipt': { command: process.execPath, args: [server, effects] } }
      await writeFile(configPath, JSON.stringify(config))
    })
    await navigateToChat(firstPage)
    const turn = await sendAcceptanceMessage(firstPage, `CODEX_RUNTIME_MCP: Record the reference ${reference} once using record_receipt.`)
    await expect(firstPage.locator('.message-assistant [data-message-content]').filter({ hasText: firstAnswer }).last()).toBeVisible({ timeout: 120000 })
    await waitForAcceptanceIdle(firstPage, turn.conversationId)
    const prior = await firstPage.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.getConversation(input.spaceId, input.conversationId), turn)
    expect(prior.success).toBe(true)
    const conversation = prior.data as { title: string; engineBinding: EngineSessionBinding }
    expect(conversation.engineBinding).toMatchObject({ engineId: 'codex' })
    expect(capabilityCompleted).toBe(true)
    expect(errors).toEqual([])

    const page = await acceptanceApp.restart()
    await openManagedConversation(page, conversation.title, turn.spaceId)
    await sendAcceptanceMessage(page, 'CODEX_RUNTIME_RESUME: Continue the original reference.', { expectedTarget: turn })
    await expect(page.locator('.message-assistant [data-message-content]').filter({ hasText: resumedAnswer }).last()).toBeVisible({ timeout: 120000 })
    await waitForAcceptanceIdle(page, turn.conversationId)
    const current = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.getConversation(input.spaceId, input.conversationId), turn)
    expect(current.success).toBe(true)
    expect((current.data as { engineBinding: EngineSessionBinding }).engineBinding).toEqual(conversation.engineBinding)
    expect(resumedContext).toBe(true)
    expect((await readFile(effects, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([{ name: 'record_receipt', arguments: { reference } }])
    expect(errors).toEqual([])
    await testInfo.attach('codex-runtime-continuity', { body: JSON.stringify({ binding: conversation.engineBinding, capabilityCompleted, resumedContext, requests: model.exchanges.length }), contentType: 'application/json' })
  })
})
