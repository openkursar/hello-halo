import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import {
  test, expect, acceptance, readAcceptanceConversation, readAcceptanceErrors,
  sendAcceptanceMessage, waitForAcceptanceIdle,
} from '../fixtures/acceptance-app'
import { listManagedConversations, seedManagedSpace, workspaceCard } from '../fixtures/acceptance-management'
import { commandScript, commandThoughts } from '../fixtures/acceptance-terminal'
import { modelTool } from '../fixtures/acceptance-model'
import { navigateToChat, navigateToWorkspaces } from '../fixtures/helpers'

test.setTimeout(120000)

test('a missing selected folder blocks work until the original path is restored and the user resends', acceptance('workspaces.context.missing-folder'), async ({ acceptanceApp, model, window }, info) => {
  const workingDir = join(acceptanceApp.profile, 'selected project')
  const movedDir = join(acceptanceApp.profile, 'temporarily unavailable project')
  const controlDir = join(acceptanceApp.profile, 'unrelated project')
  mkdirSync(workingDir)
  mkdirSync(controlDir)
  const marker = randomUUID()
  const outputName = `directory-receipt-${marker}.json`
  const audit = join(acceptanceApp.profile, 'command-invocations.jsonl')
  const selectedContent = 'Keep the selected project source unchanged.\n'
  const controlContent = 'Keep the unrelated project source unchanged.\n'
  writeFileSync(join(workingDir, 'source.txt'), selectedContent)
  writeFileSync(join(controlDir, 'source.txt'), controlContent)
  const command = commandScript(acceptanceApp.profile, 'inspect-restored-directory', [
    "const fs = require('node:fs')",
    'let cwd = null',
    "try { cwd = fs.realpathSync(process.cwd()) } catch (error) { if (error.code !== 'ENOENT') throw error }",
    `const selected = fs.existsSync(${JSON.stringify(workingDir)}) ? fs.realpathSync(${JSON.stringify(workingDir)}) : null`,
    `const receipt = { cwd, selected, marker: ${JSON.stringify(marker)}, wrote: false }`,
    `if (cwd && selected && cwd === selected) { fs.writeFileSync(${JSON.stringify(outputName)}, JSON.stringify({ cwd, marker: receipt.marker })); receipt.wrote = true }`,
    `fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify(receipt) + ${JSON.stringify('\n')})`,
    'process.stdout.write(JSON.stringify(receipt))',
    'if (!receipt.wrote) process.exitCode = 73',
  ].join('\n'))
  const toolResults: Array<{ error: boolean; text: string }> = []
  const answer = 'The command completed in the restored selected project.'
  model.respond(request => {
    const result = request.toolResults.find(result => result.id === 'restored-directory-command')
    if (result) {
      toolResults.push({ error: result.error, text: result.text })
      return { text: answer }
    }
    return { tools: [modelTool(request, 'Bash', { command, run_in_background: false }, 'restored-directory-command')] }
  })
  const observations: Record<string, unknown> = {}

  try {
    await navigateToChat(window)
    const space = await seedManagedSpace(window, 'Selected unavailable project', workingDir)
    const control = await seedManagedSpace(window, 'Unrelated project', controlDir)
    expect(space.workingDir).toBe(workingDir)
    await navigateToWorkspaces(window)
    const card = workspaceCard(window, space.name)
    await expect(card).toHaveCount(1)
    await card.click()
    await expect(window.getByTitle(`Current workspace: ${space.name} — click to switch`, { exact: true })).toBeVisible()
    await expect(window.locator('textarea').first()).toBeVisible()
    const existing = new Set((await listManagedConversations(window, space.id)).map(conversation => conversation.id))
    await window.getByRole('button', { name: 'New', exact: true }).click()
    await expect.poll(async () => (await listManagedConversations(window, space.id)).filter(conversation => !existing.has(conversation.id)).length).toBe(1)
    const conversation = (await listManagedConversations(window, space.id)).find(conversation => !existing.has(conversation.id))!
    expect((await readAcceptanceConversation(window, space.id, conversation.id)).messages).toEqual([])
    expect(model.exchanges).toHaveLength(0)
    renameSync(workingDir, movedDir)
    expect(existsSync(workingDir)).toBe(false)
    const question = `Write the selected project receipt ${marker}`
    await window.locator('textarea').first().fill(question)
    await window.locator('[data-onboarding="send-button"]').click()
    await expect.poll(() => readAcceptanceErrors(window)).toHaveLength(1)
    const errors = await readAcceptanceErrors(window)
    expect(errors[0]).toMatchObject({
      type: 'error', errorType: 'working_dir_unavailable', spaceId: space.id, conversationId: conversation.id,
      workDirIssue: { spaceId: space.id, workDir: workingDir },
    })
    await waitForAcceptanceIdle(window, conversation.id, { expectedErrors: errors })
    const failed = await readAcceptanceConversation(window, space.id, conversation.id)
    expect(failed.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([question])
    const failure = failed.messages.find(message => message.role === 'assistant' && message.error?.includes('Working directory does not exist'))
    expect(failure).toBeTruthy()
    expect(failed.messages.some(message => message.role === 'assistant' && message.content.trim() && !message.error)).toBe(false)
    await expect(window.locator(`[data-message-id="${failure!.id}"]`).first()).toContainText('Working directory does not exist')
    const notice = window.locator('div.rounded-2xl').filter({ has: window.getByText('The working directory is unavailable', { exact: true }) })
    const presentation = await notice.count() === 1 ? {
      visible: await notice.isVisible(),
      namesFolder: await notice.getByText(workingDir, { exact: true }).count() === 1,
      offersRestore: (await notice.innerText()).includes('restore this one and send again'),
      offersChange: await notice.getByRole('button', { name: 'Change working directory', exact: true }).isEnabled(),
    } : null
    observations.failure = { errors, presentation, modelRequests: model.exchanges.length, hasCommandReceipt: existsSync(audit) }
    expect.soft(presentation, 'The settled failure must retain the specific folder and the supported restore-or-change action').toEqual({ visible: true, namesFolder: true, offersRestore: true, offersChange: true })
    expect(model.exchanges).toHaveLength(0)
    expect(existsSync(audit)).toBe(false)
    const alternatives = [acceptanceApp.profile, movedDir, controlDir, space.path, join(acceptanceApp.profile, '.halo', 'temp', 'artifacts')]
    for (const directory of alternatives) expect(existsSync(join(directory, outputName))).toBe(false)
    expect(readFileSync(join(movedDir, 'source.txt'), 'utf8')).toBe(selectedContent)
    expect(readFileSync(join(controlDir, 'source.txt'), 'utf8')).toBe(controlContent)

    renameSync(movedDir, workingDir)
    const retried = await sendAcceptanceMessage(window, question)
    expect(retried).toMatchObject({ spaceId: space.id, conversationId: conversation.id })
    await expect(window.locator('.message-assistant').last()).toContainText(answer)
    await waitForAcceptanceIdle(window, conversation.id, { expectedErrors: errors })
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0].error).toBe(false)
    const receipt = JSON.parse(toolResults[0].text) as { cwd: string; selected: string; marker: string; wrote: boolean }
    expect(receipt).toEqual({ cwd: realpathSync(workingDir), selected: realpathSync(workingDir), marker, wrote: true })
    const invocations = readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(invocations).toEqual([receipt])
    expect(JSON.parse(readFileSync(join(workingDir, outputName), 'utf8'))).toEqual({ cwd: realpathSync(workingDir), marker })
    for (const directory of alternatives) expect(existsSync(join(directory, outputName))).toBe(false)
    expect(readFileSync(join(workingDir, 'source.txt'), 'utf8')).toBe(selectedContent)
    expect(readFileSync(join(controlDir, 'source.txt'), 'utf8')).toBe(controlContent)
    const thoughts = await commandThoughts(window, space.id, conversation.id)
    expect(thoughts).toHaveLength(1)
    expect(thoughts[0].toolResult).toMatchObject({ isError: false, output: expect.stringContaining(marker) })
    const completed = await readAcceptanceConversation(window, space.id, conversation.id)
    expect(completed.messages.slice(0, failed.messages.length)).toEqual(failed.messages)
    expect(completed.messages.filter(message => message.role === 'user' && message.content === question)).toHaveLength(2)
    expect(completed.messages.filter(message => message.role === 'assistant' && message.content === answer && !message.error)).toHaveLength(1)
    await expect(window.getByText('The working directory is unavailable', { exact: true })).toHaveCount(0)
    for (const [id, directory] of [[space.id, workingDir], [control.id, controlDir]]) {
      const current = await window.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.getSpace(id), id)
      expect(current).toMatchObject({ success: true, data: { id, workingDir: directory } })
    }
    expect(model.exchanges).toHaveLength(2)
    expect(model.exchanges[0].request.lastUserText).toContain(question)
    observations.recovery = { receipt, modelRequests: model.exchanges.length, messageCount: completed.messages.length }
  } finally {
    await info.attach('missing-working-directory-observations', { body: JSON.stringify({ ...observations, toolResults }, null, 2), contentType: 'application/json' })
  }
})
