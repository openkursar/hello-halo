/**
 * Drives a CLI tool probe through every user-facing entry of a packaged Halo
 * with a scripted model: ordinary chat, digital-human chat, automation, a
 * temporary collaborator spawned from chat, a persistent team run, and the AI
 * terminal. Each request is routed by a marker `CLI_PROBE[<entry>:<round>]`
 * found in the first user input or the system prompt; the shell output the
 * engine sends back is what the assertions read.
 */

import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { expect } from './electron-packaged'
import { initialUserInput, startAcceptanceModel, type ModelReply, type ModelRequest } from './acceptance-model'
import { collaboratorReceipt } from './acceptance-collaboration'
import { planModelTool } from './acceptance-tool-discovery'
import { navigateToChat } from './helpers'

export type ProbeEntry = 'chat' | 'dh' | 'auto' | 'collab' | 'team' | 'terminal'
export interface ProbeResult { text: string; isError: boolean }

const MARKER = /CLI_PROBE\[(chat|dh|auto|collab-lead|collab|team):([A-Za-z0-9_-]+)\]/

/** A shell line that reports the launcher directory and each command's version or absence. Always exits 0. */
export function probeCommand(commands: string[]): string {
  return [
    `printf 'CLI_BIN=%s\\n' "$HALO_CLI_TOOLS_BIN"`,
    ...commands.map(name => `if command -v ${name} >/dev/null 2>&1; then printf 'CMD ${name}='; ${name} --version 2>&1 | head -1; else printf 'CMD ${name}=MISSING\\n'; fi`),
    `printf 'PROBE_%s\\n' END`,
  ].join('; ')
}

/** Parses `CMD name=value` lines into { name: value }. */
export function parseProbe(text: string): { bin: string; commands: Record<string, string> } {
  const commands: Record<string, string> = {}
  for (const match of text.matchAll(/^CMD ([a-z0-9._-]+)=(.*)$/gm)) commands[match[1]] = match[2].trim()
  return { bin: /CLI_BIN=(.*)/.exec(text)?.[1]?.trim() ?? '', commands }
}

type Api = HaloAPI

export async function startEntryModel() {
  const model = await startAcceptanceModel()
  const results = new Map<string, ProbeResult>()
  const issues: string[] = []
  const commandsByRound = new Map<string, string[]>()

  function call(request: ModelRequest, name: string, input: Record<string, unknown>, id: string): ModelReply {
    const shell = name === 'Bash' ? request.tools.find(tool => tool === 'Bash' || tool === 'bash') : undefined
    if (shell) return { tools: [{ id, name: shell, input }] }
    const next = planModelTool(request, name, input, id)
    if ('error' in next) { issues.push(next.error); return { text: `Tool ${name} is unavailable.` } }
    if (next.call.name === 'CallTool') {
      const definition = (request.body.tools ?? []).find((entry: Record<string, any>) => (entry.function?.name ?? entry.name) === 'CallTool')
      const schema = definition?.input_schema ?? definition?.function?.parameters
      if (schema?.properties?.arguments?.type === 'object') next.call.input.arguments = input
    }
    return { tools: [next.call] }
  }

  model.respond(request => {
    const system = JSON.stringify(request.body.system ?? '')
    const first = initialUserInput(request)
    const found = MARKER.exec(first) ?? MARKER.exec(system)
    if (!found) return { text: 'ok' }
    const [, entry, round] = found
    if (entry === 'collab-lead') {
      const spawnId = `spawn-${round}`
      const receipt = request.toolResults.find(result => result.id === spawnId)
      if (!receipt) return call(request, 'spawn_agent', { name: `CLI probe ${round}`, prompt: `CLI_PROBE[collab:${round}] Run the tool check with your shell and report back.` }, spawnId)
      try { collaboratorReceipt(receipt) } catch (error) { issues.push(String(error)) }
      return { text: 'The collaborator is running the tool check.' }
    }
    const probeId = `probe-${entry}-${round}`
    const result = request.toolResults.find(item => item.id === probeId)
    if (!result) {
      const commands = commandsByRound.get(round)
      if (!commands) { issues.push(`No commands registered for round ${round}`); return { text: 'No check defined.' } }
      return call(request, 'Bash', { command: probeCommand(commands), description: 'Report the Halo CLI tools this session can run' }, probeId)
    }
    results.set(`${entry}:${round}`, { text: result.text, isError: result.error })
    return { text: 'Tool check done.' }
  })

  return {
    url: model.url, results, issues, model,
    /** Declares which commands a round checks. */
    round(round: string, commands: string[]) { commandsByRound.set(round, commands) },
    async wait(entry: Exclude<ProbeEntry, 'terminal'>, round: string, timeout = 150000): Promise<ProbeResult> {
      await expect.poll(() => results.has(`${entry}:${round}`), { timeout, message: `${entry} probe for ${round}` }).toBe(true)
      return results.get(`${entry}:${round}`)!
    },
    close: () => model.close(),
  }
}

export type EntryModel = Awaited<ReturnType<typeof startEntryModel>>

