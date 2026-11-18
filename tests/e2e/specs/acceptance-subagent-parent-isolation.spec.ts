import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { createModelGate, initialUserInput, type ModelRequest, type ModelReply } from '../fixtures/acceptance-model'
import { assignmentTool } from '../fixtures/acceptance-subagent-wire'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { assignmentCall, storedAssignmentConfig } from '../fixtures/acceptance-subagent-models'

test.use({ sdkEngine: 'halo', aiSource: async ({ model }, use) => {
  await use({ provider: 'openai', apiType: 'chat_completions', apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: 'o3' })
} })

function wire(request: ModelRequest) {
  return { model: request.body.model, effort: request.body.reasoning_effort, reasoning: request.body.reasoning, thinking: request.body.thinking, output: request.body.output_config }
}

async function startParent(window: import('@playwright/test').Page, message: string, effort: 'high' | 'low') {
  const created = await window.evaluate(effort => (globalThis as unknown as { halo: HaloAPI }).halo.createConversation('halo-temp', 'Parent reasoning isolation', effort), effort)
  expect(created.success, created.error).toBe(true)
  const id = (created.data as { id: string }).id
  const sent = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.sendMessage(input), { spaceId: 'halo-temp', conversationId: id, message, reasoningEffort: effort })
  expect(sent.success, sent.error).toBe(true)
  return id
}

test('overlapping parents keep distinct reasoning through their own collaborators and continuation', acceptance('models.subagent-profiles.concurrent', { topology: 'parents-distinct-reasoning' }), async ({ window, model, acceptanceApp }, info) => {
  test.setTimeout(180000)
  const gate = createModelGate()
  const markers = ['ISOLATED_HIGH_PARENT', 'ISOLATED_LOW_PARENT']
  const childMarkers = ['ISOLATED_HIGH_CHILD', 'ISOLATED_LOW_CHILD']
  const parents: ModelRequest[][] = [[], []]
  const children: ModelRequest[][] = [[], []]
  const handles: string[] = []
  const errors: string[] = []
  model.respond(request => {
    const initial = initialUserInput(request)
    const child = childMarkers.findIndex(marker => initial.includes(marker))
    if (child >= 0) { children[child].push(request); return { text: `isolated-result-${child}`, hold: gate.promise } }
    const actor = markers.findIndex(marker => initial.includes(marker))
    if (actor < 0) { errors.push('Unknown concurrent actor'); return { text: 'Unknown actor.' } }
    parents[actor].push(request)
    const result = request.toolResults.find(result => result.id === `isolation-spawn-${actor}`)
    if (!result) return assignmentTool(request, 'spawn_agent', { name: `Private checker ${actor}`, prompt: childMarkers[actor] }, `isolation-spawn-${actor}`)
    try { handles[actor] = collaboratorReceipt(result).handle } catch (error) { errors.push(String(error)) }
    return { text: request.text.includes(`isolated-result-${actor}`) ? `isolated-parent-${actor}-done` : 'The private checker is preparing.' }
  })
  try {
    const ids = await Promise.all(markers.map((marker, index) => startParent(window, marker, index === 0 ? 'high' : 'low')))
    expect(new Set(ids).size).toBe(2)
    await expect.poll(() => children.every(rows => rows.length > 0) && handles.filter(Boolean).length === 2, { timeout: 90000 }).toBe(true)
    expect(model.exchanges.filter(exchange => childMarkers.some(marker => initialUserInput(exchange.request).includes(marker)) && !exchange.completed && !exchange.cancelled)).toHaveLength(2)
    expect(new Set(handles).size).toBe(2)
    gate.release()
    await expect.poll(() => parents.every((rows, index) => rows.some(request => request.text.includes(`isolated-result-${index}`))), { timeout: 90000 }).toBe(true)
    for (const id of ids) await waitForAcceptanceIdle(window, id)
    for (let actor = 0; actor < 2; actor++) {
      const expected = { ...wire(parents[actor][0]), model: 'o3', effort: actor === 0 ? 'high' : 'low' }
      for (const request of [...parents[actor], ...children[actor]]) expect(wire(request)).toEqual(expected)
      expect(parents[actor].some(request => request.text.includes(`isolated-result-${1 - actor}`))).toBe(false)
    }
    expect(errors).toEqual([])
    expect(storedAssignmentConfig(acceptanceApp.profile).settings).toBeUndefined()
    await info.attach('concurrent-parent-child-wire', { body: JSON.stringify({ ids, handles, parents: parents.map(rows => rows.map(wire)), children: children.map(rows => rows.map(wire)) }, null, 2), contentType: 'application/json' })
  } finally { gate.release() }
})

test('an explicit low child delegates inherited low while its root remains high', acceptance('models.subagent-profiles.concurrent', { topology: 'nested-direct-parent' }), async ({ window, model }, info) => {
  test.setTimeout(180000)
  const saved = await assignmentCall(window, 'createSubagentModel', { name: 'Enable explicit child effort', description: 'Permit a deliberate effort choice.', target: { kind: 'model', sourceId: 'acceptance-local', modelId: 'o3' } })
  expect(saved.success, saved.error).toBe(true)
  const markers = ['DIRECT_ROOT_HIGH', 'DIRECT_CHILD_LOW', 'DIRECT_GRANDCHILD_INHERIT']
  const requests: ModelRequest[][] = [[], [], []]
  const handles: string[] = []
  const errors: string[] = []
  const reply = (request: ModelRequest): ModelReply => {
    const actor = markers.findIndex(marker => initialUserInput(request).includes(marker))
    if (actor < 0) { errors.push('Unknown nested actor'); return { text: 'Unknown actor.' } }
    requests[actor].push(request)
    if (actor === 2) return { text: 'direct-grandchild-low-confirmed' }
    const result = request.toolResults.find(result => result.id === `direct-spawn-${actor}`)
    if (!result) return assignmentTool(request, 'spawn_agent', { name: actor === 0 ? 'Low child' : 'Inheriting grandchild', prompt: markers[actor + 1], ...(actor === 0 ? { reasoning_effort: 'low' } : {}) }, `direct-spawn-${actor}`)
    try { handles[actor] = collaboratorReceipt(result).handle } catch (error) { errors.push(String(error)) }
    return { text: request.text.includes('direct-grandchild-low-confirmed') ? actor === 1 ? 'direct-child-reviewed-grandchild' : 'direct-root-reviewed-child' : 'The direct child is preparing.' }
  }
  model.respond(reply)
  const id = await startParent(window, markers[0], 'high')
  await expect.poll(() => requests[0].some(request => request.text.includes('direct-child-reviewed-grandchild')), { timeout: 120000 }).toBe(true)
  await waitForAcceptanceIdle(window, id)
  expect(errors).toEqual([])
  expect(handles.filter(Boolean)).toHaveLength(2)
  expect(new Set(handles).size).toBe(2)
  for (let actor = 0; actor < 3; actor++) {
    expect(requests[actor].length).toBeGreaterThan(0)
    for (const request of requests[actor]) expect(wire(request)).toEqual({ ...wire(requests[actor][0]), model: 'o3', effort: actor === 0 ? 'high' : 'low' })
  }
  expect(requests[1].some(request => request.text.includes('direct-grandchild-low-confirmed'))).toBe(true)
  expect(requests[0].some(request => request.text.includes('direct-child-reviewed-grandchild'))).toBe(true)
  await info.attach('direct-parent-reasoning-wire', { body: JSON.stringify({ id, handles, actors: requests.map(rows => rows.map(wire)) }, null, 2), contentType: 'application/json' })
})
