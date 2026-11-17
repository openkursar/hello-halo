import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import {
  test, expect, acceptance, appRoot, assertMoveEnvironments, chatBinding, connectMoveIm, createMoveChat,
  installMovePerson, movePreview, openMoveChat, openMoveConversationPage, openMoveWorkspaces, prepareLegacyMove, readMovePersistence, readMoveTranscript,
  seedMoveMemory, sendMoveIm, treeContents, waitForMoveChat, type MoveChat,
} from '../fixtures/acceptance-workspace-move'
import { sendAcceptanceMessage } from '../fixtures/acceptance-app'
import {
  listManagedSpaces, openManagedConversation, openManagedPerson, openWorkspaceMenu, readManagedPerson,
  seedManagedConversation, seedManagedSpace, workspaceCard, type ManagedSpace,
} from '../fixtures/acceptance-management'
import { openDigitalHumanConversation } from '../fixtures/helpers'
import {
  openAutomation, readAutomationActivity, readAutomationRuns, readAutomationState, startAutomation, waitForAutomationResult,
} from '../fixtures/acceptance-automation'
import { decisionCard, pendingDecisions, readDecision, waitForDecisionCompletion, waitForDecisionQuestion } from '../fixtures/acceptance-decisions'
import { contentText, createModelGate, latestUserInput, type AcceptanceModel, type ModelReply, type ModelRequest } from '../fixtures/acceptance-model'
import { skillImport } from '../fixtures/acceptance-skills'
import { showImConversation } from '../fixtures/acceptance-guest'
import { replyWithModelTool } from '../fixtures/acceptance-tool-discovery'

test.setTimeout(240000)
test.use({ sdkEngine: 'halo' })

async function noOverflow(dialog: Locator) {
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  for (const name of ['Cancel', 'Move here', 'Delete']) {
    const action = dialog.getByRole('button', { name, exact: true })
    if (await action.count()) {
      await action.scrollIntoViewIfNeeded()
      await expect(action).toBeInViewport()
      expect(await action.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return rect.left >= 0 && rect.right <= window.innerWidth
      })).toBe(true)
    }
  }
}

async function deletionDialog(page: Page, space: ManagedSpace) {
  await openMoveWorkspaces(page)
  await openWorkspaceMenu(page, space.name, 'Delete')
  return page.getByRole('alertdialog', { name: 'Delete this workspace?', exact: true })
}

async function deleteWorkspace(page: Page, space: ManagedSpace) {
  const dialog = await deletionDialog(page, space)
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(workspaceCard(page, space.name)).toHaveCount(0)
  await expect.poll(async () => (await listManagedSpaces(page)).some(item => item.id === space.id)).toBe(false)
  await expect.poll(() => existsSync(space.path)).toBe(false)
}

function report(request: ModelRequest, type: 'run_complete' | 'escalation', message: string, id: string, issues: string[]): ModelReply {
  if (request.toolResults.some(result => result.id === id)) return { text: message }
  return replyWithModelTool(request, 'report_to_user', { type, message }, id, issues)
}

function continuityInput(request: ModelRequest) {
  const input = latestUserInput(request).replace(/<relay-context>[\s\S]*?<\/relay-context>/g, '').trim()
  return input.match(/(?:^|\n)((?:Continuity |Resume |Holding chat |Question fixture |Workspace held reply )[^\n]+)\s*$/)?.[1] ?? input
}

function continuityScript(model: AcceptanceModel) {
  let phase: 'complete' | 'decision' | 'hold' = 'complete'
  const gate = createModelGate()
  const question = `Which release should the original work use? ${randomUUID()}`
  const answer = `Use the retained release ${randomUUID()}`
  const context = `Original independent work context ${randomUUID()}`
  const resumed: ModelRequest[] = []
  const chats: Array<{ input: string; request: ModelRequest }> = []
  const errors: string[] = []
  model.respond(request => {
    const input = continuityInput(request)
    if (input.includes(answer)) {
      resumed.push(request)
      return report(request, 'run_complete', 'The original decision completed in its relocated environment.', 'move-decision-complete', errors)
    }
    if (input.startsWith('Continuity ') || input.startsWith('Resume ') || input.startsWith('Holding chat ')) {
      const system = contentText(request.body.system) || request.messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => contentText(message.content)).join('\n')
      if (!system.includes('Help with the isolated task. Report independent work through report_to_user.')) errors.push(`The continuity message reached a non-person context: ${request.sequence}`)
      chats.push({ input, request })
      return { text: `Retained native reply: ${input}`, ...(input.startsWith('Holding chat ') ? { hold: gate.promise } : {}) }
    }
    if (request.toolResults.some(result => result.id === 'move-decision-ask')) return { text: 'Waiting for the original decision.' }
    if (phase === 'decision') return { ...report(request, 'escalation', question, 'move-decision-ask', errors), text: context }
    if (phase === 'hold') return { text: 'Independent work is still running.', hold: gate.promise }
    return report(request, 'run_complete', 'Independent continuity work completed.', 'move-work-complete', errors)
  })
  return { gate, question, answer, context, resumed, chats, errors, phase(value: typeof phase) { phase = value } }
}

