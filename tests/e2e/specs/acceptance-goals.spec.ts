import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { Goal, GoalUpdatedEvent } from '../../../src/shared/types/goal'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle, readAcceptanceConversation } from '../fixtures/acceptance-app'
import { contentText, modelTool, type ModelRequest } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'

interface GoalWindow {
  halo: HaloAPI
  acceptanceGoals: { events: GoalUpdatedEvent[]; dispose: () => void }
}
interface Conversation { spaceId: string; conversationId: string }

test.setTimeout(90000)

async function observeGoals(window: Page) {
  await window.evaluate(() => {
    const state = globalThis as unknown as GoalWindow
    const events: GoalUpdatedEvent[] = []
    const dispose = state.halo.onAgentGoalUpdated(value => events.push(value as GoalUpdatedEvent))
    state.acceptanceGoals = { events, dispose }
  })
}

async function goalEvents(window: Page) {
  return window.evaluate(() => (globalThis as unknown as GoalWindow).acceptanceGoals.events)
}

async function attachGoalEvidence(window: Page, info: TestInfo) {
  const events = await goalEvents(window)
  await info.attach('goal-events', { body: JSON.stringify(events, null, 2), contentType: 'application/json' })
  await window.evaluate(() => (globalThis as unknown as GoalWindow).acceptanceGoals.dispose())
}

async function readGoal(window: Page, conversation: Conversation): Promise<Goal | null> {
  return window.evaluate(async target => {
    const response = await (globalThis as unknown as GoalWindow).halo.getGoal(target)
    if (!response.success) throw new Error('The real conversation goal could not be read')
    return response.data as Goal | null
  }, conversation)
}

function controlledCommand(profile: string) {
  const ready = join(profile, 'goal-command-ready')
  const released = join(profile, 'goal-command-released')
  const file = join(profile, 'goal-command.cjs')
  const output = `GOAL_COMMAND_FINISHED_${randomUUID()}`
  writeFileSync(file, [
    'const fs = require("node:fs")',
    `fs.writeFileSync(${JSON.stringify(ready)}, 'ready')`,
    'const started = Date.now()',
    `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(released)})) { clearInterval(timer); process.stdout.write(${JSON.stringify(output)}); } else if (Date.now() - started > 45000) { clearInterval(timer); process.stderr.write('The goal test did not release the command'); process.exitCode = 1; } }, 40)`,
  ].join('\n'))
  const quote = (path: string) => `'${(process.platform === 'win32' ? path.replaceAll('\\', '/') : path).replaceAll("'", "'\\''")}'`
  return {
    ready, output, command: `${quote(process.execPath)} ${quote(file)}`,
    release: () => writeFileSync(released, 'continue'),
  }
}

async function startGoal(window: Page, objective: string, criteria: string[]) {
  await navigateToChat(window)
  await window.getByRole('button', { name: 'Add files, context and capabilities', exact: true }).click()
  await window.getByRole('menuitem', { name: /^Set a goal\b/ }).click()
  await expect(window.getByRole('button', { name: 'Exit goal mode', exact: true })).toBeVisible()
  return sendAcceptanceMessage(window, [objective, ...criteria.map(criterion => `- ${criterion}`)].join('\n'))
}

function notices(request: ModelRequest, start = 0): string {
  return request.messages.slice(start).flatMap(message => {
    const text = contentText(message.content)
    return [...text.matchAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/g)].map(match => match[1])
  }).join('\n')
}

function commandResult(request: ModelRequest, output: string) {
  const result = request.toolResults.find(result => result.id === 'goal-command')
  expect(result, 'The model must receive the actual command result').toBeDefined()
  expect(result!.error).toBe(false)
  expect(result!.text).toContain(output)
}

