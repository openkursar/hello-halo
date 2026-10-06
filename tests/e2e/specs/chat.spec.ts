/**
 * Chat Flow E2E Tests
 *
 * Real end-to-end tests for chat functionality.
 * These tests actually send messages to the API and verify responses.
 *
 * Required Environment Variables:
 *   HALO_TEST_API_KEY - API key for testing
 *   HALO_TEST_API_URL - API URL (optional)
 *   HALO_TEST_MODEL   - Model to use (optional)
 */

import { test, expect, hasApiKey } from '../fixtures/electron'
import { navigateToChat } from '../fixtures/helpers'
import type { HaloAPI } from '../../../src/preload'
import type { TranscriptMessage } from '../../../src/shared/types/transcript'
import { performance } from 'node:perf_hooks'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

interface ChatTurnProbe {
  conversationId: string | null
  spaceId: string | null
  completed: boolean
  errorCount: number
  dispose: () => void
}

interface ChatAcceptanceWindow {
  halo: HaloAPI
  chatTurnProbe?: ChatTurnProbe
}

// Cases that talk to the configured provider are skipped without an API key.
function requireApiKey() {
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(!hasApiKey(), 'Skipping chat tests: HALO_TEST_API_KEY not set')
  })
}

test.describe('Chat Interface', () => {
  requireApiKey()

  test('chat input is visible and functional', async ({ window }) => {
    // Navigate to chat interface
    await navigateToChat(window)

    // Find chat input
    const chatInput = await window.waitForSelector('textarea', { timeout: 5000 })

    expect(chatInput).toBeTruthy()

    // Input should be enabled
    const isEnabled = await chatInput.isEnabled()
    expect(isEnabled).toBe(true)

    // Should be able to type
    await chatInput.fill('Hello, Halo!')
    const value = await chatInput.inputValue()
    expect(value).toBe('Hello, Halo!')
  })

  test('send button exists and is functional', async ({ window }) => {
    await navigateToChat(window)

    // Find send button (has data-onboarding="send-button")
    const sendButton = await window.waitForSelector(
      '[data-onboarding="send-button"]',
      { timeout: 5000 }
    )

    expect(sendButton).toBeTruthy()
  })
})