async function resumeDesktop(page: Page, person: InstalledApp, target: ManagedSpace, chat: MoveChat, question: string) {
  await openMoveWorkspaces(page)
  if (target.id === 'halo-temp') {
    await openMoveConversationPage(page)
    const selector = page.getByTitle(/^Current workspace: .* — click to switch$/)
    if (await selector.getAttribute('title') !== 'Current workspace: Halo Workspace — click to switch') {
      await selector.click()
      const dropdown = selector.locator('..')
      await dropdown.getByRole('button').filter({ has: page.getByText('Halo Workspace', { exact: true }) }).click()
      await expect(selector).toHaveAttribute('title', 'Current workspace: Halo Workspace — click to switch')
    }
  } else {
    await workspaceCard(page, target.name).click()
  }
  await openDigitalHumanConversation(page, person.spec.name, chat.name)
  await expect(page.locator('.message-assistant [data-message-content]').filter({ hasText: chat.reply })).toBeVisible()
  const turn = await sendAcceptanceMessage(page, question, { expectedTarget: { spaceId: target.id, conversationId: chat.conversationId } })
  expect(turn.conversationId).toBe(chat.conversationId)
  await expect(page.locator('.message-assistant [data-message-content]').last()).toHaveText(`Retained native reply: ${question}`)
  await waitForMoveChat(page, person.id, chat.conversationId)
  expect(chatBinding(appRoot(target, person.id), person.id, chat.conversationId).sessionId).toBe(chat.nativeId)
  const history = await readMoveTranscript(page, person.id, target.id, chat.conversationId)
  expect(history.some(message => message.role === 'user' && message.content === chat.first)).toBe(true)
  expect(history.some(message => message.role === 'assistant' && message.content === chat.reply)).toBe(true)
}

function assertNativeContext(script: ReturnType<typeof continuityScript>, question: string, prior: string, reply: string) {
  const observations = script.chats.filter(entry => entry.input === question)
  expect(observations.length).toBeGreaterThan(0)
  for (const { request } of observations) {
    // Prior assistant content is generated only by the model, not supplied in the resume message.
    expect(request.text).toContain(prior)
    expect(request.messages.some(message => message.role === 'assistant' && contentText(message.content).includes(reply))).toBe(true)
    const native = contentText(request.body.system) || request.messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => contentText(message.content)).join('\n')
    expect(native).toContain('You are an exceptional autonomous agent')
  }
}

