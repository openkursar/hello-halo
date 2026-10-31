import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/acceptance-remote-desktop'
import { listManagedSpaces, managementAcceptance, openWorkspaceMenu, seedManagedSpace } from '../fixtures/acceptance-management'
import { navigateToWorkspaces } from '../fixtures/helpers'

test.setTimeout(90000)

async function registryState(page: Page) {
  return (await listManagedSpaces(page)).map(space => ({ id: space.id, name: space.name, path: space.path, workingDir: space.workingDir ?? space.path, isMissing: space.isMissing ?? false })).sort((a, b) => a.id.localeCompare(b.id))
}

test('the authenticated remote client explains and disables local host folder selection without changing workspace data', managementAcceptance('remote.session.desktop-only'), async ({ managementApp, remoteDesktop }, info) => {
  const name = 'Remote folder boundary'
  const space = await seedManagedSpace(managementApp.window, name)
  const control = join(space.path, 'remote-folder-control.txt')
  const unrelated = join(managementApp.profile, 'unrelated-remote-control.txt')
  const content = `Keep this workspace file unchanged: ${randomUUID()}\n`
  const outside = `Keep this unrelated file unchanged: ${randomUUID()}\n`
  writeFileSync(control, content)
  writeFileSync(unrelated, outside)
  const before = await registryState(managementApp.window)
  await remoteDesktop.login()
  const page = remoteDesktop.page
  await navigateToWorkspaces(page)
  await expect(page.getByRole('heading', { name, exact: true, level: 3 })).toBeVisible()
  const requestStart = remoteDesktop.requests.length
  const observations: Array<Record<string, unknown>> = []
  let lastObservedRegistry = before
  const assertRegistryUnchanged = async () => {
    lastObservedRegistry = await registryState(managementApp.window)
    expect(lastObservedRegistry).toEqual(before)
  }
  try {
    await page.getByRole('button', { name: 'New Workspace', exact: true }).first().click()
    const createHeading = page.getByRole('heading', { name: 'Create Dedicated Workspace', exact: true })
    await expect(createHeading).toBeVisible()
    const create = createHeading.locator('..')
    const custom = create.getByRole('radio', { name: /Custom Folder/ })
    const defaultLocation = create.getByRole('radio', { name: /Default Location/ })
    await expect(custom).toBeDisabled()
    await expect(custom).not.toBeChecked()
    await expect(defaultLocation).toBeChecked()
    await expect(create.getByText('Please select folder in desktop app', { exact: true })).toBeVisible()
    await expect(create.getByRole('button', { name: 'Browse', exact: true })).toHaveCount(0)
    const label = create.getByText('Custom Folder', { exact: true })
    await expect(label).toBeVisible()
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    let previous: Awaited<ReturnType<typeof label.boundingBox>> = null
    let bounds: Awaited<ReturnType<typeof label.boundingBox>> = null
    await expect.poll(async () => {
      bounds = await label.boundingBox()
      if (!bounds) return false
      const stable = previous && Math.abs(bounds.x - previous.x) <= 0.5 && Math.abs(bounds.y - previous.y) <= 0.5
        && Math.abs(bounds.width - previous.width) <= 0.5 && Math.abs(bounds.height - previous.height) <= 0.5
      previous = bounds
      return !!stable && bounds.width > 0 && bounds.height > 0 && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height
    }, { intervals: [50], timeout: 5000 }).toBe(true)
    const click = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 }
    expect(await label.evaluate((element, point) => {
      const hit = document.elementFromPoint(point.x, point.y)
      return hit === element || !!hit && element.contains(hit)
    }, click)).toBe(true)
    await page.mouse.click(click.x, click.y)
    await expect(custom).toBeDisabled()
    await expect(custom).not.toBeChecked()
    await expect(defaultLocation).toBeChecked()
    observations.push({ surface: 'create-workspace', customFolderDisabled: true, defaultLocationRetained: true, desktopRequirementVisible: true, browseAbsent: true, labelBounds: bounds, click, viewport })
    await info.attach('remote-create-folder-limit', { body: await page.screenshot(), contentType: 'image/png' })
    await create.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(createHeading).toHaveCount(0)
    await assertRegistryUnchanged()

    await openWorkspaceMenu(page, name, 'Edit')
    const editHeading = page.getByRole('heading', { name: 'Edit Workspace', exact: true })
    await expect(editHeading).toBeVisible()
    const edit = editHeading.locator('..')
    await expect(edit.getByRole('button', { name: 'Change folder', exact: true })).toBeDisabled()
    await expect(edit.getByText('The folder can only be changed in the desktop app.', { exact: true })).toBeVisible()
    const workingDir = before.find(value => value.id === space.id)!.workingDir
    await expect(edit.getByTitle(workingDir, { exact: true })).toBeVisible()
    await expect(edit.getByText('Changed. Conversations keep their history; any reply in progress finishes first.', { exact: true })).toHaveCount(0)
    observations.push({ surface: 'edit-workspace', changeFolderDisabled: true, desktopRequirementVisible: true, changedNoticeAbsent: true })
    await info.attach('remote-change-folder-limit', { body: await page.screenshot(), contentType: 'image/png' })
    await edit.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(editHeading).toHaveCount(0)
    await assertRegistryUnchanged()
    expect(readFileSync(control, 'utf8')).toBe(content)
    expect(readFileSync(unrelated, 'utf8')).toBe(outside)
    const mutations = remoteDesktop.requests.slice(requestStart).filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
    expect(mutations, 'Disabled folder controls and cancellation must not issue workspace mutations').toEqual([])
  } finally {
    await info.attach('remote-desktop-only-observation', { body: JSON.stringify({ observations, registryBefore: before, lastObservedRegistry, workspaceRequests: remoteDesktop.requests.slice(requestStart), scope: 'Remote UI limitations; no native picker or host-folder open is claimed.' }, null, 2), contentType: 'application/json' })
  }
})
