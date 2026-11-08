/**
 * Choosing who answers a bot: Settings → Message channels offers the digital
 * humans and saved teams a person set up, never the member a temporary
 * collaboration built for one piece of work. A bot already bound to that member,
 * on its own or inside the collaboration, keeps its binding and names it, and
 * keeping the collaboration as a team makes the member an ordinary choice.
 *
 * The collaboration is the real seeded one from fixtures/team-collab; the
 * digital human, the bots and the save go through the application's own API.
 */

import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, COLLAB_MEMBER_APP_ID, COLLAB_MEMBER_NAME, COLLAB_TEAM_NAME } from '../fixtures/team-collab'
import { navigateToSettings } from '../fixtures/helpers'

test.setTimeout(90000)

const FRONT_DESK = 'Front desk'
const PLACEHOLDER = 'Select a digital human or team member'

interface Picker {
  value: string
  options: Array<{ value: string; text: string; disabled: boolean }>
  groups: string[]
}

async function prepare(page: Page, collabTeamId: string) {
  const result = await page.evaluate(async input => {
    const halo = (globalThis.window as unknown as { halo: HaloAPI }).halo
    const installed = await halo.appInstall({
      spaceId: 'halo-temp',
      spec: {
        spec_version: '1.0', version: '1.0.0', type: 'automation', name: input.name,
        author: 'Acceptance author', description: 'Answers the front desk bot.',
        system_prompt: 'Respond only to the supplied synthetic task.', subscriptions: [], requires: {}, config_schema: [], permissions: [],
      },
    })
    if (!installed.success) return { installed }
    const instances = [
      { id: 'bot-collab', type: 'wecom-bot', appId: input.memberAppId },
      { id: 'bot-free', type: 'wecom-bot', appId: '' },
      { id: 'bot-collab-team', type: 'wecom-bot', appId: input.memberAppId, teamId: input.collabTeamId },
    ].map(instance => ({ ...instance, enabled: false, config: {} }))
    const saved = await halo.setConfig({ imChannels: { instances } })
    if (!saved.success) return { installed, saved }
    return { installed, saved, reloaded: await halo.imChannelsReload() }
  }, { name: FRONT_DESK, memberAppId: COLLAB_MEMBER_APP_ID, collabTeamId })
  expect(result.installed.success).toBe(true)
  expect(result.saved?.success).toBe(true)
  expect(result.reloaded?.success).toBe(true)
  return (result.installed.data as { appId: string }).appId
}

async function binding(page: Page, instanceId: string) {
  return page.evaluate(async id => {
    const result = await (globalThis.window as unknown as { halo: HaloAPI }).halo.getConfig()
    const instances = (result.data as { imChannels?: { instances?: Array<{ id: string; appId: string; teamId?: string }> } }).imChannels?.instances ?? []
    const bot = instances.find(instance => instance.id === id)
    return bot && { appId: bot.appId, teamId: bot.teamId }
  }, instanceId)
}

/** Open every bot in the global channel settings and read its backend list. */
async function readPickers(page: Page, collabTeamId: string): Promise<{ bound: Picker; boundInTeam: Picker; free: Picker }> {
  await page.reload()
  await navigateToSettings(page)
  const section = page.locator('#message-channels')
  await section.getByRole('button', { name: /WeCom Intelligent Bot/ }).click()
  await section.getByRole('button', { name: new RegExp(`^${COLLAB_MEMBER_NAME}(?! · Team)`) }).click()
  await section.getByRole('button', { name: new RegExp(`^${COLLAB_MEMBER_NAME} · Team ${COLLAB_TEAM_NAME}`) }).click()
  await section.getByRole('button', { name: /^Not bound/ }).click()
  const pickers = section.locator('select').filter({ has: page.locator('option', { hasText: PLACEHOLDER }) })
  await expect(pickers).toHaveCount(3)
  const read = (await pickers.evaluateAll(nodes => nodes.map(node => {
    const select = node as HTMLSelectElement
    return {
      value: select.value,
      options: [...select.options].map(option => ({ value: option.value, text: option.text, disabled: option.disabled })),
      groups: [...select.querySelectorAll('optgroup')].map(group => group.label),
    }
  }))) as Picker[]
  const bound = read.find(picker => picker.value === `app:${COLLAB_MEMBER_APP_ID}`)
  const boundInTeam = read.find(picker => picker.value === `team:${collabTeamId}:${COLLAB_MEMBER_APP_ID}`)
  const free = read.find(picker => picker.value === '')
  expect(bound, 'the bot bound to the collaboration member').toBeDefined()
  expect(boundInTeam, 'the bot bound to the member inside the collaboration').toBeDefined()
  expect(free, 'the unbound bot').toBeDefined()
  return { bound: bound!, boundInTeam: boundInTeam!, free: free! }
}