for (const activeChat of [false, true]) {
  test(activeChat ? 'narrow move counts the live reply and task, cancellation preserves both' : 'complete move survives origin deletion, old desktop and IM native resumes, the original decision and scheduled work',
    acceptance(activeChat ? 'people.settings.move-active-chat' : 'people.settings.move-delete-origin'),
    async ({ acceptanceApp, window, model, wecom, moveMcp }, info) => {
      let page = window
      const script = continuityScript(model)
      const origin = await seedManagedSpace(page, 'Original continuity workspace')
      const project = join(acceptanceApp.profile, 'destination-project')
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, 'project-note.txt'), 'Destination project files do not move.\n')
      const target = await seedManagedSpace(page, 'Destination continuity workspace', project)
      writeFileSync(join(origin.path, 'project-note.txt'), 'Origin project files do not move.\n')
      const person = await installMovePerson(page, origin.id, 'Continuity assistant')
      const skillName = `continuity-${'long-skill-name-'.repeat(6)}reference`
      const connectionName = `Continuity ${'long destination connection name '.repeat(5)}reference`
      let destinationConnectionId: string | undefined
      if (activeChat) {
        const imported = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.skillsImport(input), skillImport(target.id, skillName, 'Retain the synthetic continuity context.'))
        expect(imported.success).toBe(true)
        for (const space of [origin, target]) {
          const connection = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appInstall({ spaceId: input.spaceId, spec: {
            spec_version: '1.0', version: '1.0.0', type: 'mcp', name: input.name, author: 'Acceptance', description: 'An isolated continuity connection.',
            mcp_server: { transport: 'streamable-http', command: input.url },
          } }), { spaceId: space.id, name: connectionName, url: moveMcp.url })
          expect(connection.success).toBe(true)
          if (space.id === target.id) destinationConnectionId = (connection.data as { appId: string }).appId
        }
        const declared = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateSpec(input), { appId: person.id, specPatch: { requires: { mcps: [{ id: connectionName }] } } })
        expect(declared.success).toBe(true)
      }
      const source = appRoot(origin, person.id)
      const fact = `Remember synthetic continuity ${randomUUID()}`
      seedMoveMemory(source, fact)
      const desktop = await createMoveChat(page, person, source, `Continuity desktop ${randomUUID()}`)
      const instanceId = await connectMoveIm(page, person.id, wecom)
      const firstIm = `Continuity IM ${randomUUID()}`
      const imId = await sendMoveIm(page, person.id, wecom, firstIm)
      const imNativeId = chatBinding(source, person.id, imId).sessionId
      await openAutomation(page, { appId: person.id, name: person.spec.name, session: acceptanceApp })
      script.phase('decision')
      const decisionRun = await startAutomation(page, person.id)
      const decision = await waitForDecisionQuestion(page, person.id, decisionRun.runId, script.question)
      script.phase('hold')
      const running = await startAutomation(page, person.id)
      await expect.poll(() => model.exchanges.some(exchange => !!exchange.reply?.text?.includes('Independent work is still running.') && !exchange.completed)).toBe(true)
      let holdingChat: MoveChat | undefined
      if (activeChat) {
        const expectedTarget = await openMoveChat(page, person)
        const input = `Holding chat ${randomUUID()}`
        const turn = await sendAcceptanceMessage(page, input, { expectedTarget })
        await expect.poll(() => script.chats.some(entry => entry.input === input)).toBe(true)
        holdingChat = { ...turn, first: input, reply: `Retained native reply: ${input}`, name: '', nativeId: '' }
      }
      const before = readMovePersistence(acceptanceApp.profile, person.id)
      const files = treeContents(source)
      try {
        await page.setViewportSize({ width: activeChat ? 375 : 1280, height: 900 })
        let dialog = await movePreview(page, person, target)
        await expect(dialog).toContainText(`Ongoing work that will stop when you confirm: ${activeChat ? 2 : 1}.`)
        await expect(dialog).toContainText('Pending decisions to keep: 1. Conversations to move:')
        if (activeChat) {
          await expect(dialog).toContainText(skillName)
          await expect(dialog).toContainText(connectionName)
        }
        await noOverflow(dialog)
        await info.attach('move-preview', { body: await dialog.screenshot(), contentType: 'image/png' })
        const preview = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appPreviewSpaceChange(input), { appId: person.id, newSpaceId: target.id })
        expect(preview).toMatchObject({ success: true, data: { activeRunCount: 1, activeChatCount: activeChat ? 1 : 0, pendingDecisionCount: 1 } })
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
        expect(readMovePersistence(acceptanceApp.profile, person.id)).toEqual(before)
        expect(treeContents(source)).toEqual(files)
        expect(existsSync(appRoot(target, person.id))).toBe(false)
        expect((await readAutomationState(page, person.id)).runningRunId).toBe(running.runId)
        expect((await pendingDecisions(page, person.id)).map(entry => entry.id)).toContain(decision.id)
        if (holdingChat) {
          const state = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSessionState(input.appId, input.conversationId), { appId: person.id, conversationId: holdingChat.conversationId })
          expect(state).toMatchObject({ success: true, data: { isActive: true } })
        }
        dialog = await movePreview(page, person, target)
        await dialog.getByRole('button', { name: 'Move here', exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect.poll(async () => (await readManagedPerson(page, person.id)).spaceId).toBe(target.id)
        await waitForAutomationResult(page, person.id, running.runId, 'error')
        if (holdingChat) await waitForMoveChat(page, person.id, holdingChat.conversationId)
        const relocatedState = assertMoveEnvironments(acceptanceApp.profile, person.id, target)
        if (activeChat) {
          expect(destinationConnectionId).toBeTruthy()
          for (const row of [...relocatedState.sessions, ...relocatedState.runs]) expect(row.environment.mcpBindings).toMatchObject({ [connectionName]: destinationConnectionId })
        }
        expect(existsSync(source)).toBe(false)
        for (const file of Object.keys(files)) expect(existsSync(join(appRoot(target, person.id), file)), `Moved file ${file}`).toBe(true)
        expect(readFileSync(join(appRoot(target, person.id), 'memory.md'), 'utf8')).toContain(fact)
        expect(readFileSync(join(appRoot(target, person.id), 'memory', 'topics', 'continuity.md'), 'utf8')).toContain(fact)
        expect(readFileSync(join(origin.path, 'project-note.txt'), 'utf8')).toBe('Origin project files do not move.\n')
        expect(readFileSync(join(project, 'project-note.txt'), 'utf8')).toBe('Destination project files do not move.\n')
        expect((await readDecision(page, person.id, decision.id)).userResponse).toBeUndefined()
        script.phase('complete')
        script.gate.release()
        await page.setViewportSize({ width: 1280, height: 900 })
        await deleteWorkspace(page, origin)
        const desktopResume = `Resume desktop after deletion ${randomUUID()}`
        await resumeDesktop(page, person, target, desktop, desktopResume)
        assertNativeContext(script, desktopResume, desktop.first, desktop.reply)
        const imResume = `Resume IM after deletion ${randomUUID()}`
        await sendMoveIm(page, person.id, wecom, imResume)
        assertNativeContext(script, imResume, firstIm, `Retained native reply: ${firstIm}`)
        expect(chatBinding(appRoot(target, person.id), person.id, imId).sessionId).toBe(imNativeId)
        const imHistory = await readMoveTranscript(page, person.id, target.id, imId)
        expect(imHistory.some(message => message.role === 'assistant' && message.content === `Retained native reply: ${firstIm}`)).toBe(true)
        await showImConversation(page, { appId: person.id, appName: person.spec.name, instanceId, spaceId: target.id, profile: acceptanceApp.profile, workDir: target.path }, 'acceptance-move-owner', `Retained native reply: ${firstIm}`)
        await openAutomation(page, { appId: person.id, name: person.spec.name, session: acceptanceApp })
        await decisionCard(page, decision.id).getByRole('textbox', { name: script.question, exact: true }).fill(script.answer)
        await decisionCard(page, decision.id).getByRole('button', { name: 'Submit and continue this work', exact: true }).click()
        await waitForDecisionCompletion(page, person.id, decision)
        expect(script.resumed.length).toBeGreaterThan(0)
        expect(script.resumed[0].text).toContain(script.context)
        expect(script.resumed[0].text).toContain(script.question)
        expect((await readAutomationRuns(page, person.id)).find(run => run.runId === decisionRun.runId)).toMatchObject({ sessionKey: decisionRun.sessionKey, status: 'ok' })
        const manual = await startAutomation(page, person.id)
        await waitForAutomationResult(page, person.id, manual.runId, 'ok')
        const scheduled = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateFrequency(input), { appId: person.id, subscriptionId: 'continuity-schedule', frequency: '10s' })
        expect(scheduled.success).toBe(true)
        await expect.poll(async () => (await readAutomationRuns(page, person.id)).some(run => run.triggerType === 'schedule' && run.status === 'ok'), { timeout: 45000 }).toBe(true)
        const resetSchedule = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateFrequency(input), { appId: person.id, subscriptionId: 'continuity-schedule', frequency: '24h' })
        expect(resetSchedule.success).toBe(true)
        page = await acceptanceApp.restart()
        await wecom.awaitAuthenticated()
        const afterRestart = `Resume desktop after restart ${randomUUID()}`
        await resumeDesktop(page, person, target, desktop, afterRestart)
        assertNativeContext(script, afterRestart, desktop.first, desktop.reply)
        const imRestart = `Resume IM after restart ${randomUUID()}`
        await sendMoveIm(page, person.id, wecom, imRestart)
        assertNativeContext(script, imRestart, firstIm, `Retained native reply: ${firstIm}`)
        assertMoveEnvironments(acceptanceApp.profile, person.id, target)
        expect(readFileSync(join(appRoot(target, person.id), 'memory.md'), 'utf8')).toContain(fact)
        expect(existsSync(origin.path)).toBe(false)
        expect(script.errors).toEqual([])
        await openManagedPerson(page, person.spec.name)
        await expect(page.getByRole('button', { name: 'Capabilities and settings', exact: true })).toBeVisible()
      } finally {
        script.gate.release()
        await info.attach('move-continuity-observations', { body: JSON.stringify({ appId: person.id, before, after: readMovePersistence(acceptanceApp.profile, person.id), desktop, imId, imNativeId, resumed: script.resumed, errors: script.errors }, null, 2), contentType: 'application/json' })
      }
    })
}

