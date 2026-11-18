import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance } from '../fixtures/acceptance-app'
import { assignmentCall, assignmentSettings, bindSmall, storedAssignmentConfig, openAssignmentPanel } from '../fixtures/acceptance-subagent-models'
import { navigateToSettings, setTheme } from '../fixtures/helpers'

test.setTimeout(120000)
test.use({ diagnoseShutdown: true })

for (const theme of ['dark', 'light'] as const) for (const width of ['1280', '390']) {
  test(`inline assignment editor in ${theme} at ${width}px`, acceptance('models.subagent-profiles.inline', { theme, width }), async ({ window, acceptanceApp }, info) => {
    await window.setViewportSize({ width: Number(width), height: 900 })
    await setTheme(window, theme)
    await navigateToSettings(window)
    const panel = await openAssignmentPanel(window)
    const heading = window.locator('[data-ai-add-row]').getByRole('heading', { name: 'Model assignments', exact: true })
    await heading.evaluate(heading => {
      const scroller = heading.closest('main')!
      const stickyBottom = [...scroller.children].filter(child => getComputedStyle(child).position === 'sticky').reduce((bottom, child) => Math.max(bottom, child.getBoundingClientRect().bottom), scroller.getBoundingClientRect().top)
      scroller.scrollBy({ top: heading.getBoundingClientRect().top - stickyBottom - 12, behavior: 'instant' })
    })
    await expect(heading).toBeInViewport()
    await info.attach(`assignment-open-${theme}-${width}`, { body: await window.screenshot({ fullPage: true }), contentType: 'image/png' })
    if (width === '390') {
      const footer = panel.getByRole('button', { name: 'Add custom assignment', exact: true })
      await footer.scrollIntoViewIfNeeded()
      await info.attach(`assignment-tiers-${theme}-${width}`, { body: await window.screenshot({ fullPage: true }), contentType: 'image/png' })
    }
    const row = panel.locator('[data-subagent-profile-id="builtin:small"]')
    const trigger = row.getByRole('button', { name: 'Configure', exact: true })
    await trigger.click()
    const picker = row.getByRole('form')
    await expect(picker.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
    await expect(picker.getByLabel('Reasoning effort', { exact: true })).toHaveCount(0)
    await picker.getByRole('searchbox', { name: 'Search accounts and models' }).fill('local gpt-4o')
    await expect(picker.getByRole('button', { name: 'gpt-4o', exact: true })).toBeVisible()
    await info.attach(`assignment-${theme}-${width}`, { body: await window.screenshot({ fullPage: true }), contentType: 'image/png' })
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await expect(window.getByRole('dialog')).toHaveCount(0)
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await picker.getByRole('button', { name: 'gpt-4o', exact: true }).click()
    const edit = row.getByRole('button', { name: 'Edit', exact: true })
    await expect(edit).toBeFocused()
    await expect(picker).toHaveCount(0)
    const settings = await assignmentSettings(window)
    const slot = settings.profiles.find(profile => profile.id === 'builtin:small')!
    await edit.click()
    await picker.getByRole('button', { name: 'Edit details', exact: true }).click()
    await expect(picker.getByLabel('Reasoning effort', { exact: true })).toHaveCount(0)
    await panel.getByLabel('Suitable tasks', { exact: true }).fill('Conflicting inline draft')
    await window.keyboard.press('Escape')
    await expect(panel.getByLabel('Suitable tasks', { exact: true })).toHaveValue('Conflicting inline draft')
    const concurrent = await assignmentCall(window, 'updateSubagentModel', { id: slot.id, expectedRevision: slot.revision, description: 'Other client edit', target: slot.target })
    expect(concurrent.success).toBe(true)
    await panel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(panel.getByRole('status').filter({ hasText: 'Assignments changed elsewhere.' })).toHaveText('Assignments changed elsewhere. Your open draft is preserved; saving it will check for conflicts.')
    await expect(row.getByRole('form').getByRole('alert')).toHaveText('This assignment changed elsewhere. Your draft is safe. Cancel and reopen it to edit the latest version.')
    await expect(panel.getByLabel('Suitable tasks', { exact: true })).toHaveValue('Conflicting inline draft')
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
    const page = await acceptanceApp.restart()
    expect(await assignmentSettings(page)).toEqual(concurrent.data)
  })
}

test('opening and cancelling assignment drafts does not activate the capability', acceptance('models.subagent-profiles.hidden'), async ({ window, acceptanceApp, model }) => {
  const before = storedAssignmentConfig(acceptanceApp.profile)
  expect(before.settings).toBeUndefined()
  await navigateToSettings(window)
  await expect(window.locator('[data-subagent-models-manager]')).toHaveCount(0)
  const panel = await openAssignmentPanel(window)
  await expect(panel.getByRole('heading', { name: 'Small', exact: true })).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Medium', exact: true })).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Large', exact: true })).toBeVisible()
  await expect(panel.getByText('Not configured', { exact: true })).toHaveCount(3)
  await panel.locator('[data-subagent-profile-id="builtin:small"]').getByRole('button', { name: 'Configure', exact: true }).click()
  await panel.getByRole('searchbox', { name: 'Search accounts and models' }).fill('local gpt-4o')
  await window.keyboard.press('Escape')
  await expect(panel.getByRole('searchbox')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'More ways to add', exact: true })).toBeFocused()
  expect(storedAssignmentConfig(acceptanceApp.profile)).toEqual(before)
  expect(model.exchanges).toEqual([])
})