const memberOption = `app:${COLLAB_MEMBER_APP_ID}`
const offered = (picker: Picker) => picker.options.filter(option => !option.disabled && option.value !== '')

for (const width of [1280, 375]) {
  test(`a bot's backend list offers only people set up by the user at ${width}px`, { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'channels.connect.choices', evidence: 'app-e2e', mode: 'none', variant: { width: String(width) } }) } }, async ({ window, collaboration }) => {
    await window.setViewportSize({ width, height: 900 })
    const frontDeskId = await prepare(window, collaboration.teamId)
    const teamOption = `team:${collaboration.teamId}:${COLLAB_MEMBER_APP_ID}`
    const inCollaboration = (picker: Picker) => picker.options.filter(option => option.value.startsWith(`team:${collaboration.teamId}:`))
    const unchanged = async () => {
      expect(await binding(window, 'bot-collab')).toEqual({ appId: COLLAB_MEMBER_APP_ID, teamId: undefined })
      expect(await binding(window, 'bot-collab-team')).toEqual({ appId: COLLAB_MEMBER_APP_ID, teamId: collaboration.teamId })
    }

    const before = await readPickers(window, collaboration.teamId)
    for (const picker of [before.bound, before.boundInTeam, before.free]) {
      const values = offered(picker).map(option => option.value)
      expect(values).toContain(`app:${frontDeskId}`)
      expect(values).not.toContain(memberOption)
      expect(values.some(value => value.startsWith(`team:${collaboration.teamId}:`))).toBe(false)
      expect(picker.groups).not.toContain(`Team: ${COLLAB_TEAM_NAME}`)
    }
    expect(before.free.options.map(option => option.value)).not.toContain(memberOption)
    expect(inCollaboration(before.free)).toEqual([])
    // Each bound bot still names what it is bound to, as its current, not-offered choice.
    expect(before.bound.options.filter(option => option.value === memberOption)).toEqual([
      { value: memberOption, text: COLLAB_MEMBER_NAME, disabled: true },
    ])
    expect(inCollaboration(before.boundInTeam)).toEqual([
      { value: teamOption, text: `${COLLAB_MEMBER_NAME} · Team ${COLLAB_TEAM_NAME}`, disabled: true },
    ])
    await unchanged()
    await window.screenshot({ path: `tests/e2e/results/channel-backend-choices-${width}.png`, animations: 'disabled' })

    const kept = await window.evaluate(async teamId => {
      const halo = (globalThis.window as unknown as { halo: HaloAPI }).halo
      const saved = await halo.teamSaveCollab({ teamId })
      const detail = await halo.teamGetDetail(teamId)
      return { saved, savedTeamId: (detail.data as { team?: { savedTeamId?: string } } | undefined)?.team?.savedTeamId }
    }, collaboration.teamId)
    expect(kept.saved.success).toBe(true)
    expect(kept.savedTeamId).toBeTruthy()

    const after = await readPickers(window, collaboration.teamId)
    for (const picker of [after.bound, after.boundInTeam, after.free]) {
      const values = offered(picker).map(option => option.value)
      expect(values).toContain(memberOption)
      expect(values).toContain(`team:${kept.savedTeamId}:${COLLAB_MEMBER_APP_ID}`)
      expect(values.some(value => value.startsWith(`team:${collaboration.teamId}:`))).toBe(false)
    }
    expect(inCollaboration(after.free)).toEqual([])
    expect(after.bound.options.filter(option => option.value === memberOption)).toEqual([
      { value: memberOption, text: COLLAB_MEMBER_NAME, disabled: false },
    ])
    expect(inCollaboration(after.boundInTeam)).toEqual([
      { value: teamOption, text: `${COLLAB_MEMBER_NAME} · Team ${COLLAB_TEAM_NAME}`, disabled: true },
    ])
    await unchanged()
    const dimensions = await window.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }))
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1)
  })
}
