/**
 * A temporary space collaboration, seeded exactly as the product produces one:
 * a conversation in the temp space, an ephemeral team bound to it, and the one
 * room the collaboration works in (see team-collab-seed-worker.ts).
 *
 * The workbench is then reached through the UI — the conversation's
 * collaboration card, which opens the team view in the Canvas — rather than by
 * driving the store, so the spec covers the path a person actually takes.
 */

import { test as base, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { buildSync } from 'esbuild'
import { getAppEntryPath, createTestConfigDir, cleanupTestConfigDir, launchElectronApp } from './electron'
import type { SeededCollaboration } from './team-collab-seed-worker'

const folder = dirname(fileURLToPath(import.meta.url))
const electronPath: string = createRequire(import.meta.url)('electron')

export const COLLAB_TEAM_NAME = 'Pricing crew'
export const COLLAB_MEMBER_NAME = 'Pricer'
export const COLLAB_CONVERSATION_TITLE = 'Pricing brief'
/** The member's own digital human, installed by the seed worker. */
export const COLLAB_MEMBER_APP_ID = 'collab-member'

interface Launched {
  seeded: SeededCollaboration
  app: ElectronApplication
}

interface Fixtures {
  /** One fixture owns the profile: seeded before the app opens it, closed once. */
  launched: Launched
  collaboration: SeededCollaboration
  electronApp: ElectronApplication
  window: Page
}

function seedCollaboration(directory: string): SeededCollaboration {
  const output = join(folder, '.e2e-seed-tmp', 'team-collab-worker.cjs')
  mkdirSync(dirname(output), { recursive: true })
  buildSync({
    entryPoints: [join(folder, 'team-collab-seed-worker.ts')],
    outfile: output, platform: 'node', format: 'cjs', bundle: true,
    external: ['better-sqlite3', 'electron'], logLevel: 'silent',
  })
  const payload = JSON.stringify({
    directory,
    teamName: COLLAB_TEAM_NAME,
    memberName: COLLAB_MEMBER_NAME,
    conversationTitle: COLLAB_CONVERSATION_TITLE,
  })
  const printed = execFileSync(electronPath, [output, payload], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HALO_DATA_DIR: join(directory, '.halo') },
    encoding: 'utf-8',
  })
  // Last line only: conversation.service.ts logs around the payload.
  return JSON.parse(printed.trim().split('\n').pop() ?? '') as SeededCollaboration
}

export const test = base.extend<Fixtures>({
  launched: async ({}, use) => {
    const entry = getAppEntryPath()
    const directory = createTestConfigDir(entry)
    const seeded = seedCollaboration(directory)
    console.log(`[E2E] Seeded collaboration ${seeded.teamId} in conversation ${seeded.conversationId}`)
    const app = await launchElectronApp(entry, directory)
    try {
      await use({ seeded, app })
    } finally {
      await app.close()
      cleanupTestConfigDir(directory)
    }
  },
  collaboration: async ({ launched }, use) => { await use(launched.seeded) },
  electronApp: async ({ launched }, use) => { await use(launched.app) },
  window: async ({ electronApp, collaboration }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(({ teamId, memberAppId }) => {
      localStorage.setItem('halo-locale', 'en')
      const preferences = JSON.parse(localStorage.getItem('halo-team-view-prefs') || '{"state":{}}')
      preferences.state = {
        ...preferences.state,
        // The remembered choice a user would have made: talk to the member, not
        // to the coordinator the team is addressed through.
        defaultMemberByTeam: { ...preferences.state?.defaultMemberByTeam, [teamId]: memberAppId },
        memberByTask: { ...preferences.state?.memberByTask, [teamId]: {} },
        taskByTeam: { ...preferences.state?.taskByTeam, [teamId]: null },
      }
      localStorage.setItem('halo-team-view-prefs', JSON.stringify(preferences))
    }, { teamId: collaboration.teamId, memberAppId: collaboration.memberAppId })
    await page.reload()
    await use(page)
  },
})

export { expect } from '@playwright/test'
