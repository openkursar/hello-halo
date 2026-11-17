import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, acceptance } from '../fixtures/acceptance-app'
import { navigateToSettings } from '../fixtures/helpers'

test.use({ startupObserver: fileURLToPath(new URL('../fixtures/runtime-idle-observer.cjs', import.meta.url)) })

test('unused external runtimes do no discovery or child probing at startup and in settings', acceptance('models.engines.external-idle'), async ({ acceptanceApp, window, model }, info) => {
  const file = join(acceptanceApp.profile, '.halo', 'runtime-idle-observation.json')
  const read = () => JSON.parse(readFileSync(file, 'utf8'))
  const startup = read()
  expect(startup.pid).toBe(acceptanceApp.app.process().pid)
  expect(startup.truncated).toBe(false)
  expect(startup.operations).toEqual([])
  expect(startup.children).toEqual([])
  await navigateToSettings(window)
  await window.locator('#advanced').scrollIntoViewIfNeeded()
  for (const name of ['Claude Code', 'Codex']) {
    await window.getByRole('button', { name: `Set up ${name}`, exact: true }).click()
    const panel = window.getByRole('region', { name: `${name} setup`, exact: true })
    await expect(panel.getByRole('button', { name: 'Install recommended version', exact: true })).toBeEnabled()
    await expect(panel.getByText(`No ${name} installations added yet.`, { exact: true })).toBeVisible()
  }
  const settings = read()
  expect(settings.pid).toBe(acceptanceApp.app.process().pid)
  expect(settings.truncated).toBe(false)
  const allowedRoots = ['claude-code', 'codex'].map(name => join(acceptanceApp.profile, '.halo', 'runtimes', name))
  expect(settings.operations.filter((item: { operation: string; path: string }) => item.operation !== 'opendir' || !allowedRoots.includes(item.path))).toEqual([])
  expect(settings.operations.length).toBeLessThanOrEqual(2)
  expect(settings.children).toEqual([])
  expect(model.exchanges).toHaveLength(0)
  await info.attach('unused-runtime-observation', { body: JSON.stringify({ startup, settings }), contentType: 'application/json' })
})