test.describe('Real Chat Flow', () => {
  requireApiKey()
  // Increase timeout for real API calls
  test.setTimeout(60000)

  test('can send message and receive response', async ({ window, electronApp }, testInfo) => {
    // Navigate to chat interface
    await navigateToChat(window)

    const availability = await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
    expect(availability.success).toBe(true)
    const runtime = await electronApp.evaluate(({ app }) => ({ packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node, platform: process.platform, architecture: process.arch }))
    if (process.env.HALO_E2E_PACKAGED_APP) expect(runtime.packaged).toBe(true)
    const engine = availability.data as { activeEngine: string; engines: Array<{ engineId: string; available: boolean; version: string; fingerprint: string }> }
    if (process.env.HALO_TEST_SDK_ENGINE) expect(engine.activeEngine).toBe(process.env.HALO_TEST_SDK_ENGINE)
    expect(engine.engines.find(candidate => candidate.engineId === engine.activeEngine)).toMatchObject({ available: true })
    await testInfo.attach('active-engine', { body: JSON.stringify({ ...engine, runtime }, null, 2), contentType: 'application/json' })

    await window.evaluate(() => {
      const state = globalThis as unknown as ChatAcceptanceWindow
      if (state.chatTurnProbe) throw new Error('A chat turn probe is already attached')
      const probe: ChatTurnProbe = { conversationId: null, spaceId: null, completed: false, errorCount: 0, dispose: () => {} }
      const stopStart = state.halo.onAgentTurnStart(value => {
        const event = value as { conversationId?: string; spaceId?: string }
        if (typeof event.conversationId !== 'string' || typeof event.spaceId !== 'string') { probe.errorCount++; return }
        if (probe.conversationId && probe.conversationId !== event.conversationId) { probe.errorCount++; return }
        probe.conversationId = event.conversationId
        probe.spaceId = event.spaceId
      })
      const stopComplete = state.halo.onAgentComplete(value => {
        const event = value as { conversationId?: string }
        if (event.conversationId === probe.conversationId) probe.completed = true
      })
      const stopError = state.halo.onAgentError(value => {
        const event = value as { conversationId?: string }
        if (!probe.conversationId || event.conversationId === probe.conversationId) probe.errorCount++
      })
      probe.dispose = () => { stopStart(); stopComplete(); stopError(); delete state.chatTurnProbe }
      state.chatTurnProbe = probe
    })

    try {

    // Find chat input
    const chatInput = await window.waitForSelector('textarea', { timeout: 5000 })

    // Type a simple test message
    const testMessage = 'Say "Hello Test" and nothing else.'
    await chatInput.fill(testMessage)

    // Take screenshot before clicking send
    await window.screenshot({ path: 'tests/e2e/results/chat-before-send.png' })

    // Find and click send button
    const sendButton = await window.waitForSelector(
      '[data-onboarding="send-button"]',
      { timeout: 5000 }
    )

    // Use force click to bypass any potential overlay
    await sendButton.click({ force: true })

    // Take screenshot right after clicking
    await window.waitForTimeout(1000)
    await window.screenshot({ path: 'tests/e2e/results/chat-after-send.png' })

    // Wait for user message to appear in the chat (message-user class)
    await window.waitForSelector(
      '.message-user',
      { timeout: 10000 }
    )

    // Wait for AI message bubble to appear (message-assistant class)
    await window.waitForSelector(
      '.message-assistant',
      { timeout: 30000 }
    )

    await expect.poll(() => window.evaluate(async () => {
      const state = globalThis as unknown as ChatAcceptanceWindow
      const probe = state.chatTurnProbe!
      if (!probe.conversationId) return { started: false, completed: false, active: null, errors: probe.errorCount }
      const response = await state.halo.getSessionState(probe.conversationId)
      if (!response.success) throw new Error('Could not read the actual chat session state')
      const session = response.data as { isActive: boolean }
      return { started: true, completed: probe.completed, active: session.isActive, errors: probe.errorCount }
    }), { timeout: 45000, message: 'The submitted conversation must emit completion and leave its real active turn' }).toEqual({ started: true, completed: true, active: false, errors: 0 })
    await expect(window.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
    await expect(window.locator('.streaming-cursor')).toHaveCount(0)
    await expect(window.getByText('Halo is working', { exact: true })).toHaveCount(0)

    const completed = await window.evaluate(async () => {
      const state = globalThis as unknown as ChatAcceptanceWindow
      const probe = state.chatTurnProbe!
      if (!probe.conversationId || !probe.spaceId) throw new Error('The completed turn has no actual conversation identity')
      const response = await state.halo.getConversation(probe.spaceId, probe.conversationId)
      if (!response.success) throw new Error('Could not read the completed conversation transcript')
      const conversation = response.data as { id: string; messages: TranscriptMessage[] }
      return { conversationId: probe.conversationId, spaceId: probe.spaceId, storedId: conversation.id, messages: conversation.messages.filter(message => message.role === 'user' || message.role === 'assistant').map(message => ({ id: message.id, role: message.role, content: message.content })) }
    })
    expect(completed.storedId).toBe(completed.conversationId)
    expect(completed.messages.filter(message => message.role === 'user').at(-1)?.content).toBe(testMessage)
    expect(completed.messages.at(-1)).toMatchObject({ role: 'assistant', content: expect.stringMatching(/hello/i) })
    await testInfo.attach('completed-transcript', { body: JSON.stringify(completed, null, 2), contentType: 'application/json' })

    // Take screenshot after AI completes
    await window.screenshot({ path: 'tests/e2e/results/chat-response.png' })

    // Verify AI response contains expected content
    // The AI should respond with "Hello Test" when asked to say it
    const assistantMessage = await window.waitForSelector('.message-assistant', { timeout: 5000 })
    const responseText = await assistantMessage.textContent()

    // AI response should contain "Hello" (the content we asked it to say)
    expect(responseText?.toLowerCase()).toContain('hello')
    await window.evaluate(() => (globalThis as unknown as ChatAcceptanceWindow).chatTurnProbe!.dispose())

    const finalAvailability = await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
    expect(finalAvailability).toMatchObject({ success: true, data: { activeEngine: engine.activeEngine } })
    const finalSession = await window.evaluate(conversationId => (window as unknown as { halo: HaloAPI }).halo.getSessionState(conversationId), completed.conversationId)
    expect(finalSession).toMatchObject({ success: true, data: { isActive: false } })
    const beforeClose = await electronApp.evaluate(({ app }) => ({ packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node, pid: process.pid, metrics: app.getAppMetrics().map(metric => ({ pid: metric.pid, creationTime: metric.creationTime, type: metric.type })) }))
    const child = electronApp.process()
    expect(beforeClose.pid).toBe(child.pid)
    const started = performance.now()
    const events: Array<Record<string, unknown>> = []
    const pipes = () => ({ stdout: { ended: child.stdout?.readableEnded ?? null, destroyed: child.stdout?.destroyed ?? null, closed: child.stdout?.closed ?? null }, stderr: { ended: child.stderr?.readableEnded ?? null, destroyed: child.stderr?.destroyed ?? null, closed: child.stderr?.closed ?? null } })
    const processState = () => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, pipes: pipes() })
    const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => events.push({ ...processState(), event: 'process exit', elapsedMs: performance.now() - started, exitCode, signal })
    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => events.push({ ...processState(), event: 'process close', elapsedMs: performance.now() - started, exitCode, signal })
    child.on('exit', onExit)
    child.on('close', onClose)
    let deadline: ReturnType<typeof setTimeout> | undefined
    const snapshots = [1000, 5000].map(delay => setTimeout(() => events.push({ event: 'close pending', elapsedMs: performance.now() - started, ...processState() }), delay))
    await testInfo.attach('before-application-close', { body: JSON.stringify({ ...beforeClose, activeEngine: (finalAvailability.data as { activeEngine: string }).activeEngine, conversationId: completed.conversationId, session: finalSession.data, completionObserved: true, ...processState() }, null, 2), contentType: 'application/json' })
    let closeSucceeded = false
    try {
      await Promise.race([electronApp.close(), new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('The completed chat application did not close within 10 seconds')), 10000)
      })])
      closeSucceeded = true
      expect(child.exitCode).toBe(0)
      expect(child.signalCode).toBeNull()
    } finally {
      clearTimeout(deadline)
      snapshots.forEach(clearTimeout)
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      await testInfo.attach('application-close-events', { body: JSON.stringify({ closeSucceeded, elapsedMs: performance.now() - started, final: processState(), events }, null, 2), contentType: 'application/json' })
    }
    } finally {
      if (!window.isClosed()) await window.evaluate(() => (globalThis as unknown as ChatAcceptanceWindow).chatTurnProbe?.dispose())
    }
  })

  test('displays thinking indicator during response', async ({ window }) => {
    await navigateToChat(window)

    const chatInput = await window.waitForSelector('textarea', { timeout: 5000 })
    await chatInput.fill('Count from 1 to 5 slowly.')

    const sendButton = await window.waitForSelector('[data-onboarding="send-button"]', { timeout: 5000 })
    await sendButton.click()

    await expect(window.getByText('Halo is working', { exact: true })).toBeVisible({ timeout: 10000 })

    // Wait for AI message to appear
    await window.waitForSelector('.message-assistant', { timeout: 30000 })

    // Wait for AI to finish working
    await expect(window.getByText('Halo is working', { exact: true })).toHaveCount(0, { timeout: 45000 })
    await expect(window.locator('.streaming-cursor')).toHaveCount(0)

    // Verify AI response contains numbers (1-5)
    const assistantMessage = await window.waitForSelector('.message-assistant', { timeout: 5000 })
    const responseText = await assistantMessage.textContent()
    expect(responseText).toMatch(/[1-5]/)
  })

  test('input clears after sending message', async ({ window }) => {
    await navigateToChat(window)

    const chatInput = window.locator('textarea')
    await expect(chatInput).toBeVisible()
    await chatInput.fill('Test message for clearing')

    const sendButton = await window.waitForSelector(
      '[data-onboarding="send-button"]',
      { timeout: 5000 }
    )
    await sendButton.click()

    await expect(window.locator('.message-user')).toContainText('Test message for clearing')
    await expect(chatInput).toHaveValue('')
    await expect(window.locator('.message-assistant')).toBeVisible({ timeout: 30000 })
    await expect(window.getByText('Halo is working', { exact: true })).toHaveCount(0, { timeout: 45000 })
    await expect(window.locator('.streaming-cursor')).toHaveCount(0)
  })

  test('can send multiple messages in sequence', async ({ window }) => {
    await navigateToChat(window)

    const chatInput = window.locator('textarea')
    const sendButton = window.locator('[data-onboarding="send-button"]')
    await expect(chatInput).toBeVisible()

    // Send first message
    await chatInput.fill('Say "First" and nothing else.')
    await sendButton.click()

    // Wait for first AI response
    await window.waitForSelector('.message-assistant', { timeout: 30000 })
    await expect(window.getByText('Halo is working', { exact: true })).toHaveCount(0, { timeout: 45000 })
    await expect(window.locator('.streaming-cursor')).toHaveCount(0)

    // Verify first response
    let assistantMessages = await window.$$('.message-assistant')
    let firstResponse = await assistantMessages[0].textContent()
    expect(firstResponse?.toLowerCase()).toContain('first')

    // Send second message
    await chatInput.fill('Say "Second" and nothing else.')
    await sendButton.click()

    // Wait for second AI response (should now have 2 assistant messages)
    await window.waitForFunction(() => document.querySelectorAll('.message-assistant').length >= 2, { timeout: 30000 })
    await expect(window.getByText('Halo is working', { exact: true })).toHaveCount(0, { timeout: 45000 })
    await expect(window.locator('.streaming-cursor')).toHaveCount(0)

    // Verify second response
    assistantMessages = await window.$$('.message-assistant')
    expect(assistantMessages.length).toBeGreaterThanOrEqual(2)
    const secondResponse = await assistantMessages[1].textContent()
    expect(secondResponse?.toLowerCase()).toContain('second')

    await window.screenshot({ path: 'tests/e2e/results/chat-multiple-messages.png' })
  })
})