for (const kind of ['central', 'project'] as const) {
  test(`delete ${kind} workspace rescues every same-name resident and retains an uninstalled record`, acceptance('workspaces.retention.rescue-people', { kind }), async ({ acceptanceApp, window, model, wecom }, info) => {
    let page = window
    const script = continuityScript(model)
    const project = join(acceptanceApp.profile, 'rescue-project')
    mkdirSync(project, { recursive: true })
    const origin = await seedManagedSpace(page, 'Resident workspace', kind === 'project' ? project : undefined)
    const other = await seedManagedSpace(page, 'Already moved destination')
    const donor = await seedManagedSpace(page, 'Second resident origin')
    const longName = 'Same-name continuity assistant with a deliberately long identifying name that must wrap on a narrow display'
    const first = await installMovePerson(page, origin.id, longName)
    const second = await installMovePerson(page, donor.id, longName)
    const removed = await installMovePerson(page, origin.id, 'Retired continuity assistant')
    const relocated = await installMovePerson(page, origin.id, 'Previously relocated assistant')
    const moved = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appMoveSpace(input), { appId: second.id, newSpaceId: origin.id })
    expect(moved.success).toBe(true)
    const residents = [first, second, removed]
    const chats: Array<{ person: InstalledApp; chat: MoveChat; fact: string; imId: string; imFirst: string; imNative: string }> = []
    let instanceId: string | undefined
    const bindIm = async (appId: string) => {
      if (!instanceId) { instanceId = await connectMoveIm(page, appId, wecom); return }
      const before = wecom.authenticationCount
      const bound = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.imChannelsSetInstanceApp(input.instanceId, input.appId), { instanceId, appId })
      expect(bound.success).toBe(true)
      await expect.poll(() => wecom.authenticationCount, { timeout: 30000 }).toBeGreaterThan(before)
      await wecom.awaitAuthenticated()
    }
    for (const [index, person] of residents.entries()) {
      const root = appRoot(origin, person.id)
      const fact = `Resident ${index} memory ${randomUUID()}`
      seedMoveMemory(root, fact)
      // Same-name residents are addressed by their stored local session through public APIs, not an ambiguous directory row.
      const created = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appSessionCreate(input), { appId: person.id })
      expect(created.success).toBe(true)
      const conversationId = created.data!.conversationId
      const firstInput = `Continuity resident ${index} ${randomUUID()}`
      const sent = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSend(input), { appId: person.id, spaceId: origin.id, conversationId, message: firstInput })
      expect(sent.success).toBe(true)
      await expect.poll(async () => (await readMoveTranscript(page, person.id, origin.id, conversationId)).some(message => message.content === `Retained native reply: ${firstInput}`), { timeout: 30000 }).toBe(true)
      await waitForMoveChat(page, person.id, conversationId)
      const chat: MoveChat = { spaceId: origin.id, conversationId, name: '', first: firstInput, reply: `Retained native reply: ${firstInput}`, nativeId: chatBinding(root, person.id, conversationId).sessionId }
      await bindIm(person.id)
      const imFirst = `Continuity resident IM ${index} ${randomUUID()}`
      const imId = await sendMoveIm(page, person.id, wecom, imFirst)
      chats.push({ person, chat, fact, imId, imFirst, imNative: chatBinding(root, person.id, imId).sessionId })
    }
    const uninstalled = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appUninstall(input), { appId: removed.id })
    expect(uninstalled.success).toBe(true)
    const relocatedRoot = appRoot(origin, relocated.id)
    seedMoveMemory(relocatedRoot, 'Already relocated independent memory')
    const relocatedChat = await createMoveChat(page, relocated, relocatedRoot, `Continuity already moved ${randomUUID()}`)
    const moveElsewhere = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appMoveSpace(input), { appId: relocated.id, newSpaceId: other.id })
    expect(moveElsewhere.success).toBe(true)
    const projectFile = join(origin.workingDir ?? origin.path, 'resident-project.txt')
    writeFileSync(projectFile, 'The linked project is independent.\n')
    await page.setViewportSize({ width: 375, height: 900 })
    let dialog = await deletionDialog(page, origin)
    await expect(dialog).toContainText(longName)
    await expect(dialog).toContainText('Retired continuity assistant')
    await expect(dialog).toContainText('move to Halo Workspace with their memory and all conversations')
    await noOverflow(dialog)
    await info.attach('rescue-confirmation', { body: await dialog.screenshot(), contentType: 'image/png' })
    const files = new Map(residents.map(person => [person.id, treeContents(appRoot(origin, person.id))]))
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    for (const person of residents) {
      expect((await readManagedPerson(page, person.id)).spaceId).toBe(origin.id)
      expect(treeContents(appRoot(origin, person.id))).toEqual(files.get(person.id))
    }
    dialog = await deletionDialog(page, origin)
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(() => existsSync(origin.path)).toBe(false)
    const halo = { id: 'halo-temp', name: 'Halo Workspace', path: join(acceptanceApp.profile, '.halo', 'temp') }
    page = await acceptanceApp.restart()
    for (const { person, chat, fact, imId, imFirst, imNative } of chats) {
      expect(await readManagedPerson(page, person.id)).toMatchObject({ id: person.id, spaceId: 'halo-temp', status: person.id === removed.id ? 'uninstalled' : 'active' })
      expect(readFileSync(join(appRoot(halo, person.id), 'memory.md'), 'utf8')).toContain(fact)
      expect(chatBinding(appRoot(halo, person.id), person.id, chat.conversationId).sessionId).toBe(chat.nativeId)
      expect(chatBinding(appRoot(halo, person.id), person.id, imId).sessionId).toBe(imNative)
      expect((await readMoveTranscript(page, person.id, halo.id, imId)).some(message => message.content === `Retained native reply: ${imFirst}`)).toBe(true)
      assertMoveEnvironments(acceptanceApp.profile, person.id, halo)
      if (person.id === removed.id) continue
      const question = `Resume rescued resident ${person.id}`
      const resumed = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSend(input), { appId: person.id, spaceId: halo.id, conversationId: chat.conversationId, message: question })
      expect(resumed.success).toBe(true)
      await expect.poll(async () => (await readMoveTranscript(page, person.id, halo.id, chat.conversationId)).some(message => message.content === `Retained native reply: ${question}`), { timeout: 30000 }).toBe(true)
      await waitForMoveChat(page, person.id, chat.conversationId)
      assertNativeContext(script, question, chat.first, chat.reply)
      await bindIm(person.id)
      const imResume = `Resume rescued IM ${person.id}`
      await sendMoveIm(page, person.id, wecom, imResume)
      assertNativeContext(script, imResume, imFirst, `Retained native reply: ${imFirst}`)
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await resumeDesktop(page, relocated, other, relocatedChat, `Resume unaffected person ${randomUUID()}`)
    expect(readFileSync(join(appRoot(other, relocated.id), 'memory.md'), 'utf8')).toContain('Already relocated independent memory')
    expect(existsSync(projectFile)).toBe(kind === 'project')
    if (kind === 'project') expect(readFileSync(projectFile, 'utf8')).toBe('The linked project is independent.\n')
    expect(script.errors).toEqual([])
  })
}

