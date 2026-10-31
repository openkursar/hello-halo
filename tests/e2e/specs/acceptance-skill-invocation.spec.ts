import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { SkillSpec } from '../../../src/shared/apps/spec-types'
import {
  test, expect, acceptance, readAcceptanceConversation, sendAcceptanceMessage, waitForAcceptanceIdle,
} from '../fixtures/acceptance-app'
import { listManagedConversations, openManagedConversation, seedManagedSpace } from '../fixtures/acceptance-management'
import { setWorkspaceMemory } from '../fixtures/acceptance-memory'
import { navigateToApps, navigateToChat } from '../fixtures/helpers'

test.setTimeout(120000)

async function readSkill(page: Page, appId: string) {
  const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.appGet(id), appId)
  expect(result.success).toBe(true)
  expect(result.data).toMatchObject({ id: appId, spec: { type: 'skill' } })
  return result.data as InstalledApp & { spec: SkillSpec }
}

async function installSkill(page: Page, spaceId: string, name: string, displayName: string, body: string) {
  const content = `---\nname: ${name}\ndescription: Use for the isolated skill invocation check.\nuser-invocable: true\n---\n\n${body}\n`
  const result = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appInstall({
    spaceId: input.spaceId,
    spec: {
      spec_version: '1.0', type: 'skill', name: input.name, display_name: input.displayName,
      version: '1.0.0', author: 'Acceptance author', description: 'Use for the isolated skill invocation check.',
      skill_files: { 'SKILL.md': input.content },
    },
  }), { spaceId, name, displayName, content })
  expect(result.success, 'The precondition must install through the real application manager').toBe(true)
  const app = await readSkill(page, (result.data as { appId: string }).appId)
  expect(app).toMatchObject({ status: 'active', spaceId, specId: name, spec: { name, display_name: displayName } })
  return { app, content }
}

async function openSkill(page: Page, displayName: string) {
  await navigateToApps(page)
  await page.getByRole('button', { name: 'Capability library', exact: true }).click()
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByPlaceholder('Search Skills', { exact: true }).fill(displayName)
  const card = page.locator('[role="button"]').filter({ has: page.getByRole('heading', { name: displayName, level: 3, exact: true }) })
  await expect(card).toHaveCount(1)
  await card.click()
  await expect(page.getByRole('heading', { name: displayName, level: 2, exact: true })).toBeVisible()
}

