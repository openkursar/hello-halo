import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test, expect, acceptance, sendAcceptanceMessage } from '../fixtures/acceptance-app'
import type { ModelRequest } from '../fixtures/acceptance-model'
import {
  createMemoryWorld, finishMemoryConversation, openFreshMemoryConversation, setPersonMemory,
  setWorkspaceMemory, snapshotMemory, readPersonMemoryThoughts, type SyntheticMemory,
} from '../fixtures/acceptance-memory'

test.setTimeout(180000)

function expectContext(request: ModelRequest, present: string[], absent: string[]) {
  for (const value of present) expect(request.text).toContain(value)
  for (const value of absent) expect(request.text).not.toContain(value)
}

const memoryMarkers = (memory: SyntheticMemory) => [memory.fact, memory.topic, memory.topicBody]

test('workspace topics are offered only to the person who opts in while personal memories remain separate', acceptance('memory.control.scope'), async ({ acceptanceApp, model, window }, info) => {
  let stage = 'setup'
  const observations: Array<{ stage: string; request: ModelRequest }> = []
  model.respond(request => {
    observations.push({ stage, request })
    return { text: `Memory observation ${stage} completed.` }
  })
  const world = await createMemoryWorld(window, acceptanceApp.profile)
  const [first, second] = world.people
  const [firstMemory, secondMemory] = world.personal
  const original = [world.workspace, ...world.personal].map(snapshotMemory)
  expect(observations).toEqual([])
  const conversations: string[] = []
  try {
    for (const entry of ['workspace', 'first-private', 'first-shared', 'second-private', 'first-private-again'] as const) {
      stage = entry
      if (entry === 'first-shared') await setPersonMemory(window, first, { inherit: true })
      if (entry === 'first-private-again') await setPersonMemory(window, first, { inherit: false })
      const person = entry === 'workspace' ? undefined : entry === 'second-private' ? second : first
      const own = entry === 'workspace' ? world.workspace : entry === 'second-private' ? secondMemory : firstMemory
      const question = `Observe memory ownership: ${entry}.`
      await openFreshMemoryConversation(window, world, person)
      const turn = await sendAcceptanceMessage(window, question)
      expect(turn.spaceId).toBe(world.space.id)
      conversations.push(turn.conversationId)
      await finishMemoryConversation(window, turn, question, `Memory observation ${entry} completed.`, person)
      const actual = observations.filter(observation => observation.stage === entry)
      expect(actual).toHaveLength(1)
      const present = [own.fact, own.topic]
      if (entry === 'first-shared') present.push(world.workspace.topic)
      const absent = [world.workspace, ...world.personal].flatMap(memoryMarkers).filter(value => !present.includes(value))
      expectContext(actual[0].request, present, absent)
      expect(actual[0].request.lastUserText).toContain(question)
      expect([world.workspace, ...world.personal].map(snapshotMemory)).toEqual(original)
    }
    expect(new Set(conversations).size).toBe(5)
    expect(model.exchanges).toHaveLength(5)
  } finally {
    await info.attach('memory-ownership-context', { body: JSON.stringify({ spaceId: world.space.id, people: world.people.map(person => person.id), conversations, observations }, null, 2), contentType: 'application/json' })
  }
})

for (const scope of ['workspace', 'person'] as const) {
  test(`${scope} memory stops automatic context use while off and returns unchanged when enabled`, acceptance('memory.control.disable', { scope }), async ({ acceptanceApp, model, window }, info) => {
    let stage = 'setup'
    const observations: Array<{ stage: string; request: ModelRequest }> = []
    model.respond(request => {
      observations.push({ stage, request })
      return { text: `Memory control ${stage} completed.` }
    })
    const world = await createMemoryWorld(window, acceptanceApp.profile)
    const person = scope === 'person' ? world.people[0] : undefined
    const own = scope === 'person' ? world.personal[0] : world.workspace
    const original = [world.workspace, ...world.personal].map(snapshotMemory)
    expect(observations).toEqual([])
    const conversations: string[] = []
    try {
      for (const [phase, enabled] of [['enabled', true], ['disabled', false], ['restored', true]] as const) {
        stage = phase
        if (phase !== 'enabled') {
          if (person) await setPersonMemory(window, person, { enabled })
          else await setWorkspaceMemory(window, world.space, { enabled })
        }
        await openFreshMemoryConversation(window, world, person)
        const question = `Observe automatic memory use: ${phase}.`
        const turn = await sendAcceptanceMessage(window, question)
        expect(turn.spaceId).toBe(world.space.id)
        conversations.push(turn.conversationId)
        await finishMemoryConversation(window, turn, question, `Memory control ${phase} completed.`, person)
        const actual = observations.filter(observation => observation.stage === phase)
        expect(actual).toHaveLength(1)
        const present = enabled ? [own.fact, own.topic] : []
        const absent = [world.workspace, ...world.personal].flatMap(memoryMarkers).filter(value => !present.includes(value))
        expectContext(actual[0].request, present, absent)
        expect(actual[0].request.lastUserText).toContain(question)
        if (!enabled) expect(actual[0].request.text).not.toContain('## Memory snapshot (startup)')
        expect([world.workspace, ...world.personal].map(snapshotMemory)).toEqual(original)
      }
      expect(new Set(conversations).size).toBe(3)
      expect(model.exchanges).toHaveLength(3)
    } finally {
      await info.attach('automatic-memory-control', { body: JSON.stringify({ scope, conversations, observations }, null, 2), contentType: 'application/json' })
    }
  })
}

