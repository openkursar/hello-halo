import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { parseTeamSessionKey } from '../../../src/shared/apps/im-keys'
import { expect, readAcceptanceErrors, waitForAcceptanceIdle } from './acceptance-app'
import { initialUserInput, type ModelRequest } from './acceptance-model'
import { collaboratorReceipt } from './acceptance-collaboration'
import { assignmentCall } from './acceptance-subagent-models'
import { assignmentTool, assignmentResult } from './acceptance-subagent-wire'
import { ownerFailureCanary, ownerFailureEndpoint } from './acceptance-subagent-owner-failure'

export type OwnerChoice = 'inherit' | 'effort-only' | 'provider-failure'

export async function configureOwnerChoices(page: Page, failureUrl?: string) {
  if (failureUrl) {
    const added = await page.evaluate(url => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesAddSource({
      id: 'owner-failure-target', name: 'Owner failure target', provider: 'openai', authType: 'api-key', apiUrl: url,
      apiKey: 'local-owner-failure', apiType: 'chat_completions', model: 'o3', availableModels: [{ id: 'o3', name: 'o3' }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }), failureUrl)
    expect(added.success, added.error).toBe(true)
    const selected = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesSwitchSource('acceptance-local'))
    expect(selected.success, selected.error).toBe(true)
  }
  const saved = await assignmentCall(page, 'createSubagentModel', {
    name: 'Available owner choice', description: 'An available profile selected only for the explicit failure route',
    target: { kind: 'model', sourceId: failureUrl ? 'owner-failure-target' : 'acceptance-local', modelId: 'o3' }, reasoningEffort: 'high',
  })
  expect(saved.success, saved.error).toBe(true)
}

export async function prepareOwnerChoice(page: Page, choice: OwnerChoice) {
  const endpoint = choice === 'provider-failure' ? await ownerFailureEndpoint() : undefined
  try { await configureOwnerChoices(page, endpoint?.url) } catch (error) { await endpoint?.close(); throw error }
  return endpoint
}

export function ownerChoiceScript(choice: OwnerChoice, options: { run?: boolean; sourceMarker?: string } = {}) {
  const marker = options.sourceMarker ?? `OWNER_CHOICE_PARENT:${choice}`
  const childMarker = `OWNER_CHOICE_CHILD:${choice}`
  const parents: ModelRequest[] = []
  const children: ModelRequest[] = []
  const errors: string[] = []
  let handle: string | undefined
  let reviewedFailure = false
  let actualSpawns = 0
  const acceptedHandles = new Set<string>()
  const reply = (request: ModelRequest) => {
    if (initialUserInput(request).includes(childMarker)) {
      children.push(request)
      if (choice === 'provider-failure') errors.push('Failed child silently reached the parent endpoint')
      return { text: 'owner-choice-child-complete' }
    }
    parents.push(request)
    if (!options.run && !initialUserInput(request).includes(marker)) errors.push('Unexpected actor at owner endpoint')
    let reference: string | undefined
    if (choice === 'provider-failure') {
      const listed = request.toolResults.find(result => result.id === 'owner-choice-directory')
      if (!listed) return assignmentTool(request, 'list_model_profiles', { query: 'Available owner choice' }, 'owner-choice-directory')
      try { reference = assignmentResult(listed.text).profiles?.find((profile: { name: string }) => profile.name === 'Available owner choice')?.selectionRef } catch (error) { errors.push(String(error)) }
      if (!reference) { errors.push('Failure profile missing from real directory'); return { text: 'Failure target unavailable.' } }
    }
    const spawned = request.toolResults.find(result => result.id === 'owner-choice-spawn')
    if (!spawned) {
      const response = assignmentTool(request, 'spawn_agent', {
        name: 'Owner choice worker', prompt: childMarker,
        ...(choice === 'effort-only' ? { reasoning_effort: 'low' } : {}),
        ...(reference ? { model_profile: reference } : {}),
      }, 'owner-choice-spawn')
      if (response.tools?.some(tool => tool.id === 'owner-choice-spawn')) actualSpawns++
      return response
    }
    if (spawned.error) errors.push(`Owner creation was refused: ${spawned.text}`)
    try { handle = collaboratorReceipt(spawned).handle; acceptedHandles.add(handle) } catch (error) { errors.push(String(error)) }
    reviewedFailure ||= choice === 'provider-failure' && request.text.includes(ownerFailureCanary)
    const done = choice === 'provider-failure' ? reviewedFailure : request.text.includes('owner-choice-child-complete')
    if (done && options.run && !request.toolResults.some(result => result.id === 'owner-choice-report')) return assignmentTool(request, 'report_to_user', { type: 'run_complete', message: 'owner-choice-parent-complete' }, 'owner-choice-report')
    return { text: done ? 'owner-choice-parent-complete' : 'Waiting for the owner choice worker.' }
  }
  return { marker, childMarker, reply, parents, children, errors, acceptedHandles, get actualSpawns() { return actualSpawns }, get handle() { return handle }, get reviewedFailure() { return reviewedFailure } }
}

