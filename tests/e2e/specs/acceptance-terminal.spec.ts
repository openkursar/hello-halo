import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  test, expect, acceptance, commandScript, commandWorkspace, openCommandWorkspace,
  commandThoughts, ownedCommandTree, shellQuote, sendAcceptanceMessage, waitForAcceptanceIdle, waitForCommandIdleAfterStop,
} from '../fixtures/acceptance-terminal'
import { modelTool } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'

test.setTimeout(90000)

test('a command receives the launch environment and a workspace path containing spaces', acceptance('terminal.environment.user-vars'), async ({ acceptanceApp, commandEnvironment, model, window }) => {
  const space = await commandWorkspace(window, acceptanceApp.profile, 'Quoted workspace')
  const file = join(space.workingDir, 'command-environment.json')
  const command = commandScript(acceptanceApp.profile, 'report-environment', `const fs=require('node:fs');const value={cwd:process.cwd(),marker:process.env[${JSON.stringify(commandEnvironment.name)}]};fs.writeFileSync('command-environment.json',JSON.stringify(value));process.stdout.write(JSON.stringify(value));`)
  model.respond(request => {
    const result = request.toolResults.find(result => result.id === 'environment-command')
    if (!result) return { tools: [modelTool(request, 'Bash', { command, run_in_background: false }, 'environment-command')] }
    const observed = JSON.parse(result.text)
    expect(realpathSync(observed.cwd)).toBe(realpathSync(space.workingDir))
    expect(observed.marker).toBe(commandEnvironment.value)
    return { text: `The command received the workspace and marker: ${observed.marker}` }
  })
  await openCommandWorkspace(window, space)
  const turn = await sendAcceptanceMessage(window, 'Inspect the selected workspace and the non-secret launch marker.')
  expect(turn.spaceId).toBe(space.id)
  await expect(window.locator('.message-assistant').last()).toContainText(commandEnvironment.value)
  await waitForAcceptanceIdle(window, turn.conversationId)
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  expect(realpathSync(stored.cwd)).toBe(realpathSync(space.workingDir))
  expect(stored.marker).toBe(commandEnvironment.value)
  expect((await commandThoughts(window, turn.spaceId, turn.conversationId))[0].toolResult?.isError).toBe(false)
})

test('commands in two workspaces write only to their selected project', acceptance('terminal.commands.workspace-isolation'), async ({ acceptanceApp, model, window }) => {
  const first = await commandWorkspace(window, acceptanceApp.profile, 'First command')
  const second = await commandWorkspace(window, acceptanceApp.profile, 'Second command')
  const commands = new Map([first, second].map(space => [space.id, commandScript(acceptanceApp.profile, space.id, `const fs=require('node:fs');const value={cwd:process.cwd(),owner:${JSON.stringify(space.id)}};fs.writeFileSync('owned-output.json',JSON.stringify(value));process.stdout.write(JSON.stringify(value));`)]))
  let selected = first
  model.respond(request => {
    const id = `workspace-command-${selected.id}`
    const result = request.toolResults.find(result => result.id === id)
    if (!result) return { tools: [modelTool(request, 'Bash', { command: commands.get(selected.id)!, run_in_background: false }, id)] }
    const output = JSON.parse(result.text)
    expect(realpathSync(output.cwd)).toBe(realpathSync(selected.workingDir))
    expect(output.owner).toBe(selected.id)
    return { text: `The output belongs to workspace ${output.owner}.` }
  })
  let firstConversation = ''
  for (const space of [first, second]) {
    selected = space
    await openCommandWorkspace(window, space)
    const turn = await sendAcceptanceMessage(window, `Write the workspace marker for ${space.name}.`)
    expect(turn.spaceId).toBe(space.id)
    await expect(window.locator('.message-assistant').last()).toContainText(space.id)
    await waitForAcceptanceIdle(window, turn.conversationId)
    if (space === first) {
      firstConversation = turn.conversationId
      expect(existsSync(join(second.workingDir, 'owned-output.json'))).toBe(false)
    } else expect(turn.conversationId).not.toBe(firstConversation)
    expect(JSON.parse(readFileSync(join(space.workingDir, 'owned-output.json'), 'utf8')).owner).toBe(space.id)
  }
  expect(JSON.parse(readFileSync(join(first.workingDir, 'owned-output.json'), 'utf8')).owner).toBe(first.id)
})

