import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect, type SkillServer } from '../fixtures/acceptance-skill-server'
import type { ModelRequest } from '../fixtures/acceptance-model'

interface Conversation {
  id: string
  messages: Array<{ role: string; content: string; error?: unknown }>
}

function binding(caseId: string) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'app-e2e', mode: 'scripted', variant: {} }) } }
}

async function openGlobalLibrary(page: Page) {
  await page.locator('nav').getByRole('button', { name: 'Digital Humans', exact: true }).click()
  await page.getByRole('button', { name: 'Capability library', exact: true }).click()
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('')
  await expect(page.getByRole('button', { name: 'Refresh skills', exact: true })).toBeEnabled()
}

function card(page: Page, name: string) {
  return page.locator('[role="button"]').filter({ has: page.getByRole('heading', { name, exact: true, level: 3 }) })
}

async function readConversation(server: SkillServer, spaceId: string, id: string) {
  return server.request<Conversation>(`/api/spaces/${spaceId}/conversations/${id}`)
}

async function sendThroughComposer(page: Page, text: string) {
  const composer = page.locator('textarea').first()
  await expect(composer).toBeVisible()
  await composer.fill(text)
  await composer.press('Enter')
}

test.use({ useScriptedModel: true })
test.describe.configure({ retries: 0 })
test.setTimeout(120000)

test('use a recovered skill from the library and preserve its instructions and reply', binding('capabilities.skill-library-server.invoke'), async ({ skillServer: server }, info) => {
  const record = server.records.find(item => item.kind === 'active')!
  const paused = server.records.find(item => item.kind === 'paused')!
  const model = server.model!
  const requests: ModelRequest[] = []
  const answer = 'The recovered instructions reached the selected conversation.'
  model.respond(request => { requests.push(request); return { text: answer } })
  const home = await server.request<{ id: string }>('/api/spaces/halo')
  await openGlobalLibrary(server.page)
  await card(server.page, record.name).click()
  await expect(server.page.getByRole('heading', { name: record.name, level: 2, exact: true })).toBeVisible()
  await expect(server.page.getByText(record.body, { exact: true })).toBeVisible()
  await expect(server.page.getByText(/x-acceptance-metadata:|user-invocable:/)).toHaveCount(0)
  await server.page.getByRole('button', { name: 'Use', exact: true }).click()
  const composer = server.page.locator('textarea').first()
  await expect(composer).toHaveValue(`/${record.name} `)
  expect(model.exchanges).toHaveLength(0)
  const message = `/${record.name} sample-input`
  const sent = server.page.waitForRequest(request => new URL(request.url()).pathname === '/api/agent/message')
  await sendThroughComposer(server.page, message)
  const turn = (await sent).postDataJSON() as { spaceId: string; conversationId: string; message: string }
  expect(turn.spaceId).toBe(home.id)
  expect(turn.conversationId).toBeTruthy()
  await expect(server.page.locator('.message-assistant').last()).toContainText(answer)
  await expect.poll(() => requests.length).toBe(1)
  const block = requests[0].lastUserText.match(/<skill-instructions name="([^"]+)">\n([\s\S]*?)\n<\/skill-instructions>/)
  expect(block?.[1]).toBe(record.name)
  expect(block?.[2]).toContain(record.body)
  expect(block?.[2]).not.toContain('x-acceptance-metadata')
  expect(requests[0].text).not.toContain(paused.body)
  const catalog = JSON.stringify(requests[0].body.system ?? requests[0].messages.filter(item => item.role === 'system'))
  expect(catalog).not.toContain(paused.name)
  await expect.poll(async () => (await readConversation(server, turn.spaceId, turn.conversationId)).messages.some(item => item.role === 'assistant' && item.content === answer && !item.error)).toBe(true)
  const saved = await readConversation(server, turn.spaceId, turn.conversationId)
  expect(saved.messages.filter(item => item.role === 'user').map(item => item.content)).toEqual([message])
  expect(readFileSync(record.destination, 'utf8')).toBe(record.spec.skill_files!['SKILL.md'])
  await server.restart()
  expect((await readConversation(server, turn.spaceId, turn.conversationId)).messages).toEqual(saved.messages)
  expect((await server.list()).groups.find(item => item.name === paused.name)?.effectiveId).toBeUndefined()
  expect(model.exchanges).toHaveLength(1)
  await info.attach('recovered-skill-invocation', { body: JSON.stringify({ source: record.destination, request: requests[0], saved }, null, 2), contentType: 'application/json' })
})

