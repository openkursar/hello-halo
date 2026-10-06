/**
 * The chat page over a digital human's conversation.
 *
 * A digital human's conversation is the same page as a space conversation, so
 * what the page promises has to hold for it too: opening a conversation does not
 * flash or rebuild the composer, a seen conversation reopens at once, a finished
 * reply settles where it streamed, the user can add to a running turn and
 * continue an interrupted one, and a canvas next to it gets the compact layout.
 *
 * No model runs: the transcript is seeded on disk, live turns are delivered as
 * the `agent:*` events the agent service would emit, and the two backend calls a
 * turn would make (inject, send) are answered by recording handlers.
 */

import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import fs from 'fs'
import path from 'path'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp,
} from '../fixtures/electron'
import { seedDigitalHumanChat, userLine, replyLine, type SeededDigitalHumanChat } from '../fixtures/seed-digital-human-chat'
import { navigateToChat } from '../fixtures/helpers'

const SCROLLER = '[data-testid="transcript-scroller"]'

async function sendAgentEvent(app: ElectronApplication, channel: string, data: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, { channel, data }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, data)
    }
  }, { channel, data })
}

async function settle(window: Page, ms = 250): Promise<void> {
  await window.waitForTimeout(ms)
  await window.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
}

/** Answers `channel` from the main process and records what it was called with. */
async function recordIpc(app: ElectronApplication, channel: string, result: unknown): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel, result }) => {
    const g = globalThis as unknown as { __recorded?: Record<string, unknown[]> }
    g.__recorded ??= {}
    g.__recorded[channel] = []
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, ...args) => {
      g.__recorded![channel].push(args[0])
      return result
    })
  }, { channel, result })
}

async function recorded(app: ElectronApplication, channel: string): Promise<unknown[]> {
  return app.evaluate((_electron, channel) => (globalThis as unknown as { __recorded?: Record<string, unknown[]> }).__recorded?.[channel] ?? [], channel)
}

interface Session {
  app: ElectronApplication
  window: Page
  seeded: SeededDigitalHumanChat
  turnEvent: { spaceId: string; conversationId: string }
  close: () => Promise<void>
}

async function launch(options: { width?: number; height?: number } = {}): Promise<Session> {
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const seeded = seedDigitalHumanChat(testConfigDir)
  // An artifact to open in the canvas.
  fs.writeFileSync(path.join(testConfigDir, '.halo', 'temp', 'artifacts', 'notes.md'), '# Notes\n\nSeeded.\n')
  const app = await launchElectronApp(appEntryPath, testConfigDir)
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await navigateToChat(window)
  if (options.width) {
    const cdp = await window.context().newCDPSession(window)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: options.width, height: options.height ?? 800, deviceScaleFactor: 1, mobile: false })
  }
  return {
    app,
    window,
    seeded,
    turnEvent: { spaceId: 'halo-temp', conversationId: seeded.conversationId },
    close: async () => {
      await app.close()
      cleanupTestConfigDir(testConfigDir)
    },
  }
}

/** Click the seeded conversation's row in the list (desktop layouts). */
async function openSeededConversation(session: Session): Promise<void> {
  await session.window.getByText(session.seeded.turns[2].reply.slice(0, 20)).first().click()
}

const MARK_COMPOSER = () => {
  const textarea = document.querySelector('textarea')
  if (!textarea) return false
  ;(textarea as unknown as { __e2eMark?: boolean }).__e2eMark = true
  return true
}

const COMPOSER_IS_MARKED = () => {
  const textarea = document.querySelector('textarea') as (HTMLTextAreaElement & { __e2eMark?: boolean }) | null
  return !!textarea?.__e2eMark
}

