import { beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const runtime = vi.hoisted(() => ({ defaultEngine: 'codex', checked: [] as string[] }))
vi.mock('../../../../src/main/services/agent', async () => ({
  ...(await vi.importActual('../../../../src/main/services/agent/engine-handoff')),
  getLegacyEngine: () => 'anthropic',
  getSessionEngineId: () => undefined,
  isSessionBusy: () => false,
  resolveDefaultEngine: async () => runtime.defaultEngine,
  ensureEngineAvailable: async (engineId: string) => { runtime.checked.push(engineId) },
}))

beforeEach(() => { runtime.defaultEngine = 'codex'; runtime.checked = [] })

it('keeps a failed first-start choice after a module restart and a different default, with the failed input retained once', async () => {
  const root = globalThis.__HALO_TEST_DIR__
  const initialStore = await import('../../../../src/main/apps/runtime/session-store')
  const initialRouting = await import('../../../../src/main/apps/runtime/engine-selection')
  const initialState = initialStore.loadChatEngineState(root, 'app', 'chat')
  const selected = await initialRouting.resolveAppSessionEngine({})
  const routed = initialStore.saveChatEngineRouting(root, 'app', 'chat', selected, initialState)
  const writer = initialStore.openSessionWriter(root, 'app', 'chat')
  writer.writeTrigger('FIRST_INPUT_BEFORE_CREATION_FAILED')
  writer.writeEvent({ type: 'turn_snapshot', content: '', thoughts: [], error: 'SDK creation failed before init' })
  expect(routed).toEqual({ routingEngine: 'codex' })
  const map = join(root, '.halo/apps/app/runs/_session-ids.json')
  const persisted = readFileSync(map, 'utf8')

  runtime.defaultEngine = 'halo'
  vi.resetModules()
  const store = await import('../../../../src/main/apps/runtime/session-store')
  const routing = await import('../../../../src/main/apps/runtime/engine-selection')
  const state = store.loadChatEngineState(root, 'app', 'chat')
  expect(readFileSync(map, 'utf8')).toBe(persisted)
  const engineId = await routing.resolveAppSessionEngine({ routingEngine: state.routingEngine })
  expect(engineId).toBe('codex')
  const plan = routing.prepareAppEngineSession({ engineId, state, spacePath: root, appId: 'app', runId: 'chat' })
  expect(plan.resumeSessionId).toBeUndefined()
  expect(plan.engineHandoffContent).toContain('FIRST_INPUT_BEFORE_CREATION_FAILED')
  expect(plan.engineHandoffContent).not.toContain('CURRENT_RETRY_INPUT')
  const { prependEngineHandoff } = await import('../../../../src/main/services/agent/engine-handoff')
  const input = prependEngineHandoff('CURRENT_RETRY_INPUT', plan.engineHandoffContent!)
  expect(input.match(/CURRENT_RETRY_INPUT/g)).toHaveLength(1)
  expect(input.match(/FIRST_INPUT_BEFORE_CREATION_FAILED/g)).toHaveLength(1)
  expect(store.saveChatEngineBinding(root, 'app', 'chat', { version: 1, engineId, sessionId: 'new-codex-native' }, state)).toBe(true)
  expect(store.loadChatEngineState(root, 'app', 'chat')).toEqual({ sessionId: 'new-codex-native', binding: { version: 1, engineId: 'codex', sessionId: 'new-codex-native' } })
})