test.describe('Switch Provider and Chat', () => {
  requireApiKey()
  test.setTimeout(90000)

  test('switch configured API source, select GLM-5.0, and chat', async ({ window }) => {
    const originalModel = await window.evaluate(async apiKey => {
      const halo = (window as unknown as { halo: HaloAPI }).halo
      const response = await halo.getConfig()
      if (!response.success) throw new Error('Could not read configured chat sources')
      const config = response.data as { aiSources: { currentId: string; sources: Array<Record<string, unknown>> } }
      const original = config.aiSources.sources.find(source => source.id === config.aiSources.currentId)
      if (!original || original.authType !== 'api-key' || typeof original.apiUrl !== 'string') throw new Error('Source switching requires the configured API-key fixture')
      const alternate = { ...original, id: 'e2e-tencent-source', name: 'tencent', apiKey,
        model: 'GLM-5.0', availableModels: [{ id: 'GLM-5.0', name: 'GLM-5.0' }] }
      const saved = await halo.setConfig({ aiSources: { ...config.aiSources, sources: [...config.aiSources.sources, alternate] } })
      if (!saved.success) throw new Error('Could not configure the alternate chat source')
      return { model: String(original.model), source: String(original.name) }
    }, process.env.HALO_TEST_API_KEY!)
    await window.reload()
    await navigateToChat(window)

    await window.getByRole('button', { name: originalModel.model, exact: true }).click()
    await window.getByRole('button', { name: `${originalModel.model} ${originalModel.source}`, exact: true }).click()

    // Wait for dropdown to appear
    await window.waitForTimeout(500)

    // Click on the "tencent" source section to expand it
    const tencentSection = await window.waitForSelector(
      'text="tencent"',
      { timeout: 5000 }
    )
    await tencentSection.click()

    // Wait for model list to expand
    await window.waitForTimeout(300)

    // Click on GLM-5.0 model
    const glmModel = await window.waitForSelector(
      'button:has-text("GLM-5.0")',
      { timeout: 5000 }
    )
    await glmModel.click()
    await expect(window.getByRole('button', { name: 'GLM-5.0', exact: true })).toBeVisible()
    await expect.poll(() => window.evaluate(async () => {
      const response = await (window as unknown as { halo: HaloAPI }).halo.getConfig()
      if (!response.success) throw new Error('Could not read the switched chat source')
      return (response.data as { aiSources: { currentId: string } }).aiSources.currentId
    })).toBe('e2e-tencent-source')

    // Wait for dropdown to close and model to switch
    await window.waitForTimeout(500)

    // Take screenshot after switching
    await window.screenshot({ path: 'tests/e2e/results/chat-switch-tencent-glm.png' })

    // Now send a chat message to verify the new provider works
    const chatInput = await window.waitForSelector('textarea', { timeout: 5000 })
    await chatInput.fill('你好，你是哪个模型，具体哪个型号？')

    const sendButton = await window.waitForSelector(
      '[data-onboarding="send-button"]',
      { timeout: 5000 }
    )
    await sendButton.click({ force: true })

    // Wait for user message
    await window.waitForSelector('.message-user', { timeout: 10000 })

    // Wait for AI response
    await window.waitForSelector('.message-assistant', { timeout: 45000 })

    // Wait for AI to finish
    await expect(window.getByText('Halo is working', { exact: true })).toHaveCount(0, { timeout: 60000 })
    await expect(window.locator('.streaming-cursor')).toHaveCount(0)

    await window.screenshot({ path: 'tests/e2e/results/chat-tencent-glm-response.png' })

    // Verify response exists
    const assistantMessage = await window.waitForSelector('.message-assistant', { timeout: 5000 })
    const responseText = await assistantMessage.textContent()
    expect(responseText).toBeTruthy()
    expect(responseText!.length).toBeGreaterThan(0)
  })
})