test('targeted IPC changes survive restart and preserve the main selection', acceptance('models.subagent-profiles.configuration', { transport: 'ipc' }), async ({ window, acceptanceApp }) => {
  const original = storedAssignmentConfig(acceptanceApp.profile)
  let settings = await bindSmall(window)
  expect(settings.selectionMode).toBe('inherit')
  const slot = settings.profiles.find(profile => profile.id === 'builtin:small')!
  const created = await assignmentCall(window, 'createSubagentModel', {
    name: 'Independent verifier', description: 'Verify extracted fields',
    target: { kind: 'model', sourceId: 'acceptance-local', modelId: 'gpt-4o' },
  })
  expect(created.success, created.error).toBe(true)
  const custom = created.data!.profiles.find(profile => profile.kind === 'custom')!
  const renamed = await assignmentCall(window, 'updateSubagentModel', {
    id: custom.id, expectedRevision: custom.revision, name: 'Independent reviewer', description: custom.description, target: custom.target,
  })
  expect(renamed.success, renamed.error).toBe(true)
  expect(renamed.data!.profiles.find(profile => profile.id === custom.id)).toMatchObject({ name: 'Independent reviewer' })
  const switched = await assignmentCall(window, 'setSubagentModelSelectionMode', { selectionMode: 'task', expectedRevision: renamed.data!.revision })
  expect(switched.success, switched.error).toBe(true)
  expect(switched.data!.selectionMode).toBe('task')
  const currentCustom = switched.data!.profiles.find(profile => profile.id === custom.id)!
  const deleted = await assignmentCall(window, 'deleteSubagentModel', { id: custom.id, expectedRevision: currentCustom.revision })
  expect(deleted.success, deleted.error).toBe(true)
  const cleared = await assignmentCall(window, 'clearBuiltinSubagentModel', { id: slot.id, expectedRevision: slot.revision })
  expect(cleared.success, cleared.error).toBe(true)
  settings = cleared.data!
  expect(settings.selectionMode).toBe('inherit')
  expect(settings.profiles).toHaveLength(3)
  const empty = settings.profiles.find(profile => profile.id === slot.id)!
  expect(empty).toMatchObject({ id: slot.id, description: slot.description })
  expect(empty.revision).toBeGreaterThan(slot.revision)
  expect(empty.target).toBeUndefined()
  expect(empty).not.toHaveProperty('reasoningEffort')
  const page = await acceptanceApp.restart()
  expect(await assignmentSettings(page)).toEqual(settings)
  const persisted = storedAssignmentConfig(acceptanceApp.profile)
  expect(persisted.settings).toBeTruthy()
  expect({ ...persisted, settings: undefined }).toEqual({ ...original, settings: undefined })
})