test.describe('digital-human conversation on the chat page', () => {
  test('opens without rebuilding the composer, and the draft typed while it loads survives', async () => {
    test.setTimeout(90000)
    const session = await launch({ width: 1280, height: 800 })
    try {
      const { window, seeded } = session
      await window.waitForSelector('textarea', { timeout: 20000 })
      await openSeededConversation(session)

      // The composer of the opened conversation appears with the selection;
      // from then on it must be the same element through loading and loaded.
      await expect.poll(async () => window.evaluate(() => {
        const textarea = document.querySelector('textarea')
        return textarea?.getAttribute('placeholder') ?? ''
      }), { timeout: 10000 }).toMatch(/E2E Chat Human/)
      await window.evaluate(MARK_COMPOSER)
      await window.locator('textarea').fill('a draft typed while it loads')

      await expect(window.locator(SCROLLER)).toBeVisible({ timeout: 15000 })
      await expect(window.getByText(seeded.turns[2].reply).first()).toBeVisible()
      await settle(window)

      expect(await window.evaluate(COMPOSER_IS_MARKED)).toBe(true)
      await expect(window.locator('textarea')).toHaveValue('a draft typed while it loads')
    } finally {
      await session.close()
    }
  })

  test('reopens a conversation it has already read without a loading state', async () => {
    test.setTimeout(90000)
    const session = await launch({ width: 1280, height: 800 })
    try {
      const { window, seeded } = session
      await window.waitForSelector('textarea', { timeout: 20000 })
      await openSeededConversation(session)
      await expect(window.getByText(seeded.turns[2].reply).first()).toBeVisible({ timeout: 15000 })

      // Go to a regular conversation and come back, watching for the loading state.
      await window.evaluate(() => {
        const w = window as unknown as { __loadingSeen?: number }
        w.__loadingSeen = 0
        new MutationObserver(() => {
          if (/Loading conversation|加载会话|正在加载/.test(document.body.innerText)) w.__loadingSeen = (w.__loadingSeen ?? 0) + 1
        }).observe(document.body, { childList: true, subtree: true, characterData: true })
      })
      await window.keyboard.press('Escape')
      await window.getByRole('button', { name: /^(New|New conversation|新对话|新会话)$/ }).first().click()
      await settle(window, 400)
      await openSeededConversation(session)
      await expect(window.getByText(seeded.turns[2].reply).first()).toBeVisible({ timeout: 5000 })
      await settle(window, 400)

      expect(await window.evaluate(() => (window as unknown as { __loadingSeen?: number }).__loadingSeen)).toBe(0)
    } finally {
      await session.close()
    }
  })

  test('a finished reply settles in place: no frame without it, the messages already shown are not rebuilt', async () => {
    test.setTimeout(90000)
    const session = await launch({ width: 1280, height: 800 })
    try {
      const { window, app, seeded, turnEvent } = session
      await window.waitForSelector('textarea', { timeout: 20000 })
      await openSeededConversation(session)
      await expect(window.getByText(seeded.turns[2].reply).first()).toBeVisible({ timeout: 15000 })

      // Mark the message elements on screen; a rebuild would drop the mark.
      await window.evaluate(() => {
        document.querySelectorAll('[data-message-id]').forEach(el => { (el as HTMLElement & { __e2eMark?: boolean }).__e2eMark = true })
      })
      const shownBefore = await window.locator('[data-message-id]').count()

      const STREAMED = 'Streaming reply that will be finalized in place.'
      const FINAL = 'The persisted final reply.'
      await sendAgentEvent(app, 'agent:turn-start', turnEvent)
      await sendAgentEvent(app, 'agent:message', { ...turnEvent, content: STREAMED, isStreaming: true, isComplete: false })
      await expect(window.getByText(STREAMED)).toBeVisible()

      // From here on, sample every frame: either the stream or the final reply must be on screen.
      await window.evaluate(([streamed, final]) => {
        const w = window as unknown as { __gaps?: number; __stopSampling?: boolean }
        w.__gaps = 0
        const sample = () => {
          // textContent, not innerText: a row that just mounted is skipped by
          // content-visibility until this frame's layout, and innerText leaves out
          // what is skipped — the DOM is what the swap has to keep continuous.
          const text = document.body.textContent ?? ''
          if (!text.includes(streamed) && !text.includes(final)) w.__gaps = (w.__gaps ?? 0) + 1
          if (!w.__stopSampling) requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }, [STREAMED, FINAL])

      // The turn is persisted, then the service announces it.
      fs.appendFileSync(seeded.transcriptPath, [
        userLine('A question asked from elsewhere', '2026-09-01T11:00:00.000Z'),
        replyLine(FINAL, '2026-09-01T11:00:10.000Z'),
      ].join('\n') + '\n')
      await sendAgentEvent(app, 'agent:complete', { ...turnEvent, type: 'complete' })
      await expect(window.getByText(FINAL)).toBeVisible({ timeout: 10000 })
      await settle(window, 400)
      await window.evaluate(() => { (window as unknown as { __stopSampling?: boolean }).__stopSampling = true })

      expect(await window.evaluate(() => (window as unknown as { __gaps?: number }).__gaps)).toBe(0)
      await expect(window.getByText(STREAMED)).toHaveCount(0)
      // Earlier messages are the very same elements.
      expect(await window.evaluate(() => document.querySelectorAll('[data-message-id]').length)).toBeGreaterThanOrEqual(shownBefore)
      expect(await window.evaluate(() => Array.from(document.querySelectorAll('[data-message-id]')).filter(el => (el as HTMLElement & { __e2eMark?: boolean }).__e2eMark).length)).toBe(shownBefore)
    } finally {
      await session.close()
    }
  })

  test('adds to the running turn, and continues an interrupted one', async () => {
    test.setTimeout(90000)
    const session = await launch({ width: 1280, height: 800 })
    try {
      const { window, app, seeded, turnEvent } = session
      await recordIpc(app, 'app:chat-inject', { success: true, data: { delivered: true } })
      await recordIpc(app, 'app:chat-send', { success: true, data: { conversationId: seeded.conversationId } })

      await window.waitForSelector('textarea', { timeout: 20000 })
      await openSeededConversation(session)
      await expect(window.getByText(seeded.turns[2].reply).first()).toBeVisible({ timeout: 15000 })

      // A turn is running: typing and sending adds to it instead of starting another.
      await sendAgentEvent(app, 'agent:turn-start', turnEvent)
      await sendAgentEvent(app, 'agent:message', { ...turnEvent, content: 'Working on it…', isStreaming: true, isComplete: false })
      await expect(window.getByText('Working on it…')).toBeVisible()
      await window.locator('textarea').fill('and please also do this')
      await window.locator('textarea').press('Enter')

      await expect.poll(async () => (await recorded(app, 'app:chat-inject')).length, { timeout: 5000 }).toBe(1)
      expect(await recorded(app, 'app:chat-inject')).toEqual([
        { appId: seeded.appId, conversationId: seeded.conversationId, message: 'and please also do this' },
      ])
      expect(await recorded(app, 'app:chat-send')).toHaveLength(0)
      await expect(window.getByText('and please also do this')).toBeVisible()

      // The turn is interrupted: the page offers to continue it.
      await sendAgentEvent(app, 'agent:error', { ...turnEvent, error: 'The connection dropped', errorType: 'interrupted' })
      const continueButton = window.getByRole('button', { name: /^(Continue|继续)$/ })
      await expect(continueButton).toBeVisible({ timeout: 5000 })
      await continueButton.click()

      await expect.poll(async () => (await recorded(app, 'app:chat-send')).length, { timeout: 5000 }).toBe(1)
      expect(await recorded(app, 'app:chat-send')).toMatchObject([
        { appId: seeded.appId, conversationId: seeded.conversationId, message: 'continue' },
      ])
    } finally {
      await session.close()
    }
  })

  test('shows the terminal button of a live terminal call, and takes the compact layout beside a canvas', async () => {
    test.setTimeout(90000)
    const session = await launch({ width: 1440, height: 900 })
    try {
      const { window, app, seeded, turnEvent } = session
      await window.waitForSelector('textarea', { timeout: 20000 })
      await openSeededConversation(session)
      await expect(window.getByText(seeded.turns[2].reply).first()).toBeVisible({ timeout: 15000 })

      const fullWidth = await window.locator(SCROLLER).evaluate(el => el.getBoundingClientRect().width)

      // A terminal call in the live turn offers to open the terminal, as in a space conversation.
      await sendAgentEvent(app, 'agent:turn-start', turnEvent)
      await sendAgentEvent(app, 'agent:thought', {
        ...turnEvent,
        thought: {
          id: 'thought-terminal-1',
          type: 'tool_use',
          content: '',
          timestamp: new Date().toISOString(),
          toolName: 'mcp__ai-terminal__terminal_write',
          toolInput: { input: 'ls' },
        },
      })
      await expect(window.getByRole('button', { name: /Open terminal|打开终端/ })).toBeVisible({ timeout: 5000 })
      await sendAgentEvent(app, 'agent:complete', { ...turnEvent, type: 'complete' })

      // A canvas next to the chat narrows it: the same compact layout as any conversation.
      await window.getByTitle(/Open workspace resources|展开工作区资源/).click()
      await window.getByText('notes.md').first().click()
      await expect.poll(async () => window.locator(SCROLLER).evaluate(el => el.getBoundingClientRect().width), { timeout: 10000 })
        .toBeLessThan(fullWidth - 100)
      await expect(window.locator('textarea')).toBeVisible()
    } finally {
      await session.close()
    }
  })

  test('keeps a completion unread on settings and reads it when the existing chat returns', async () => {
    test.setTimeout(90000)
    const session = await launch({ width: 1280, height: 800 })
    try {
      const { window, app, seeded, turnEvent } = session
      await window.waitForSelector('textarea', { timeout: 20000 })
      await openSeededConversation(session)
      await expect(window.getByText(seeded.turns[2].reply).first()).toBeVisible({ timeout: 15000 })
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
      await expect.poll(() => window.evaluate(() => document.hasFocus())).toBe(true)
      const state = () => window.evaluate(async id => {
        const response = await (globalThis.window as unknown as { halo: HaloAPI }).halo.taskListState()
        if (!response.success) throw new Error(response.error)
        return (response.data as Array<{ conversationId: string; state: string }>).find(row => row.conversationId === id)?.state ?? null
      }, seeded.conversationId)

      await window.getByRole('button', { name: 'Settings', exact: true }).first().click()
      await expect(window.locator('textarea')).toHaveCount(0)
      await sendAgentEvent(app, 'agent:complete', { ...turnEvent, type: 'complete' })
      await expect.poll(state).toBe('unseen')
      await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')))
      await settle(window)
      expect(await state()).toBe('unseen')

      await window.getByRole('button', { name: 'Conversation', exact: true }).first().click()
      await expect(window.getByText(seeded.turns[2].reply).first()).toBeVisible()
      await expect.poll(state).toBe('read')
      await window.evaluate(() => {
        globalThis.dispatchEvent(new Event('focus'))
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await settle(window)
      expect(await state()).toBe('read')
    } finally {
      await session.close()
    }
  })

  test('keeps a completion unread behind the full-screen canvas and reads it on reveal', async () => {
    test.setTimeout(90000)
    const session = await launch({ width: 1280, height: 800 })
    try {
      const { window, app, seeded, turnEvent } = session
      await window.waitForSelector('textarea', { timeout: 20000 })
      await openSeededConversation(session)
      await expect(window.getByText(seeded.turns[2].reply).first()).toBeVisible({ timeout: 15000 })
      await window.getByTitle(/Open workspace resources|展开工作区资源/).click()
      await window.getByText('notes.md').first().click()
      await window.getByTitle(/Enter fullscreen|进入全屏/).click()
      await expect(window.locator('textarea')).toHaveCount(0)
      await sendAgentEvent(app, 'agent:complete', { ...turnEvent, type: 'complete' })
      const state = () => window.evaluate(async id => {
        const response = await (globalThis.window as unknown as { halo: HaloAPI }).halo.taskListState()
        if (!response.success) throw new Error(response.error)
        return (response.data as Array<{ conversationId: string; state: string }>).find(row => row.conversationId === id)?.state ?? null
      }, seeded.conversationId)
      await expect.poll(state).toBe('unseen')

      await window.getByTitle(/Exit fullscreen|退出全屏/).click()
      await expect(window.locator('textarea')).toBeVisible()
      await expect.poll(state).toBe('read')
    } finally {
      await session.close()
    }
  })

  test('is usable at phone width: its conversations are in the history sheet, and @ starts a new one', async () => {
    test.setTimeout(90000)
    const session = await launch({ width: 390, height: 844 })
    try {
      const { window, seeded } = session
      const composer = window.locator('textarea')
      await composer.waitFor({ timeout: 20000 })

      // The history sheet lists the digital human's conversation beside the space's own.
      await window.getByTitle('Conversation history', { exact: true }).click()
      const row = window.getByText(seeded.turns[2].reply.slice(0, 20)).first()
      await expect(row).toBeVisible({ timeout: 10000 })
      await expect(window.getByText(seeded.name).first()).toBeVisible()
      await row.click()

      // It opens on the same chat page, showing the transcript, with its own composer.
      await expect(window.getByText(seeded.turns[2].reply).first()).toBeVisible({ timeout: 15000 })
      await expect(composer).toHaveAttribute('placeholder', new RegExp(seeded.name))
      expect(await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)

      // "@" in the composer starts a new conversation with a digital human.
      await composer.fill('@')
      await window.getByText(seeded.name).first().click()
      await expect(composer).toHaveAttribute('placeholder', new RegExp(seeded.name), { timeout: 10000 })
      await composer.fill('hello from a phone')
      await expect(composer).toHaveValue('hello from a phone')
      const box = await composer.boundingBox()
      expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
      expect(await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    } finally {
      await session.close()
    }
  })
})