for (const variant of ['available', 'deleted', 'missing-pin', 'retained-pin'] as const) {
  const survivingOrigin = variant === 'available' || variant === 'retained-pin'
  const details = variant === 'retained-pin' ? acceptance('workspaces.retention.rescue-legacy-dependent')
    : variant === 'missing-pin' ? acceptance('people.settings.missing-workspace-recovery')
      : acceptance('people.settings.legacy-move-repair', { origin: variant })
  test(variant === 'retained-pin' ? 'deletion merges a legacy-dependent person into its current workspace before removing the origin'
    : `legacy ${variant} environment repairs without editing native sessions`, details, async ({ acceptanceApp, window, model, wecom }, info) => {
    let page = window
    const script = continuityScript(model)
    const origin = await seedManagedSpace(page, 'Legacy original workspace')
    const target = await seedManagedSpace(page, 'Legacy current workspace')
    const person = await installMovePerson(page, origin.id, 'Legacy continuity assistant')
    const source = appRoot(origin, person.id)
    const fact = `Legacy surviving memory ${randomUUID()}`
    seedMoveMemory(source, fact)
    const desktop = await createMoveChat(page, person, source, `Continuity legacy source ${randomUUID()}`)
    await connectMoveIm(page, person.id, wecom)
    const imFirst = `Continuity legacy IM ${randomUUID()}`
    const imId = await sendMoveIm(page, person.id, wecom, imFirst)
    await openAutomation(page, { appId: person.id, name: person.spec.name, session: acceptanceApp })
    const originalRun = await startAutomation(page, person.id)
    await waitForAutomationResult(page, person.id, originalRun.runId, 'ok')
    const snapshot = join(acceptanceApp.profile, `legacy-app-copy-${person.id}`)
    cpSync(source, snapshot, { recursive: true, errorOnExist: true })
    const moved = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appMoveSpace(input), { appId: person.id, newSpaceId: target.id })
    expect(moved.success).toBe(true)
    const newer = await createMoveChat(page, person, appRoot(target, person.id), `Continuity legacy destination ${randomUUID()}`)
    const child = acceptanceApp.app.process()
    let prepared: unknown
    page = await acceptanceApp.restart(profile => {
      prepared = prepareLegacyMove({ profile, child, person, origin, target, snapshot, sourceChat: desktop, destinationChat: newer, variant })
    })
    try {
      await wecom.awaitAuthenticated()
      await expect.poll(async () => (await readManagedPerson(page, person.id)).spaceId, { timeout: 30000 }).toBe(target.id)
      if (variant === 'available' || variant === 'deleted') await expect.poll(() => (readMovePersistence(acceptanceApp.profile, person.id).person as { data_path: string | null }).data_path, { timeout: 30000 }).toBeNull()
      const root = appRoot(target, person.id)
      if (variant === 'retained-pin') {
        const beforeDeletion = readMovePersistence(acceptanceApp.profile, person.id)
        expect(beforeDeletion.person).toMatchObject({ space_id: target.id, data_path: null })
        expect(beforeDeletion.sessions.some(row => row.environment.spaceId === origin.id)).toBe(true)
        expect(existsSync(join(source, 'source-only.txt'))).toBe(true)
        expect(existsSync(join(root, 'source-only.txt'))).toBe(false)
        const sourceFiles = treeContents(source)
        const targetFiles = treeContents(root)
        const dialog = await deletionDialog(page, origin)
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
        expect(readMovePersistence(acceptanceApp.profile, person.id)).toEqual(beforeDeletion)
        expect(treeContents(source)).toEqual(sourceFiles)
        expect(treeContents(root)).toEqual(targetFiles)
        await deleteWorkspace(page, origin)
        expect((await readManagedPerson(page, person.id)).spaceId).toBe(target.id)
        assertMoveEnvironments(acceptanceApp.profile, person.id, target)
      }
      if (survivingOrigin) {
        expect(readFileSync(join(root, 'source-only.txt'), 'utf8')).toBe('source-only continuity\n')
        expect(readFileSync(join(root, 'destination-only.txt'), 'utf8')).toBe('destination-only continuity\n')
        expect(readFileSync(join(root, 'memory.md'), 'utf8')).toContain('Destination conflict memory stays authoritative.')
        const conflicts = readdirSync(root).filter(name => name.startsWith('memory') && name.includes(`.from-${origin.id}`))
        expect(conflicts).toHaveLength(1)
        expect(readFileSync(join(root, conflicts[0]), 'utf8')).toContain('Source conflict memory remains available.')
        expect(existsSync(source)).toBe(false)
      }
      const question = `Resume legacy original ${randomUUID()}`
      await resumeDesktop(page, person, target, desktop, question)
      assertNativeContext(script, question, desktop.first, desktop.reply)
      const newerQuestion = `Resume legacy newer ${randomUUID()}`
      await resumeDesktop(page, person, target, newer, newerQuestion)
      assertNativeContext(script, newerQuestion, newer.first, newer.reply)
      const imResume = `Resume legacy IM ${randomUUID()}`
      await sendMoveIm(page, person.id, wecom, imResume)
      assertNativeContext(script, imResume, imFirst, `Retained native reply: ${imFirst}`)
      await openAutomation(page, { appId: person.id, name: person.spec.name, session: acceptanceApp })
      const schedule = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateFrequency(input), { appId: person.id, subscriptionId: 'continuity-schedule', frequency: '10s' })
      expect(schedule.success).toBe(true)
      await expect.poll(async () => (await readAutomationRuns(page, person.id)).some(run => run.triggerType === 'schedule' && run.status === 'ok'), { timeout: 45000 }).toBe(true)
      const reset = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateFrequency(input), { appId: person.id, subscriptionId: 'continuity-schedule', frequency: '24h' })
      expect(reset.success).toBe(true)
      if (variant === 'available') await deleteWorkspace(page, origin)
      const state = variant === 'missing-pin' ? readMovePersistence(acceptanceApp.profile, person.id) : assertMoveEnvironments(acceptanceApp.profile, person.id, target)
      if (variant === 'missing-pin') {
        const used = state.sessions.filter(row => [desktop.conversationId, imId, newer.conversationId].includes(row.key))
        expect(used).toHaveLength(3)
        for (const row of used) expect(row.environment).toMatchObject({ spaceId: target.id, spacePath: target.path, memoryDir: root })
      }
      page = await acceptanceApp.restart()
      await resumeDesktop(page, person, target, desktop, `Resume repaired restart ${randomUUID()}`)
      expect(readMovePersistence(acceptanceApp.profile, person.id).person).toEqual(state.person)
      if (!survivingOrigin) {
        const memory = existsSync(join(root, 'memory.md')) ? readFileSync(join(root, 'memory.md'), 'utf8') : ''
        expect(memory).not.toContain(fact)
        expect(existsSync(join(root, 'memory', 'topics', 'continuity.md'))).toBe(false)
      } else {
        expect(readFileSync(join(root, 'memory', 'topics', 'continuity.md'), 'utf8')).toContain(fact)
        expect(readFileSync(join(root, 'source-only.txt'), 'utf8')).toBe('source-only continuity\n')
        expect(readFileSync(join(root, 'destination-only.txt'), 'utf8')).toBe('destination-only continuity\n')
      }
      expect(script.errors).toEqual([])
    } finally {
      await info.attach('legacy-layout-observations', { body: JSON.stringify({ variant, prepared, after: readMovePersistence(acceptanceApp.profile, person.id) }, null, 2), contentType: 'application/json' })
    }
  })
}