/** Makes the scripted model the current account and removes every other one except `keep` (e.g. a seeded store identity). */
export async function useScriptedModel(page: Page, url: string, keep: string[] = []): Promise<void> {
  const current = await page.evaluate(async input => {
    const api = (globalThis as unknown as { halo: Api }).halo
    const now = new Date().toISOString()
    const scripted = {
      id: 'cli-e2e-scripted-model', name: 'Scripted model', provider: 'anthropic', authType: 'api-key',
      apiUrl: input.url, apiKey: 'sk-cli-e2e-scripted', model: 'cli-e2e-mock',
      availableModels: [{ id: 'cli-e2e-mock', name: 'cli-e2e-mock' }], createdAt: now, updatedAt: now,
    }
    const config = (await api.getConfig()).data as { aiSources: { sources: Array<{ id: string }> } }
    for (const other of config.aiSources.sources.filter(item => !input.keep.includes(item.id))) {
      const deleted = await api.aiSourcesDeleteSource(other.id)
      if (!deleted.success) throw new Error(`Could not remove account ${other.id}: ${deleted.error}`)
    }
    const added = await api.aiSourcesAddSource(scripted as never)
    if (!added.success) throw new Error(`Could not add the scripted model: ${added.error}`)
    const switched = await api.aiSourcesSwitchSource(scripted.id)
    if (!switched.success) throw new Error(`Could not select the scripted model: ${switched.error}`)
    return ((await api.getConfig()).data as { aiSources: { currentId: string } }).aiSources.currentId
  }, { url, keep })
  expect(current).toBe('cli-e2e-scripted-model')
}

async function installPerson(page: Page, name: string, systemPrompt: string): Promise<string> {
  const result = await page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.appInstall({ spaceId: 'halo-temp', spec: {
    spec_version: '1.0', version: '1.0.0', type: 'automation', name: input.name, author: 'CLI e2e fixture',
    description: 'Runs the CLI tool probe.', system_prompt: input.systemPrompt,
    subscriptions: [], requires: {}, config_schema: [], permissions: [],
  } } as never), { name, systemPrompt })
  expect(result.success, `install ${name}: ${result.error ?? ''}`).toBe(true)
  return (result.data as { appId: string }).appId
}

/** Starts one probe through the given entry. Chat and collaboration are sent through the visible composer in a new conversation. */
export async function startProbe(page: Page, entry: Exclude<ProbeEntry, 'terminal'>, round: string): Promise<void> {
  if (entry === 'chat' || entry === 'collab') {
    const marker = entry === 'chat' ? `CLI_PROBE[chat:${round}]` : `CLI_PROBE[collab-lead:${round}]`
    await navigateToChat(page)
    await page.getByRole('button', { name: 'New', exact: true }).click()
    await expect(page.locator('.message-user')).toHaveCount(0)
    await page.locator('textarea').fill(`${marker} run the tool check`)
    await page.locator('[data-onboarding="send-button"]').click({ force: true })
    await expect(page.locator('.message-user').filter({ hasText: marker })).toHaveCount(1)
    return
  }
  if (entry === 'dh') {
    const appId = await installPerson(page, `CLI probe chat ${round}`, 'When asked, run the requested shell check.')
    const sent = await page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.appChatSend({ appId: input.appId, spaceId: 'halo-temp', message: `CLI_PROBE[dh:${input.round}] Run the tool check` }), { appId, round })
    expect(sent.success, `appChatSend: ${sent.error ?? ''}`).toBe(true)
    return
  }
  if (entry === 'auto') {
    const appId = await installPerson(page, `CLI probe automation ${round}`, `CLI_PROBE[auto:${round}]: run the requested shell check.`)
    const triggered = await page.evaluate(id => (globalThis as unknown as { halo: Api }).halo.appTrigger(id), appId)
    expect(triggered.success, `appTrigger: ${triggered.error ?? ''}`).toBe(true)
    return
  }
  const memberId = await installPerson(page, `CLI probe member ${round}`, `CLI_PROBE[team:${round}]: run the requested shell check when the team asks.`)
  const created = await page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.teamCreate({ input: {
    name: `CLI probe team ${input.round}`, goal: 'Check which command line tools the team can run.', owningSpaceId: 'halo-temp',
    memberSourcing: 'manual' as const, collabMode: 'free' as const, escalationRouting: 'user' as const, leadAppId: input.memberId,
    members: [{ appId: input.memberId, memberName: 'Checker', role: 'Tool checker' }],
  } }), { memberId, round })
  expect(created.success, `teamCreate: ${created.error ?? ''}`).toBe(true)
  const teamId = (created.data as { id: string }).id
  const run = await page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.teamRun(input.teamId, { type: 'manual' }, `CLI_PROBE[team:${input.round}] Run the tool check`), { teamId, round })
  expect(run.success, `teamRun: ${run.error ?? ''}`).toBe(true)
}

/** Runs the probe in a new AI terminal session and returns its output. */
export async function terminalProbe(page: Page, commands: string[]): Promise<ProbeResult> {
  const created = await page.evaluate(() => (globalThis as unknown as { halo: Api }).halo.createTerminal({ spaceId: 'halo-temp' }))
  expect(created.success, `createTerminal: ${created.error ?? ''}`).toBe(true)
  const sessionId = await page.evaluate(async () => {
    const result = await (globalThis as unknown as { halo: Api }).halo.listTerminals()
    return (result.data as Array<{ id: string }>).at(-1)!.id
  })
  await page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.terminalInput({ sessionId: input.sessionId, data: `${input.command}\r` }), { sessionId, command: probeCommand(commands) })
  let text = ''
  await expect.poll(async () => {
    const replay = await page.evaluate(id => (globalThis as unknown as { halo: Api }).halo.getTerminalReplay({ sessionId: id }), sessionId)
    const raw = typeof replay.data === 'string' ? replay.data : JSON.stringify(replay.data)
    text = raw.replace(/\\r\\n|\\n|\r/g, '\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    return /^PROBE_END$/m.test(text)
  }, { timeout: 30000, message: 'terminal probe' }).toBe(true)
  await page.evaluate(id => (globalThis as unknown as { halo: Api }).halo.killTerminal({ sessionId: id }), sessionId)
  return { text, isError: false }
}