test('the owner can ask the actual skill management tool to inspect and disable a library skill', binding('capabilities.skill-library-server.manage'), async ({ skillServer: server }, info) => {
  const active = server.records.find(item => item.kind === 'active')!
  const model = server.model!
  const requests: ModelRequest[] = []
  let reference: { id: string; spaceId: string | null } | undefined
  let toolName = ''
  let parseFailure: string | undefined
  const answer = 'The selected skill is disabled; its files were kept.'
  model.respond(request => {
    requests.push(request)
    toolName ||= request.tools.find(name => /(?:__|_)skill_manage$/.test(name)) ?? 'mcp__halo-apps__skill_manage'
    if (request.sequence === 1) return { tools: [{ id: 'list-library', name: toolName, input: { action: 'list', scope: 'global', q: active.name } }] }
    if (request.sequence === 2) {
      const result = request.toolResults.find(item => item.id === 'list-library')
      try {
        const inventory = JSON.parse(result?.text ?? '{}') as { groups?: Array<{ copies: Array<{ name: string; ref: { id: string; spaceId: string | null } }> }> }
        reference = inventory.groups?.flatMap(group => group.copies).find(copy => copy.name === active.name)?.ref
      } catch (error) { parseFailure = String(error) }
      if (!reference) return { text: 'The library did not return the requested reference.' }
      return { tools: [{ id: 'read-library', name: toolName, input: { action: 'read', ref: reference } }] }
    }
    if (request.sequence === 3) return { tools: [{ id: 'disable-library', name: toolName, input: { action: 'disable', ref: reference } }] }
    return { text: answer }
  })
  await openGlobalLibrary(server.page)
  await card(server.page, active.name).click()
  await server.page.getByRole('button', { name: 'Use', exact: true }).click()
  await sendThroughComposer(server.page, `Inspect my global skill ${active.name}, then disable it. Keep its files.`)
  await expect(server.page.locator('.message-assistant').last()).toContainText(answer)
  expect(parseFailure).toBeUndefined()
  expect(requests[0].tools).toContain(toolName)
  expect(reference).toBeDefined()
  expect(requests).toHaveLength(4)
  expect(requests[2].toolResults.find(item => item.id === 'read-library')?.text).toContain(active.body)
  expect(requests[3].toolResults.find(item => item.id === 'disable-library')?.text).toContain('"enabled":false')
  expect((await server.list()).groups.find(group => group.name === active.name)?.effectiveId).toBeUndefined()
  expect(server.rows().find(row => row.id === active.id)?.status).toBe('paused')
  expect(readFileSync(active.destination, 'utf8')).toBe(active.spec.skill_files!['SKILL.md'])
  await openGlobalLibrary(server.page)
  await expect(card(server.page, active.name).getByText('Disabled', { exact: true })).toBeVisible()
  await info.attach('actual-owner-skill-management', { body: JSON.stringify({ reference, requests }, null, 2), contentType: 'application/json' })
})

test('the skill tool loads only an enabled file and rejects a disabled name in the same real conversation', binding('capabilities.skill-library-server.tool'), async ({ skillServer: server }, info) => {
  const active = server.records.find(item => item.kind === 'active')!
  const paused = server.records.find(item => item.kind === 'paused')!
  const model = server.model!
  const requests: ModelRequest[] = []
  const answer = 'The enabled reference loaded and the disabled reference stayed unavailable.'
  model.respond(request => {
    requests.push(request)
    const tool = request.tools.find(name => name === 'Skill') ?? 'Skill'
    if (request.sequence === 1) return { tools: [{ id: 'enabled-reference', name: tool, input: { skill: active.name } }] }
    if (request.sequence === 2) return { tools: [{ id: 'disabled-reference', name: tool, input: { skill: paused.name } }] }
    return { text: answer }
  })
  await openGlobalLibrary(server.page)
  await card(server.page, active.name).click()
  await server.page.getByRole('button', { name: 'Use', exact: true }).click()
  expect(model.exchanges).toHaveLength(0)
  await sendThroughComposer(server.page, 'Read the available workflow, then check that the disabled reference stays unavailable.')
  await expect(server.page.locator('.message-assistant').last()).toContainText(answer)
  await expect.poll(() => requests.length).toBe(3)
  expect(requests[0].tools).toContain('Skill')
  const loaded = requests[1].toolResults.find(result => result.id === 'enabled-reference')
  expect(loaded).toBeDefined()
  expect(loaded!.text).toContain(active.body)
  expect(loaded!.error).toBe(false)
  const refused = requests[2].toolResults.find(result => result.id === 'disabled-reference')
  expect(refused).toBeDefined()
  expect(refused!.text).not.toContain(paused.body)
  expect(refused!.text).toContain(`Skill '${paused.name}' not found`)
  if (requests[2].protocol === 'anthropic') expect(refused!.error).toBe(true)
  expect(readFileSync(active.destination, 'utf8')).toBe(active.spec.skill_files!['SKILL.md'])
  expect(readFileSync(paused.destination, 'utf8')).toBe(paused.spec.skill_files!['SKILL.md'])
  expect((await server.list()).groups.find(item => item.name === paused.name)?.effectiveId).toBeUndefined()
  await info.attach('actual-skill-tool-results', { body: JSON.stringify({ loaded, refused, requests }, null, 2), contentType: 'application/json' })
})
