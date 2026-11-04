import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { openManagedConversation, seedManagedConversation, seedManagedSpace } from '../fixtures/acceptance-management'
import { readSkillPackage, requireSkillData, skillImport, skillRef, skillRequest } from '../fixtures/acceptance-skills'
import { setWorkspaceMemory } from '../fixtures/acceptance-memory'
import { navigateToChat } from '../fixtures/helpers'

test.setTimeout(120000)

test('new Halo SDK requests exclude disabled personal files and expand the remaining effective command', acceptance('capabilities.skill-api.sdk-disable'), async ({ acceptanceApp, window, model }, info) => {
  await navigateToChat(window)
  const engine = await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
  expect(engine).toMatchObject({ success: true, data: { activeEngine: 'halo', degradedFrom: null } })
  const token = randomUUID().slice(0, 8)
  const project = join(acceptanceApp.profile, `catalog-project-${token}`)
  mkdirSync(project)
  const space = await seedManagedSpace(window, `Catalog workspace ${token}`, project)
  await setWorkspaceMemory(window, space, { enabled: false, autoConsolidate: false })
  const disabledName = `disabled-catalog-${token}`
  const enabledName = `enabled-catalog-${token}`
  const disabledBody = `Do not propagate this disabled instruction ${randomUUID()}.`
  const enabledBody = `Selected effective instruction ${randomUUID()}.`
  const disabled = requireSkillData(await skillRequest(window, 'skillsImport', skillImport(space.id, disabledName, disabledBody)))
  const enabled = requireSkillData(await skillRequest(window, 'skillsImport', skillImport(space.id, enabledName, enabledBody)))
  const beforeDisabled = readSkillPackage(acceptanceApp.profile, disabled)
  const beforeEnabled = readSkillPackage(acceptanceApp.profile, enabled)
  requireSkillData(await skillRequest(window, 'skillsSetEnabled', { ref: skillRef(disabled), enabled: false }))
  expect(readSkillPackage(acceptanceApp.profile, disabled)).toEqual(beforeDisabled)
  const observations: Array<{ text: string; lastUserText: string }> = []
  model.respond(request => {
    observations.push({ text: request.text, lastUserText: request.lastUserText })
    return { text: 'Observed the supplied effective skill context.' }
  })
  const conversation = await seedManagedConversation(window, space.id, `Catalog command ${token}`, [])
  await openManagedConversation(window, conversation.title, space.id, { empty: true })
  const turn = await sendAcceptanceMessage(window, `/${enabledName}`)
  await waitForAcceptanceIdle(window, turn.conversationId)
  expect(observations).toHaveLength(1)
  expect(observations[0].text).toContain(enabledBody)
  expect(observations[0].text).not.toContain(disabledName)
  expect(observations[0].text).not.toContain(disabledBody)
  expect(observations[0].lastUserText).toContain(`<skill-instructions name="${enabledName}">`)
  expect(readSkillPackage(acceptanceApp.profile, disabled)).toEqual(beforeDisabled)
  expect(readSkillPackage(acceptanceApp.profile, enabled)).toEqual(beforeEnabled)
  const reopened = await acceptanceApp.restart()
  expect(requireSkillData(await skillRequest(reopened, 'skillsRead', skillRef(disabled))).copy.enabled).toBe(false)
  const next = await seedManagedConversation(reopened, space.id, `Fresh catalog ${token}`, [])
  await openManagedConversation(reopened, next.title, space.id, { empty: true })
  const nextTurn = await sendAcceptanceMessage(reopened, 'Summarize the available skill catalog without loading any skill.')
  await waitForAcceptanceIdle(reopened, nextTurn.conversationId)
  expect(observations).toHaveLength(2)
  expect(observations[1].text).toContain(enabledName)
  expect(observations[1].text).not.toContain(disabledName)
  expect(observations[1].text).not.toContain(disabledBody)
  expect(readSkillPackage(acceptanceApp.profile, disabled)).toEqual(beforeDisabled)
  await info.attach('effective-skill-model-observations', { body: JSON.stringify({ requestedEngine: 'halo', spaceId: space.id, disabledName, enabledName, observations }, null, 2), contentType: 'application/json' })
})