test('a person cannot edit its disabled memory and can edit it again after the user restores memory', acceptance('memory.control.disable-tools', { scope: 'person', operation: 'write' }), async ({ acceptanceApp, model, window }, info) => {
  model.respond(() => ({ text: 'Unexpected setup request.' }))
  const world = await createMemoryWorld(window, acceptanceApp.profile)
  const person = world.people[0]
  const own = world.personal[0]
  const controls = [world.workspace, world.personal[1]].map(snapshotMemory)
  const topic = snapshotMemory(own)[1]
  expect(model.exchanges).toHaveLength(0)
  const observations: Array<{ phase: string; request: ModelRequest }> = []
  const missingTools: Array<{ phase: string; name: string; matches: number }> = []
  const conversations: string[] = []
  let currentFact = own.fact
  try {
    for (const phase of ['enabled', 'disabled', 'restored'] as const) {
      if (phase !== 'enabled') await setPersonMemory(window, person, { enabled: phase === 'restored' })
      const before = snapshotMemory(own)
      const nextFact = `UpdatedMemoryFact-${randomUUID()}`
      const readId = `${phase}-memory-read`
      const editId = `${phase}-memory-edit`
      const question = `Check the memory edit boundary: ${phase}.`
      const answer = `Memory edit observation ${phase} completed.`
      model.respond(request => {
        observations.push({ phase, request })
        if (request.toolResults.some(result => result.id === editId)) return { text: answer }
        const read = request.toolResults.find(result => result.id === readId)
        const name = phase === 'disabled' || read ? 'Edit' : 'Read'
        const tools = request.tools.filter(tool => tool === name || tool.endsWith(`__${name}`))
        if (tools.length !== 1) {
          missingTools.push({ phase, name, matches: tools.length })
          return { text: answer }
        }
        return { tools: [{ id: name === 'Read' ? readId : editId, name: tools[0], input: name === 'Read'
          ? { file_path: own.file }
          : { file_path: own.file, old_string: currentFact, new_string: nextFact } }] }
      })
      await openFreshMemoryConversation(window, world, person)
      const turn = await sendAcceptanceMessage(window, question)
      expect(turn.spaceId).toBe(world.space.id)
      conversations.push(turn.conversationId)
      const messages = await finishMemoryConversation(window, turn, question, answer, person)
      const thoughts = await readPersonMemoryThoughts(window, person, turn, messages)
      const edits = thoughts.filter(thought => thought.toolName === 'Edit' || thought.toolName?.endsWith('__Edit'))
      expect(edits).toHaveLength(1)
      expect(edits[0].toolInput).toMatchObject({ file_path: own.file, old_string: currentFact, new_string: nextFact })
      expect(edits[0].toolResult?.isError).toBe(phase === 'disabled')
      expect(missingTools).toEqual([])
      const actual = observations.filter(observation => observation.phase === phase)
      expect(actual).toHaveLength(phase === 'disabled' ? 2 : 3)
      expect(actual[0].request.lastUserText).toContain(question)
      expectContext(actual[0].request, phase === 'disabled' ? [] : [currentFact, own.topic], phase === 'disabled' ? [currentFact, own.topic] : [])
      const result = actual.at(-1)!.request.toolResults.filter(result => result.id === editId)
      expect(result).toHaveLength(1)
      if (phase === 'disabled') {
        if (actual.at(-1)!.request.protocol === 'anthropic') expect(result[0].error).toBe(true)
        expect(edits[0].toolResult?.output).toContain('This memory is read-only for you.')
        expect(result[0].text).toContain('This memory is read-only for you.')
        expect(snapshotMemory(own)).toEqual(before)
      } else {
        const read = actual[1].request.toolResults.find(result => result.id === readId)
        expect(read).toMatchObject({ error: false, text: expect.stringContaining(currentFact) })
        expect(result[0].error).toBe(false)
        expect(readFileSync(own.file, 'utf8')).toBe(before[0].content.replace(currentFact, nextFact))
        currentFact = nextFact
      }
      expect(snapshotMemory(own)[1]).toEqual(topic)
      expect([world.workspace, world.personal[1]].map(snapshotMemory)).toEqual(controls)
    }
    expect(new Set(conversations).size).toBe(3)
    expect(model.exchanges).toHaveLength(8)
  } finally {
    await info.attach('personal-memory-write-control', { body: JSON.stringify({ appId: person.id, conversations, observations, missingTools }, null, 2), contentType: 'application/json' })
  }
})