test('exported shell state survives the next command in its resident session but not a new conversation', acceptance('terminal.commands.session-environment'), async ({ acceptanceApp, model, window }) => {
  const space = await commandWorkspace(window, acceptanceApp.profile, 'Session command')
  const nested = join(space.workingDir, 'selected subdirectory')
  mkdirSync(nested)
  const name = `ACCEPTANCE_SESSION_${randomUUID().replaceAll('-', '')}`
  const value = randomUUID()
  const inspect = commandScript(acceptanceApp.profile, 'inspect-session', `process.stdout.write(JSON.stringify({cwd:process.cwd(),marker:process.env[${JSON.stringify(name)}]??null}));`)
  let fresh = false
  model.respond(request => {
    const inspection = request.toolResults.find(result => result.id === (fresh ? 'fresh-session-command' : 'retained-session-command'))
    if (inspection) {
      const observed = JSON.parse(inspection.text)
      expect(realpathSync(observed.cwd)).toBe(realpathSync(fresh ? space.workingDir : nested))
      expect(observed.marker).toBe(fresh ? null : value)
      return { text: fresh ? 'The new conversation has its own command environment.' : `The resident session retained ${value}.` }
    }
    if (fresh) return { tools: [modelTool(request, 'Bash', { command: inspect, run_in_background: false }, 'fresh-session-command')] }
    if (request.toolResults.some(result => result.id === 'set-session-command')) return { tools: [modelTool(request, 'Bash', { command: inspect, run_in_background: false }, 'retained-session-command')] }
    return { tools: [modelTool(request, 'Bash', { command: `export ${name}=${shellQuote(value)}\ncd ${shellQuote(nested)}`, run_in_background: false }, 'set-session-command')] }
  })
  await openCommandWorkspace(window, space)
  const first = await sendAcceptanceMessage(window, 'Set a temporary shell variable, change directory and inspect them in the next command.')
  await expect(window.locator('.message-assistant').last()).toContainText(value)
  await waitForAcceptanceIdle(window, first.conversationId)
  expect(await commandThoughts(window, first.spaceId, first.conversationId)).toHaveLength(2)
  fresh = true
  await window.getByRole('button', { name: 'New', exact: true }).first().click()
  await expect(window.locator('.message-assistant')).toHaveCount(0)
  await expect(window.locator('textarea').first()).toHaveValue('')
  const next = await sendAcceptanceMessage(window, 'Inspect the independent environment in this new conversation.')
  expect(next.conversationId).not.toBe(first.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText('The new conversation has its own command environment.')
  await waitForAcceptanceIdle(window, next.conversationId)
})

test('a missing executable returns a real failure and the next command can recover', acceptance('terminal.commands.missing-command'), async ({ acceptanceApp, model, window }) => {
  const missing = `acceptance-command-that-does-not-exist-${randomUUID()}`
  const recovered = randomUUID()
  const command = commandScript(acceptanceApp.profile, 'recover-command', `process.stdout.write(${JSON.stringify(recovered)});`)
  model.respond(request => {
    const recovering = request.text.includes('Run the available command instead.')
    const id = recovering ? 'available-command' : 'missing-command'
    const result = request.toolResults.find(result => result.id === id)
    if (!result) return { tools: [modelTool(request, 'Bash', { command: recovering ? command : missing, run_in_background: false }, id)] }
    if (recovering) {
      expect(result.text).toContain(recovered)
      return { text: `The available command completed: ${result.text}` }
    }
    expect(result.text).toContain(missing)
    expect(result.text).toContain('Command exited with code 127')
    return { text: `The requested command could not run. ${result.text}` }
  })
  await navigateToChat(window)
  const failed = await sendAcceptanceMessage(window, `Run the unavailable command ${missing}.`)
  await expect(window.locator('.message-assistant').last()).toContainText('Command exited with code 127')
  await waitForAcceptanceIdle(window, failed.conversationId)
  const failure = (await commandThoughts(window, failed.spaceId, failed.conversationId))[0]
  expect(failure.toolResult).toMatchObject({ isError: true, output: expect.stringContaining(missing) })
  const next = await sendAcceptanceMessage(window, 'Run the available command instead.')
  expect(next.conversationId).toBe(failed.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText(recovered)
  await waitForAcceptanceIdle(window, next.conversationId)
  expect((await commandThoughts(window, next.spaceId, next.conversationId))[0].toolResult?.isError).toBe(false)
})

test('nonzero command exit retains stdout, stderr and the failed tool result', acceptance('terminal.commands.nonzero-exit'), async ({ acceptanceApp, model, window }) => {
  const stdout = `partial-output-${randomUUID()}`, stderr = `failure-detail-${randomUUID()}`
  const command = commandScript(acceptanceApp.profile, 'nonzero-command', `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exitCode=7;`)
  model.respond(request => {
    const result = request.toolResults.find(result => result.id === 'nonzero-command')
    if (!result) return { tools: [modelTool(request, 'Bash', { command, run_in_background: false }, 'nonzero-command')] }
    expect(result.text).toContain('Command exited with code 7')
    expect(result.text).toContain(stdout)
    expect(result.text).toContain(stderr)
    return { text: `The command did not complete successfully. ${result.text}` }
  })
  await navigateToChat(window)
  const turn = await sendAcceptanceMessage(window, 'Run the fixture that reports partial output and fails.')
  const message = window.locator('.message-assistant').last()
  await expect(message).toContainText(stdout)
  await expect(message).toContainText(stderr)
  await expect(message).toContainText('Command exited with code 7')
  await waitForAcceptanceIdle(window, turn.conversationId)
  const result = (await commandThoughts(window, turn.spaceId, turn.conversationId))[0].toolResult
  expect(result).toMatchObject({ isError: true, output: expect.stringContaining('Command exited with code 7') })
  expect(result?.output).toContain(stdout)
  expect(result?.output).toContain(stderr)
})

test('stopping command work terminates its owned parent and child before the next turn', acceptance('terminal.commands.cancel-tree'), async ({ acceptanceApp, model, window }) => {
  test.skip(process.platform !== 'darwin', 'This process-tree receipt check is defined for the macOS host only')
  const owned = ownedCommandTree(acceptanceApp.profile)
  const recovery = randomUUID()
  const command = commandScript(acceptanceApp.profile, 'after-cancel', `process.stdout.write(${JSON.stringify(recovery)});`)
  model.respond(request => {
    if (request.text.includes('Run after cancellation.')) {
      const result = request.toolResults.find(result => result.id === 'after-cancel-command')
      if (!result) return { tools: [modelTool(request, 'Bash', { command, run_in_background: false }, 'after-cancel-command')] }
      expect(result.text).toContain(recovery)
      return { text: `The new command completed after cancellation: ${result.text}` }
    }
    return { tools: [modelTool(request, 'Bash', { command: owned.command, timeout: 60000, run_in_background: false }, 'cancel-owned-command')] }
  })
  try {
    await navigateToChat(window)
    const turn = await sendAcceptanceMessage(window, 'Run the owned long command until I stop it.')
    await expect.poll(owned.receiptCount).toBe(2)
    await expect.poll(owned.running).toHaveLength(2)
    await window.getByTitle('Stop generation (Esc)', { exact: true }).click()
    await expect.poll(owned.running, { timeout: 15000 }).toEqual([])
    await waitForCommandIdleAfterStop(window, { conversationId: turn.conversationId, spaceId: turn.spaceId })
    const next = await sendAcceptanceMessage(window, 'Run after cancellation.')
    expect(next.conversationId).toBe(turn.conversationId)
    await expect(window.locator('.message-assistant').last()).toContainText(recovery)
    await waitForCommandIdleAfterStop(window, { conversationId: turn.conversationId, spaceId: turn.spaceId })
    expect(owned.running()).toEqual([])
  } finally { owned.cleanup() }
})
