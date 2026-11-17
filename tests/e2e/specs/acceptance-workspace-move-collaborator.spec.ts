import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { HaloAPI } from '../../../src/preload'
import { buildTeamSessionKey } from '../../../src/shared/apps/team-types'
import type { Page } from '@playwright/test'
import {
  test, expect, acceptance, appRoot, chatBinding, installMovePerson, movePreview, openMoveChat,
  openMoveWorkspaces, readMoveTranscript, treeContents, waitForMoveChat,
} from '../fixtures/acceptance-workspace-move'
import { sendAcceptanceMessage } from '../fixtures/acceptance-app'
import { seedManagedSpace, openWorkspaceMenu, readManagedPerson } from '../fixtures/acceptance-management'
import { collaboratorReceipt, type CollaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { latestUserInput, contentText, type ModelRequest } from '../fixtures/acceptance-model'
import { replyWithModelTool } from '../fixtures/acceptance-tool-discovery'

test.setTimeout(180000)
test.use({ sdkEngine: 'halo' })

type Execution = {
  sourceAppId?: string; permissions: unknown; delegatedPolicy?: unknown; modelSelection: unknown; engineId: string;
  environment: { spaceId: string; spacePath: string; workDir: string; memoryDir: string };
  workspace?: { cwd: string; checkout?: string }; fileAccess?: { cwd: string; workspaceRoots: string[] };
}

function participantRecord(profile: string, appId: string) {
  const db = new Database(join(profile, '.halo', 'halo.db'), { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT * FROM team_participants WHERE app_id = ?').get(appId) as Record<string, unknown> | undefined
    expect(row).toBeTruthy()
    const { execution_json, ...identity } = row!
    return { identity, execution: JSON.parse(execution_json as string) as Execution }
  } finally { db.close() }
}

function nativeMemberBinding(root: string) {
  const map = JSON.parse(readFileSync(join(root, 'runs', '_session-ids.json'), 'utf8')) as Record<string, { engineId?: string; sessionId?: string }>
  const entries = Object.entries(map).filter(([, binding]) => binding.engineId === 'halo' && binding.sessionId)
  expect(entries).toHaveLength(1)
  return { key: entries[0][0], ...entries[0][1] }
}

async function memberHistory(page: Page, scope: { teamId: string; epochId: string }, appId: string, spaceId: string) {
  const result = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.teamChatMessages(input), { ...scope, appId, spaceId })
  expect(result.success).toBe(true)
  return result.data as Array<{ id: string; role: string; content: string }>
}

for (const placement of ['default'] as const) {
  test(`an idle ${placement} collaborator retains native context through its digital human's move`, acceptance('people.settings.move-collaborator', { placement }), async ({ acceptanceApp, window, model }, info) => {
    let page = window
    const origin = await seedManagedSpace(page, 'Collaborator original workspace')
    const target = await seedManagedSpace(page, 'Collaborator destination workspace')
    const person = await installMovePerson(page, origin.id, 'Collaborator continuity owner')
    const external = join(acceptanceApp.profile, 'explicit-collaborator-project')
    mkdirSync(external, { recursive: true })
    const externalNote = join(external, 'project-note.txt')
    writeFileSync(externalNote, 'Explicit collaborator project files stay in place.\n')
    const nonce = randomUUID()
    const start = `Delegate the isolated relocation check ${nonce}`
    const assignment = `COLLABORATOR_RELOCATION_ASSIGNMENT_${nonce}`
    const childReply = `Native collaborator private reply ${randomUUID()}`
    const resumedReply = `Same collaborator continued ${randomUUID()}`
    const resume = `Continue the original collaborator after relocation ${nonce}`
    const parentReply = 'The original collaborator has been created.'
    const parentResume = `Continue the original owner chat ${nonce}`
    const issues: string[] = []
    const observations: ModelRequest[] = []
    let created: CollaboratorReceipt | undefined
    model.respond(request => {
      const current = latestUserInput(request)
      const system = contentText(request.body.system) || request.messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => contentText(message.content)).join('\n')
      const userInputs = request.messages.filter(message => message.role === 'user').map(message => contentText(message.content))
      if (system.includes('temporary collaborator') && userInputs.some(input => input.includes(assignment))) {
        if (current.includes(resume)) {
          observations.push(request)
          return { text: resumedReply }
        }
        return { text: childReply }
      }
      if (system.includes('Help with the isolated task. Report independent work through report_to_user.') && userInputs.some(input => input.includes(start))) {
        if (current.includes(parentResume)) return { text: 'The original owner chat continued separately.' }
        const receipt = request.toolResults.find(result => result.id === 'move-collaborator-spawn')
        if (!receipt) return replyWithModelTool(request, 'spawn_agent', {
          name: 'Retained relocation checker', prompt: assignment,
        }, 'move-collaborator-spawn', issues)
        try { created = collaboratorReceipt(receipt) } catch (error) { issues.push(String(error)) }
        return { text: parentReply }
      }
      issues.push(`Unexpected collaboration input ${request.sequence}: ${current.slice(-500)}`)
      return { text: 'No matching relocation assignment.' }
    })
    const source = await openMoveChat(page, person)
    await sendAcceptanceMessage(page, start, { expectedTarget: source })
    await expect.poll(() => { expect(issues, 'The scripted actor and spawn receipt must be valid').toEqual([]); return created?.handle }, { timeout: 15000 }).toBeTruthy()
    await expect(page.locator('.message-assistant [data-message-content]').filter({ hasText: parentReply })).toBeVisible()
    const member = created!
    const collab = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id), source.conversationId)
    expect(collab.success).toBe(true)
    const scope = collab.data as { teamId: string; epochId: string }
    expect(scope).toMatchObject({ teamId: expect.any(String), epochId: expect.any(String) })
    const conversationId = buildTeamSessionKey(member.handle, scope.teamId, scope.epochId)
    await expect.poll(async () => (await memberHistory(page, scope, member.handle, origin.id)).some(message => message.role === 'assistant' && message.content === childReply), { timeout: 30000 }).toBe(true)
    await waitForMoveChat(page, member.handle, conversationId)
    await waitForMoveChat(page, person.id, source.conversationId)
    const before = participantRecord(acceptanceApp.profile, member.handle)
    const sourceRoot = before.execution.environment.memoryDir
    const transcriptRoot = appRoot(origin, member.handle)
    const native = nativeMemberBinding(transcriptRoot)
    const parentNative = chatBinding(appRoot(origin, person.id), person.id, source.conversationId)
    const metadataFiles = treeContents(sourceRoot)
    const transcriptFiles = treeContents(transcriptRoot)
    const sourceHistory = await readMoveTranscript(page, person.id, origin.id, source.conversationId)
    expect(before.execution.sourceAppId).toBe(person.id)
    expect(realpathSync(before.execution.environment.workDir)).toBe(realpathSync(origin.path))
    expect(before.execution.workspace?.checkout).toBeUndefined()
    expect(Object.keys(transcriptFiles).length).toBeGreaterThan(0)
    try {
      const dialog = await movePreview(page, person, target)
      await dialog.getByRole('button', { name: 'Move here', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(async () => (await readManagedPerson(page, person.id)).spaceId).toBe(target.id)
      const metadataTarget = join(appRoot(target, person.id), 'collaboration', member.handle)
      const transcriptTarget = appRoot(target, member.handle)
      const afterMove = participantRecord(acceptanceApp.profile, member.handle)
      expect(afterMove.identity).toEqual(before.identity)
      expect(afterMove.execution).toMatchObject({ sourceAppId: person.id, permissions: before.execution.permissions,
        modelSelection: before.execution.modelSelection, engineId: before.execution.engineId,
        environment: { spaceId: target.id, spacePath: target.path, memoryDir: metadataTarget } })
      expect(realpathSync(afterMove.execution.environment.workDir)).toBe(realpathSync(target.path))
      expect(afterMove.execution.delegatedPolicy).toEqual(before.execution.delegatedPolicy)
      if (afterMove.execution.fileAccess) {
        expect(realpathSync(afterMove.execution.fileAccess.cwd)).toBe(realpathSync(target.path))
        expect(afterMove.execution.fileAccess.workspaceRoots.map(root => realpathSync(root))).toContain(realpathSync(target.path))
      }
      expect(treeContents(metadataTarget)).toEqual(metadataFiles)
      expect(nativeMemberBinding(transcriptTarget)).toEqual(native)
      for (const [file, bytes] of Object.entries(transcriptFiles)) expect(treeContents(transcriptTarget)[file]).toBe(bytes)
      expect(existsSync(sourceRoot)).toBe(false)
      expect(existsSync(transcriptRoot)).toBe(false)
      await openMoveWorkspaces(page)
      await openWorkspaceMenu(page, origin.name, 'Delete')
      await page.getByRole('alertdialog', { name: 'Delete this workspace?', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
      await expect.poll(() => existsSync(origin.path)).toBe(false)
      page = await acceptanceApp.restart()
      const restarted = participantRecord(acceptanceApp.profile, member.handle)
      expect(restarted.identity).toEqual(before.identity)
      expect(restarted.execution.environment).toEqual(afterMove.execution.environment)
      const team = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamGet(id), scope.teamId)
      expect(team.success).toBe(true)
      expect(team.data).toMatchObject({ owningSpaceId: target.id, coordinatorConversationId: source.conversationId })
      const history = await memberHistory(page, scope, member.handle, target.id)
      expect(history.some(message => message.role === 'assistant' && message.content === childReply)).toBe(true)
      const sent = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.teamSendToMember(input), { ...scope, appId: member.handle, spaceId: target.id, message: resume })
      expect(sent.success).toBe(true)
      expect(sent.data).toMatchObject({ ok: true, finalMessage: resumedReply })
      await waitForMoveChat(page, member.handle, conversationId)
      expect(observations.length).toBeGreaterThan(0)
      for (const request of observations) {
        expect(request.text).toContain(assignment)
        expect(request.messages.some(message => message.role === 'assistant' && contentText(message.content).includes(childReply))).toBe(true)
        const system = contentText(request.body.system) || request.messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => contentText(message.content)).join('\n')
        expect(system).toContain('You are an exceptional autonomous agent')
        expect(system).toContain('temporary collaborator')
      }
      expect(nativeMemberBinding(transcriptTarget)).toEqual(native)
      expect(participantRecord(acceptanceApp.profile, member.handle).identity).toEqual(before.identity)
      const retainedSource = await readMoveTranscript(page, person.id, target.id, source.conversationId)
      expect(retainedSource.slice(0, sourceHistory.length)).toEqual(sourceHistory)
      expect(retainedSource.some(message => message.role === 'user' && message.content === resume)).toBe(false)
      expect(chatBinding(appRoot(target, person.id), person.id, source.conversationId)).toEqual(parentNative)
      const parentSend = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSend(input), { appId: person.id, spaceId: target.id, conversationId: source.conversationId, message: parentResume })
      expect(parentSend.success).toBe(true)
      await expect.poll(async () => (await readMoveTranscript(page, person.id, target.id, source.conversationId)).some(message => message.content === 'The original owner chat continued separately.'), { timeout: 30000 }).toBe(true)
      await waitForMoveChat(page, person.id, source.conversationId)
      expect(readFileSync(externalNote, 'utf8')).toBe('Explicit collaborator project files stay in place.\n')
      expect(issues).toEqual([])
      await info.attach('collaborator-relocation', { body: JSON.stringify({ placement, source, member, scope, before, afterMove, restarted, native, parentNative, metadataFiles, observations }, null, 2), contentType: 'application/json' })
    } finally {
      await info.attach('collaborator-relocation-final', { body: JSON.stringify({ placement, created, issues, observations }, null, 2), contentType: 'application/json' })
    }
  })
}