test.describe('Chat Error Handling', () => {
  requireApiKey()

  test('handles empty message gracefully', async ({ window }) => {
    await navigateToChat(window)

    const chatInput = await window.waitForSelector('textarea', { timeout: 5000 })
    const sendButton = await window.waitForSelector(
      '[data-onboarding="send-button"]',
      { timeout: 5000 }
    )

    // Clear input and try to send
    await chatInput.fill('')

    // Send button should be disabled when input is empty
    const isDisabled = await sendButton.isDisabled()
    expect(isDisabled).toBe(true)
  })
})

function readOwnedProcesses(mainPid: number, knownPids: Set<number>) {
  let rows: Array<{ pid: number; ppid: number; state: string; command: string }>
  if (process.platform === 'win32') {
    const value = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8' }))
    rows = (Array.isArray(value) ? value : [value]).map(item => ({ pid: item.ProcessId, ppid: item.ParentProcessId, state: 'live', command: item.Name }))
  } else {
    rows = execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
      if (!match) throw new Error('The process table contains an invalid ownership row')
      return { pid: Number(match[1]), ppid: Number(match[2]), state: match[3], command: match[4] }
    })
  }
  knownPids.add(mainPid)
  let previousSize: number
  do {
    previousSize = knownPids.size
    for (const row of rows) if (knownPids.has(row.ppid)) knownPids.add(row.pid)
  } while (knownPids.size !== previousSize)
  return rows.filter(row => knownPids.has(row.pid))
}