test('a goal created in the composer and revised during a command reaches the next model step', acceptance('goals.control.set'), async ({ acceptanceApp, model, window }, info) => {
  const command = controlledCommand(acceptanceApp.profile)
  const objective = `Check the controlled command ${randomUUID()}`
  const revised = `Verify the command output ${randomUUID()}`
  const criteria = ['The controlled command finishes', 'The output contains the expected marker']
  const revisedCriteria = [`The command prints ${command.output}`, 'The command reports no error']
  let step = 0
  model.respond(request => {
    step++
    if (step === 1) {
      expect(notices(request)).toContain(`Objective: ${objective}`)
      for (const criterion of criteria) expect(notices(request)).toContain(criterion)
      return { tools: [modelTool(request, 'Bash', { command: command.command, timeout: 50000, run_in_background: false }, 'goal-command')] }
    }
    if (step === 2) {
      commandResult(request, command.output)
      expect(notices(request)).toContain(`The user updated the goal.\nObjective: ${revised}`)
      for (const criterion of revisedCriteria) expect(notices(request)).toContain(criterion)
      return { tools: [modelTool(request, 'Goal', { action: 'complete', note: 'The command returned the requested output without error.' }, 'goal-finished')] }
    }
    expect(step).toBe(3)
    expect(request.toolResults.find(result => result.id === 'goal-finished')).toMatchObject({ error: false, text: expect.stringContaining('Status: complete') })
    return { text: `The revised goal was checked: ${revised}` }
  })
  await observeGoals(window)
  try {
    const turn = await startGoal(window, objective, criteria)
    await expect.poll(() => existsSync(command.ready), { timeout: 20000 }).toBe(true)
    const shelf = window.getByRole('region', { name: 'Goal', exact: true })
    await expect(shelf).toContainText(objective)
    await expect.poll(() => readGoal(window, turn)).toMatchObject({ objective, doneWhen: criteria, status: 'active' })
    await shelf.getByRole('button', { name: 'Edit goal', exact: true }).click()
    await expect(window.getByLabel('Objective', { exact: true })).toHaveValue(objective)
    await window.getByLabel('Objective', { exact: true }).fill(revised)
    for (const [index, criterion] of revisedCriteria.entries()) {
      await expect(window.getByLabel(`Criterion ${index + 1}`, { exact: true })).toHaveValue(criteria[index])
      await window.getByLabel(`Criterion ${index + 1}`, { exact: true }).fill(criterion)
    }
    await window.getByRole('button', { name: 'Save goal', exact: true }).click()
    await expect(shelf).toContainText(revised)
    await expect(shelf).toContainText('Applies on next step')
    await expect.poll(() => readGoal(window, turn)).toMatchObject({ objective: revised, doneWhen: revisedCriteria, status: 'active', updatedBy: 'user' })
    expect((await goalEvents(window)).some(event => event.conversationId === turn.conversationId && event.goal?.objective === revised && !event.seenByModel)).toBe(true)
    command.release()
    await expect(window.locator('.message-assistant').last()).toContainText(`The revised goal was checked: ${revised}`)
    await waitForAcceptanceIdle(window, turn.conversationId)
    expect((await goalEvents(window)).some(event => event.conversationId === turn.conversationId && event.goal?.objective === revised && event.goal.status === 'active' && event.source === 'user' && event.seenByModel)).toBe(true)
    await expect(shelf).not.toContainText('Applies on next step')
    expect(step).toBe(3)
  } finally {
    command.release()
    await attachGoalEvidence(window, info)
  }
})