export function assertOwnerChoiceWire(script: ReturnType<typeof ownerChoiceScript>, choice: OwnerChoice) {
  expect(script.errors).toEqual([])
  expect(script.handle).toBeTruthy()
  expect(script.actualSpawns).toBe(1)
  expect([...script.acceptedHandles]).toEqual([script.handle])
  expect(script.parents.length).toBeGreaterThan(0)
  for (const request of script.parents) expect(request.body.model).toBe('o3')
  if (choice === 'provider-failure') {
    expect(script.reviewedFailure).toBe(true)
    expect(script.children).toHaveLength(0)
    return
  }
  expect(script.children.length).toBeGreaterThan(0)
  const wire = (request: ModelRequest) => ({ model: request.body.model, reasoning_effort: request.body.reasoning_effort, reasoning: request.body.reasoning, thinking: request.body.thinking, output_config: request.body.output_config })
  const parent = wire(script.parents[0])
  expect(parent.model).toBe('o3')
  for (const request of script.children) {
    expect(request.body.model).toBe('o3')
    if (choice === 'inherit') expect(wire(request)).toEqual(parent)
    else expect(request.body.reasoning_effort ?? request.body.reasoning?.effort ?? request.body.output_config?.effort).toBe('low')
  }
}

export async function waitForOwnerChoiceIdle(page: Page, conversationId: string, script: ReturnType<typeof ownerChoiceScript>, choice: OwnerChoice) {
  if (choice !== 'provider-failure') return waitForAcceptanceIdle(page, conversationId)
  expect(script.handle).toBeTruthy()
  const availability = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
  expect(availability.success).toBe(true)
  const engine = (availability.data as { activeEngine: string }).activeEngine
  expect(['halo', 'anthropic', 'dsh'], 'The expected 400 error envelope must be established for the actual engine').toContain(engine)
  const expectedMessage = engine === 'halo' ? `Anthropic API error (400): ${ownerFailureCanary}`
    : engine === 'anthropic' ? `API Error: 400 ${ownerFailureCanary}` : ownerFailureCanary
  const expectedErrors = await readAcceptanceErrors(page)
  expect(expectedErrors.length).toBeGreaterThan(0)
  for (const value of expectedErrors) {
    const event = value as { conversationId: string; spaceId: string; type: string; error: string; errorCode?: string }
    expect(parseTeamSessionKey(event.conversationId)?.appId).toBe(script.handle)
    expect(event.spaceId).toBe('halo-temp')
    expect(event.type).toBe('error')
    expect(event.error).toBe(expectedMessage)
    if (event.errorCode !== undefined) expect(event.errorCode).toBe(engine === 'anthropic' ? 'success' : 'error_during_execution')
  }
  await waitForAcceptanceIdle(page, conversationId, { expectedErrors })
}

export function assertOwnerFailure(endpoint: Awaited<ReturnType<typeof ownerFailureEndpoint>> | undefined, script: ReturnType<typeof ownerChoiceScript>) {
  if (!endpoint) return
  const inference = endpoint.requests.filter(request => request.method === 'POST' && /\/messages$|\/chat\/completions$|\/responses$/.test(request.path))
  expect(inference).toHaveLength(1)
  for (const request of inference) {
    expect(JSON.parse(request.body).model).toBe('o3')
    expect(request.body).toContain(script.childMarker)
  }
  expect(endpoint.requests.some(request => /\/models(?:\?|$)/.test(request.path))).toBe(false)
  expect(script.parents.some(request => request.text.includes(ownerFailureCanary))).toBe(true)
}