test('confirmed deletion stops affected running work and ends only that workspace question', acceptance('workspaces.retention.stop-active-work'), async ({ acceptanceApp, window, model }, info) => {
  const page = window
  const origin = await seedManagedSpace(page, 'Busy workspace to delete')
  const unrelated = await seedManagedSpace(page, 'Unrelated waiting workspace')
  const person = await installMovePerson(page, origin.id, 'Busy retained assistant')
  const root = appRoot(origin, person.id)
  seedMoveMemory(root, 'Busy retained memory')
  const script = continuityScript(model)
  const prior = await createMoveChat(page, person, root, `Continuity busy prior ${randomUUID()}`)
  const runGate = createModelGate()
  const replyGate = createModelGate()
  const asks = [origin, unrelated].map(space => ({ space, title: `${space.name} question`, input: `Question fixture ${space.id}`, question: `Which local draft for ${space.name}?`, toolId: `question-${space.id}` }))
  const heldReply = `Workspace held reply ${randomUUID()}`
  const questionIssues: string[] = []
  model.respond(request => {
    const input = continuityInput(request)
    const ask = asks.find(ask => input.includes(ask.input))
    if (ask) {
      if (request.toolResults.some(result => result.id === ask.toolId)) return { text: 'The local question was answered or cancelled.' }
      return replyWithModelTool(request, 'AskUserQuestion', { questions: [{ question: ask.question, header: 'Draft', multiSelect: false, options: [{ label: 'Local', description: 'Use a local draft.' }, { label: 'Shared', description: 'Use a shared draft.' }] }] }, ask.toolId, questionIssues)
    }
    if (input.includes(heldReply)) return { text: 'Workspace reply remains in progress.', hold: replyGate.promise }
    if (input.startsWith('Resume ')) return { text: `Retained native reply: ${input}` }
    return { text: 'Independent run remains in progress.', hold: runGate.promise }
  })
  const waiting: Array<{ conversationId: string; spaceId: string; questionId: string }> = []
  const openWorkspaceChat = async (space: ManagedSpace, title: string, empty = false) => {
    // Re-entering the workspace reads API-created conversations instead of retaining its prior list.
    await openMoveWorkspaces(page)
    await workspaceCard(page, space.name).click()
    const conversations = page.getByRole('button', { name: 'Conversations', exact: true })
    await expect(conversations).toBeVisible()
    if (await conversations.getAttribute('aria-expanded') !== 'true') await conversations.click()
    await openManagedConversation(page, title, space.id, { empty })
  }
  try {
    for (const ask of asks) {
      const conversation = await seedManagedConversation(page, ask.space.id, ask.title, [])
      await openWorkspaceChat(ask.space, ask.title, true)
      const sent = await sendAcceptanceMessage(page, ask.input, { expectedTarget: { spaceId: ask.space.id, conversationId: conversation.id } })
      await expect(page.locator('.ask-question-card')).toContainText(ask.question)
      const state = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getSessionState(id), sent.conversationId)
      const pending = (state.data as { pendingQuestion?: { id: string } }).pendingQuestion
      expect(pending?.id).toBeTruthy()
      waiting.push({ ...sent, questionId: pending!.id })
    }
    const reply = await seedManagedConversation(page, origin.id, 'Running workspace reply', [])
    await openWorkspaceChat(origin, reply.title, true)
    const runningReply = await sendAcceptanceMessage(page, heldReply, { expectedTarget: { spaceId: origin.id, conversationId: reply.id } })
    await expect.poll(() => model.exchanges.some(exchange => exchange.request.lastUserText.includes(heldReply) && !exchange.completed)).toBe(true)
    await openAutomation(page, { appId: person.id, name: person.spec.name, session: acceptanceApp })
    const run = await startAutomation(page, person.id)
    await expect.poll(async () => (await readAutomationState(page, person.id)).runningRunId).toBe(run.runId)
    await expect.poll(() => model.exchanges.some(exchange => exchange.reply?.text === 'Independent run remains in progress.' && !exchange.completed)).toBe(true)
    const impactCount = async () => {
      const details = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getSpace(id, { includeDeletionImpact: true }), origin.id)
      expect(details.success).toBe(true)
      return (details.data as { deletionImpact: { activeWorkCount: number } }).deletionImpact.activeWorkCount
    }
    await expect.poll(impactCount).toBe(3)
    const count = await impactCount()
    let dialog = await deletionDialog(page, origin)
    await expect(dialog).toContainText(`Ongoing work that will stop when you confirm: ${count}.`)
    await expect(dialog).toContainText(person.spec.name)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    for (const turn of waiting) {
      const state = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getSessionState(id), turn.conversationId)
      expect(state).toMatchObject({ success: true, data: { isActive: true, pendingQuestion: { id: turn.questionId } } })
    }
    expect((await readAutomationState(page, person.id)).runningRunId).toBe(run.runId)
    dialog = await deletionDialog(page, origin)
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(() => existsSync(origin.path)).toBe(false)
    const stopped = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getSessionState(id), runningReply.conversationId)
    expect(stopped).toMatchObject({ success: true, data: { isActive: false } })
    const deletedQuestion = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getSessionState(id), waiting[0].conversationId)
    expect((deletedQuestion.data as { pendingQuestion?: unknown }).pendingQuestion).toBeUndefined()
    const stillWaiting = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getSessionState(id), waiting[1].conversationId)
    expect(stillWaiting).toMatchObject({ success: true, data: { isActive: true, pendingQuestion: { id: waiting[1].questionId } } })
    await waitForAutomationResult(page, person.id, run.runId, 'error')
    const halo = { id: 'halo-temp', name: 'Halo Workspace', path: join(acceptanceApp.profile, '.halo', 'temp') }
    assertMoveEnvironments(acceptanceApp.profile, person.id, halo)
    expect(readFileSync(join(appRoot(halo, person.id), 'memory.md'), 'utf8')).toContain('Busy retained memory')
    await resumeDesktop(page, person, halo, prior, `Resume after busy deletion ${randomUUID()}`)
    await openWorkspaceChat(unrelated, asks[1].title)
    const card = page.locator('.ask-question-card').filter({ hasText: asks[1].question })
    await card.getByRole('button', { name: 'Local Use a local draft.', exact: true }).click()
    await card.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(card).toHaveCount(0)
    expect(questionIssues).toEqual([])
    await info.attach('busy-deletion-activity', { body: JSON.stringify({ count, waiting, run, activity: await readAutomationActivity(page, person.id) }, null, 2), contentType: 'application/json' })
  } finally { runGate.release(); replyGate.release(); script.gate.release() }
})