test.describe('Active response shutdown', () => {
  test.use({ appStoreRegistries: [{ id: 'claude-skills', name: 'Claude Skills Registry', url: 'https://majiayu000.github.io/claude-skill-registry-core', sourceType: 'claude-skills', enabled: false }] })

  test('quits normally while an actual SDK response is streaming', async ({ window, electronApp }, testInfo) => {
    const report: Record<string, unknown> = { requests: 0, closeSucceeded: false }
    const responses = new Set<ServerResponse>()
    const origin = createServer(async (request, response) => {
      for await (const chunk of request) void chunk
      if (request.method !== 'POST' || !request.url?.includes('chat/completions')) {
        response.writeHead(404); response.end(); return
      }
      report.requests = Number(report.requests) + 1
      responses.add(response)
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const send = (content: string) => response.write(`data: ${JSON.stringify({ id: 'active-quit-stream', object: 'chat.completion.chunk', model: 'mock-active-quit', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`)
      send('Actual shutdown stream is running. ')
      const interval = setInterval(() => send('continuing '), 100)
      response.once('close', () => { clearInterval(interval); responses.delete(response) })
    })
    const child = electronApp.process()
    const knownPids = new Set<number>([child.pid!])
    const events: Array<Record<string, unknown>> = []
    const listeners: Array<{ target: NodeJS.EventEmitter; event: string; listener: (...args: unknown[]) => void }> = []
    let started: number | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let closeSucceeded = false
    let logPath: string | undefined
    const processState = () => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, stdout: { ended: child.stdout!.readableEnded, closed: child.stdout!.closed }, stderr: { ended: child.stderr!.readableEnded, closed: child.stderr!.closed } })
    try {
      await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve))
      const baseUrl = `http://127.0.0.1:${(origin.address() as { port: number }).port}`
      await window.evaluate(async baseUrl => {
        const halo = (globalThis as unknown as ChatAcceptanceWindow).halo
        const response = await halo.getConfig()
        if (!response.success) throw new Error('Could not read the isolated source configuration')
        const config = response.data as { aiSources: { currentId: string | null; sources: Array<Record<string, unknown>> } }
        // The local stream needs no provider key, so a profile without one gets its own source.
        let source = config.aiSources.sources.find(candidate => candidate.id === config.aiSources.currentId)
        if (!source) {
          const now = new Date().toISOString()
          source = { id: crypto.randomUUID(), name: 'Active quit source', createdAt: now, updatedAt: now }
          config.aiSources.sources.push(source)
          config.aiSources.currentId = source.id as string
        }
        Object.assign(source, { provider: 'openai', authType: 'api-key', apiUrl: baseUrl, apiKey: 'active-quit-local-key', model: 'mock-active-quit', availableModels: [{ id: 'mock-active-quit', name: 'mock-active-quit' }] })
        const saved = await halo.setConfig({ aiSources: config.aiSources })
        if (!saved.success) throw new Error('Could not configure the local active-response source')
      }, baseUrl)
      await navigateToChat(window)
      const availability = await window.evaluate(() => (globalThis as unknown as ChatAcceptanceWindow).halo.getEngineAvailability())
      expect(availability.success).toBe(true)
      const engine = availability.data as { activeEngine: string; degradedFrom: string | null }
      if (process.env.HALO_TEST_SDK_ENGINE) expect(engine.activeEngine).toBe(process.env.HALO_TEST_SDK_ENGINE)
      expect(engine.degradedFrom).toBeNull()
      report.engine = engine.activeEngine
      await window.evaluate(() => {
        const state = globalThis as unknown as ChatAcceptanceWindow
        const probe: ChatTurnProbe = { conversationId: null, spaceId: null, completed: false, errorCount: 0, dispose: () => {} }
        const stopStart = state.halo.onAgentTurnStart(value => {
          const event = value as { conversationId: string; spaceId: string }
          probe.conversationId = event.conversationId; probe.spaceId = event.spaceId
        })
        const stopComplete = state.halo.onAgentComplete(value => { if ((value as { conversationId: string }).conversationId === probe.conversationId) probe.completed = true })
        const stopError = state.halo.onAgentError(() => { probe.errorCount++ })
        probe.dispose = () => { stopStart(); stopComplete(); stopError(); delete state.chatTurnProbe }
        state.chatTurnProbe = probe
      })
      await window.locator('textarea').first().fill('Continue streaming for the active quit verification.')
      await window.locator('[data-onboarding="send-button"]').click()
      await expect.poll(() => window.evaluate(async () => {
        const state = globalThis as unknown as ChatAcceptanceWindow
        const probe = state.chatTurnProbe!
        const session = probe.conversationId ? await state.halo.getSessionState(probe.conversationId) : null
        return { started: !!probe.conversationId, completed: probe.completed, active: (session?.data as { isActive: boolean } | undefined)?.isActive ?? null, errors: probe.errorCount }
      }), { timeout: 25000 }).toEqual({ started: true, completed: false, active: true, errors: 0 })
      await expect.poll(() => Number(report.requests), { timeout: 10000 }).toBeGreaterThan(0)
      await expect(window.locator('.message-assistant').first()).toContainText('Actual shutdown stream is running.', { timeout: 10000 })
      report.beforeClose = await electronApp.evaluate(() => ({ pid: process.pid, electron: process.versions.electron, node: process.versions.node }))
      const dataDir = await electronApp.evaluate(() => process.env.HALO_DATA_DIR)
      if (dataDir) logPath = `${dataDir}/logs/main.log`
      report.beforeProcesses = readOwnedProcesses(child.pid!, knownPids)
      started = performance.now()
      const record = (event: string, args: unknown[]) => events.push({ event, elapsedMs: performance.now() - started!, ...processState(), args })
      for (const event of ['exit', 'close']) {
        const listener = (...args: unknown[]) => record(`process ${event}`, args)
        child.on(event, listener); listeners.push({ target: child, event, listener })
      }
      for (const [name, stream] of [['stdout', child.stdout!], ['stderr', child.stderr!]] as const) for (const event of ['end', 'close']) {
        const listener = () => record(`${name} ${event}`, [])
        stream.on(event, listener); listeners.push({ target: stream, event, listener })
      }
      await Promise.race([electronApp.close(), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Normal quit during an active SDK response did not finish within ten seconds')), 10000) })])
      expect(child.exitCode).toBe(0)
      expect(child.signalCode).toBeNull()
      expect(child.stdout!.readableEnded && child.stderr!.readableEnded).toBe(true)
      expect(events.some(event => event.event === 'process exit')).toBe(true)
      expect(events.some(event => event.event === 'process close')).toBe(true)
      await expect.poll(() => readOwnedProcesses(child.pid!, knownPids).filter(process => !process.state.startsWith('Z')), { timeout: 2000 }).toEqual([])
      closeSucceeded = true
    } finally {
      clearTimeout(deadline)
      report.closeSucceeded = closeSucceeded
      report.elapsedMs = started === undefined ? null : performance.now() - started
      report.final = processState()
      report.events = events
      report.remainingProcesses = readOwnedProcesses(child.pid!, knownPids)
      await testInfo.attach('active-sdk-quit', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
      if (logPath && existsSync(logPath)) await testInfo.attach('active-sdk-quit-main-log', { body: readFileSync(logPath).subarray(-500000), contentType: 'text/plain' })
      for (const { target, event, listener } of listeners) target.removeListener(event, listener)
      if (!closeSucceeded) {
        await testInfo.attach('active-sdk-quit-failed-cleanup', { body: JSON.stringify({ forced: true, ownedPids: [...knownPids] }), contentType: 'application/json' })
        if (process.platform === 'win32') {
          for (const pid of knownPids) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F']) } catch {} }
        } else {
          try { process.kill(-child.pid!, 'SIGKILL') } catch {}
          for (const pid of knownPids) { try { process.kill(pid, 'SIGTERM') } catch {} }
        }
      }
      for (const response of responses) response.destroy()
      origin.closeAllConnections()
      await new Promise<void>(resolve => origin.close(() => resolve()))
    }
  })
})