for (const rejection of ['stale-revision', 'duplicate-name', 'missing-account', 'missing-group', 'removed-effort', 'builtin-delete', 'builtin-rename', 'task-empty'] as const) {
  test(`invalid assignment write is atomic: ${rejection}`, acceptance('models.subagent-profiles.conflict', { rejection }), async ({ window, acceptanceApp }) => {
    if (rejection !== 'task-empty') await bindSmall(window)
    const settings = await assignmentSettings(window)
    const small = settings.profiles.find(profile => profile.id === 'builtin:small')!
    const before = storedAssignmentConfig(acceptanceApp.profile)
    const update = { id: small.id, expectedRevision: small.revision, description: small.description, target: { kind: 'model', sourceId: 'acceptance-local', modelId: 'gpt-4o' } }
    const result = rejection === 'builtin-delete'
      ? await assignmentCall(window, 'deleteSubagentModel', { id: small.id, expectedRevision: small.revision })
      : rejection === 'task-empty'
        ? await assignmentCall(window, 'setSubagentModelSelectionMode', { selectionMode: 'task', expectedRevision: settings.revision })
        : rejection === 'duplicate-name'
          ? await assignmentCall(window, 'createSubagentModel', { name: 'Small', description: '', target: update.target })
          : await assignmentCall(window, 'updateSubagentModel', {
            ...update,
            ...(rejection === 'stale-revision' ? { expectedRevision: small.revision - 1 } : {}),
            ...(rejection === 'missing-account' ? { target: { kind: 'model', sourceId: 'missing-source', modelId: 'gpt-4o' } } : {}),
            ...(rejection === 'missing-group' ? { target: { kind: 'group', groupId: 'missing-group' } } : {}),
            ...(rejection === 'removed-effort' ? { reasoningEffort: 'high' } : {}),
            ...(rejection === 'builtin-rename' ? { name: 'Renamed builtin' } : {}),
          })
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
    expect(storedAssignmentConfig(acceptanceApp.profile)).toEqual(before)
    expect(await assignmentSettings(window)).toEqual(settings)
  })
}

test('stale full-config snapshots cannot erase or revive managed assignments', acceptance('models.subagent-profiles.stale-config'), async ({ window, acceptanceApp }) => {
  const stale = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getConfig())
  expect(stale.success).toBe(true)
  const configured = await bindSmall(window)
  const automatic = await assignmentCall(window, 'setSubagentModelSelectionMode', { selectionMode: 'task', expectedRevision: configured.revision })
  expect(automatic.success, automatic.error).toBe(true)
  const saved = await window.evaluate(config => (globalThis as unknown as { halo: HaloAPI }).halo.setConfig(config), stale.data as Record<string, unknown>)
  expect(saved.success).toBe(true)
  expect(await assignmentSettings(window)).toEqual(automatic.data)
  const staleConfigured = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getConfig())
  const slot = automatic.data!.profiles.find(profile => profile.id === 'builtin:small')!
  const cleared = await assignmentCall(window, 'clearBuiltinSubagentModel', { id: slot.id, expectedRevision: slot.revision })
  expect(cleared.success, cleared.error).toBe(true)
  const restored = await window.evaluate(config => (globalThis as unknown as { halo: HaloAPI }).halo.setConfig(config), staleConfigured.data as Record<string, unknown>)
  expect(restored.success).toBe(true)
  expect(await assignmentSettings(window)).toEqual(cleared.data)
  expect(storedAssignmentConfig(acceptanceApp.profile).settings?.selectionMode).toBe('inherit')
})