for (const action of ['complete', 'abandon', 'clear'] as const) {
  test(`the ${action} action stops the goal from steering subsequent work`, acceptance('goals.control.finish', { action }), async ({ acceptanceApp, model, window }, info) => {
    const command = controlledCommand(acceptanceApp.profile)
    const objective = `Observe the command goal ${randomUUID()}`
    const followup = `Answer an unrelated request ${randomUUID()}`
    const criteria = [`The command prints ${command.output}`]
    let step = 0
    let followupRequests = 0
    model.respond(request => {
      const followupIndex = request.messages.findIndex(message => message.role === 'user' && contentText(message.content).includes(followup))
      if (followupIndex >= 0) {
        followupRequests++
        // Old goal text stays in history; only newly injected guidance could steer this turn.
        expect(notices(request, followupIndex)).not.toMatch(/Current goal:|The user (?:set|updated) (?:a |the )goal|work still open|Status: active/)
        return { text: `The unrelated request is complete: ${followup}` }
      }
      step++
      if (step === 1) {
        expect(notices(request)).toContain(`Objective: ${objective}`)
        return { tools: [modelTool(request, 'Bash', { command: command.command, timeout: 50000, run_in_background: false }, 'goal-command')] }
      }
      commandResult(request, command.output)
      if (action === 'clear') {
        expect(step).toBe(2)
        expect(notices(request)).toContain(`The user removed the goal "${objective}". It no longer applies.`)
      } else if (step === 2) {
        return { tools: [modelTool(request, 'Goal', { action, note: action === 'complete' ? 'The command printed the required marker.' : 'This goal is no longer needed.' }, 'goal-finished')] }
      } else {
        expect(step).toBe(3)
        expect(request.toolResults.find(result => result.id === 'goal-finished')).toMatchObject({ error: false, text: expect.stringContaining(`Status: ${action === 'complete' ? 'complete' : 'abandoned'}`) })
      }
      return { text: `The goal action finished: ${action}` }
    })
    await observeGoals(window)
    try {
      const turn = await startGoal(window, objective, criteria)
      await expect.poll(() => existsSync(command.ready), { timeout: 20000 }).toBe(true)
      const shelf = window.getByRole('region', { name: 'Goal', exact: true })
      await expect(shelf).toContainText(objective)
      await expect.poll(() => readGoal(window, turn)).toMatchObject({ objective, doneWhen: criteria, status: 'active' })
      if (action === 'clear') {
        await shelf.getByRole('button', { name: 'Clear goal', exact: true }).click()
        const dialog = window.getByRole('alertdialog', { name: 'Clear this goal?', exact: true })
        await expect(dialog).toContainText('Halo is working toward it right now')
        await dialog.getByRole('button', { name: 'Clear goal', exact: true }).click()
        await expect.poll(() => readGoal(window, turn)).toBeNull()
        await expect(shelf).toHaveCount(0)
      }
      command.release()
      await expect(window.locator('.message-assistant').last()).toContainText(`The goal action finished: ${action}`)
      await waitForAcceptanceIdle(window, turn.conversationId)
      const status = action === 'complete' ? 'complete' : 'abandoned'
      if (action !== 'clear') {
        await expect(shelf).toContainText(action === 'complete' ? 'Goal achieved' : 'Goal abandoned')
        expect(await readGoal(window, turn)).toMatchObject({ objective, doneWhen: criteria, status, updatedBy: 'agent' })
      }
      const count = model.exchanges.length
      const next = await sendAcceptanceMessage(window, followup)
      expect(next.conversationId).toBe(turn.conversationId)
      await expect(window.locator('.message-assistant').last()).toContainText(`The unrelated request is complete: ${followup}`)
      await waitForAcceptanceIdle(window, next.conversationId)
      expect(followupRequests, 'A finished goal must not trigger another open-work model step').toBe(1)
      expect(model.exchanges.length).toBe(count + 1)
      if (action === 'clear') expect(await readGoal(window, next)).toBeNull()
      else expect(await readGoal(window, next)).toMatchObject({ objective, status })
      const saved = await readAcceptanceConversation(window, next.spaceId, next.conversationId)
      expect(saved.messages.filter(message => message.role === 'user')).toHaveLength(2)
      expect(saved.messages.at(-1)?.content).toContain(followup)
    } finally {
      command.release()
      await attachGoalEvidence(window, info)
    }
  })
}