for (const memory of ['enabled', 'disabled'] as const) {
  test(`using an installed workspace skill with memory ${memory} loads its real instructions and saves the reply`, acceptance('capabilities.skills.invoke', { memory }), async ({ acceptanceApp, model, window }, info) => {
    const token = randomUUID().slice(0, 8)
    const name = `invoke-evidence-${token}`
    const displayName = `Invocation evidence ${token}`
    const instruction = `InstalledInstruction-${randomUUID()}`
    const controlInstruction = `UnselectedInstruction-${randomUUID()}`
    const argument = `sample-${randomUUID().slice(0, 8)}`
    const body = `# Installed invocation evidence\n\nRead the installed reference ${instruction}.\nInvocation input: $ARGUMENTS\nConfirm that the selected skill instructions are available.`
    const controlBody = `# Unselected invocation control\n\nThis instruction belongs only to the other skill: ${controlInstruction}.`
    const answer = 'The requested installed skill instructions reached this conversation.'
    const observations: Array<{ sequence: number; text: string; lastUserText: string }> = []
    model.respond(request => {
      observations.push({ sequence: request.sequence, text: request.text, lastUserText: request.lastUserText })
      return { text: answer }
    })
    await navigateToChat(window)
    const availability = await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
    expect(availability).toMatchObject({ success: true, data: { activeEngine: 'halo', degradedFrom: null } })
    const project = join(acceptanceApp.profile, 'skill invocation project')
    mkdirSync(project)
    const space = await seedManagedSpace(window, `Invocation workspace ${token}`, project)
    await setWorkspaceMemory(window, space, { enabled: memory === 'enabled', autoConsolidate: false })
    const chosen = await installSkill(window, space.id, name, displayName, body)
    const control = await installSkill(window, space.id, `invoke-control-${token}`, `Invocation control ${token}`, controlBody)
    const discovered = await window.evaluate(spaceId => (window as unknown as { halo: HaloAPI }).halo.appListAvailableSkillsForSpace(spaceId), space.id)
    expect(discovered.success).toBe(true)
    const files = new Map<string, string>()
    for (const installed of [chosen, control]) {
      const matching = discovered.data?.filter(skill => skill.dirName === installed.app.specId) ?? []
      expect(matching).toHaveLength(1)
      expect(matching[0].scope).toBe('space')
      const directory = realpathSync(matching[0].path)
      const owned = relative(realpathSync(acceptanceApp.profile), directory)
      expect(owned.length > 0 && !isAbsolute(owned) && owned !== '..' && !owned.startsWith(`..${sep}`)).toBe(true)
      const file = join(directory, 'SKILL.md')
      expect(readFileSync(file, 'utf8')).toBe(installed.content)
      files.set(file, installed.content)
    }
    expect(await listManagedConversations(window, space.id)).toEqual([])
    expect(model.exchanges).toHaveLength(0)
    await expect(window.getByRole('heading', { name: 'Workspace', exact: true, level: 1 })).toBeVisible()
    await expect(window.getByRole('heading', { name: space.name, level: 3, exact: true })).toBeVisible()
    await openSkill(window, displayName)
    await window.getByRole('button', { name: 'Use', exact: true }).click()
    await expect(window.getByTitle(`Current workspace: ${space.name} — click to switch`, { exact: true })).toBeVisible()
    const composer = window.locator('textarea').first()
    await expect(composer).toHaveValue(`/${name} `)
    expect(await composer.inputValue()).not.toContain(instruction)
    await composer.press('End')
    await composer.pressSequentially(argument)
    const submitted = `/${name} ${argument}`
    await expect(composer).toHaveValue(submitted)
    await expect.poll(async () => (await listManagedConversations(window, space.id)).length).toBe(1)
    const [conversation] = await listManagedConversations(window, space.id)
    expect((await readAcceptanceConversation(window, space.id, conversation.id)).messages).toEqual([])
    const turn = await sendAcceptanceMessage(window, submitted)
    expect(turn).toMatchObject({ spaceId: space.id, conversationId: conversation.id })
    await expect(window.locator('.message-assistant').last()).toContainText(answer)
    await waitForAcceptanceIdle(window, turn.conversationId)
    await info.attach('installed-skill-model-observations', { body: JSON.stringify({ appId: chosen.app.id, spaceId: space.id, command: submitted, observations }, null, 2), contentType: 'application/json' })
    expect(observations).toHaveLength(1)
    const blocks = [...observations[0].lastUserText.matchAll(/<skill-instructions name="([^"]+)">\n([\s\S]*?)\n<\/skill-instructions>/g)]
    expect(blocks).toHaveLength(1)
    expect(blocks[0][1]).toBe(name)
    expect(blocks[0][2]).toBe(body.replace('$ARGUMENTS', argument))
    expect(observations[0].text.split(instruction)).toHaveLength(2)
    expect(observations[0].text).not.toContain(controlInstruction)
    expect(blocks[0][2]).not.toContain('$ARGUMENTS')
    const saved = await readAcceptanceConversation(window, turn.spaceId, turn.conversationId)
    expect(saved.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([submitted])
    expect(saved.messages.filter(message => message.role === 'assistant' && message.content === answer && !message.error)).toHaveLength(1)
    for (const [file, content] of files) expect(readFileSync(file, 'utf8')).toBe(content)
    expect((await readSkill(window, control.app.id)).spec).toEqual(control.app.spec)

    const reopened = await acceptanceApp.restart()
    await openManagedConversation(reopened, saved.title, space.id)
    await expect(reopened.locator('.message-assistant').last()).toContainText(answer)
    expect((await readAcceptanceConversation(reopened, space.id, conversation.id)).messages).toEqual(saved.messages)
    for (const installed of [chosen, control]) {
      expect(await readSkill(reopened, installed.app.id)).toMatchObject({ status: 'active', spaceId: space.id, spec: installed.app.spec })
    }
    for (const [file, content] of files) expect(readFileSync(file, 'utf8')).toBe(content)
    expect(model.exchanges).toHaveLength(1)
  })
}
