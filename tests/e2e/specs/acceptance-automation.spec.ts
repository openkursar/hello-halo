import type { Page } from '@playwright/test'
import {
  test, expect, acceptance, providerFailure, createAutomationToolGate, openAutomation,
  openAutomationProcess, readAutomationActivity, readAutomationPerson, readAutomationRuns,
  readAutomationState, readAutomationTranscript, startAutomation, waitForAutomationResult,
} from '../fixtures/acceptance-automation'
import { createModelGate, modelTool, type ModelRequest } from '../fixtures/acceptance-model'

test.setTimeout(180000)

function report(request: ModelRequest, id: string, summary: string) {
  const receipt = request.toolResults.find(result => result.id === id)
  if (!receipt) return { tools: [modelTool(request, 'report_to_user', { type: 'run_complete', message: summary }, id)] }
  expect(receipt.error).toBe(false)
  expect(receipt.text).toContain('Report saved')
  return { text: summary }
}

async function completeManualRun(window: Page, appId: string, summary: string, release: () => void) {
  const run = await startAutomation(window, appId)
  expect(run.triggerType).toBe('manual')
  await openAutomationProcess(window, appId, run.runId)
  await expect(window.getByText('Running — live', { exact: true })).toBeVisible()
  release()
  await waitForAutomationResult(window, appId, run.runId, 'ok')
  await expect(window.getByText('Running — live', { exact: true })).toHaveCount(0)
  await expect(window.locator('.message-assistant [data-message-content]').filter({ hasText: summary })).toBeVisible()
  const transcript = await readAutomationTranscript(window, appId, run.runId)
  expect(transcript.some(message => message.role === 'assistant' && message.content.includes(summary))).toBe(true)
  const entry = (await readAutomationActivity(window, appId)).find(entry => entry.runId === run.runId && entry.content.summary === summary)
  expect(entry).toMatchObject({ type: 'run_complete', content: { status: 'ok' } })
  return { run, transcript, entry }
}

test('a manual execution exposes its live process and retains the completed result after restart', acceptance('automation.runs.start'), async ({ model, automation, window }, testInfo) => {
  const gate = createModelGate()
  const summary = 'The independent review is complete: reference cedar-491.'
  model.respond(request => {
    const reply = report(request, 'automation-first-report', summary)
    return reply.tools ? { ...reply, text: 'The review is in progress.', hold: gate.promise } : reply
  })
  try {
    await openAutomation(window, automation)
    const { run, transcript, entry } = await completeManualRun(window, automation.appId, summary, gate.release)
    expect(await readAutomationRuns(window, automation.appId)).toHaveLength(1)
    const reopened = await automation.session.restart()
    await openAutomation(reopened, automation)
    await expect(reopened.locator(`[id="activity-${entry!.id}"]`)).toContainText(summary)
    const restored = await readAutomationRuns(reopened, automation.appId)
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ runId: run.runId, triggerType: 'manual', status: 'ok' })
    await openAutomationProcess(reopened, automation.appId, run.runId)
    await expect(reopened.getByText('Running — live', { exact: true })).toHaveCount(0)
    await expect(reopened.locator('.message-assistant [data-message-content]').filter({ hasText: summary })).toBeVisible()
    expect(await readAutomationTranscript(reopened, automation.appId, run.runId)).toEqual(transcript)
    await testInfo.attach('manual-run-result', { body: JSON.stringify({ run: restored, activity: await readAutomationActivity(reopened, automation.appId) }, null, 2), contentType: 'application/json' })
  } finally { gate.release() }
})

test('a follow-up receives the completed execution context and appends to that same persisted run', acceptance('automation.runs.followup'), async ({ model, automation, window }, testInfo) => {
  const gate = createModelGate()
  const first = 'The independent review is complete: reference cedar-491.'
  const followup = 'Continue this execution and use the reference from its first result.'
  const second = 'The same execution continued with reference cedar-491.'
  const receivedContext: boolean[] = []
  model.respond(request => {
    if (request.text.includes(followup)) {
      if (!request.toolResults.some(result => result.id === 'automation-followup-report')) receivedContext.push(request.text.includes(first))
      return report(request, 'automation-followup-report', second)
    }
    const reply = report(request, 'automation-first-report', first)
    return reply.tools ? { ...reply, text: 'The review is in progress.', hold: gate.promise } : reply
  })
  try {
    await openAutomation(window, automation)
    const { run, transcript: before, entry: firstEntry } = await completeManualRun(window, automation.appId, first, gate.release)
    await window.getByPlaceholder('Reply to continue this run...', { exact: true }).fill(followup)
    await window.locator('textarea').press('Enter')
    await expect(window.locator('textarea')).toHaveValue('')
    await expect.poll(async () => (await readAutomationActivity(window, automation.appId)).some(entry => entry.runId === run.runId && entry.content.summary === second), { timeout: 45000 }).toBe(true)
    await waitForAutomationResult(window, automation.appId, run.runId, 'ok')
    await expect(window.locator('.message-assistant [data-message-content]').filter({ hasText: second })).toBeVisible()
    expect(receivedContext).toEqual([true])
    expect(await readAutomationRuns(window, automation.appId)).toHaveLength(1)
    const after = await readAutomationTranscript(window, automation.appId, run.runId)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.filter(message => message.role === 'user' && message.content.includes(followup))).toHaveLength(1)
    const reopened = await automation.session.restart()
    await openAutomation(reopened, automation)
    await expect(reopened.locator(`[id="activity-${firstEntry!.id}"]`)).toContainText(first)
    await openAutomationProcess(reopened, automation.appId, run.runId)
    await expect(reopened.locator('.message-assistant [data-message-content]').filter({ hasText: second })).toBeVisible()
    expect(await readAutomationTranscript(reopened, automation.appId, run.runId)).toEqual(after)
    await testInfo.attach('manual-run-followup', { body: JSON.stringify({ run: await readAutomationRuns(reopened, automation.appId), activity: await readAutomationActivity(reopened, automation.appId), receivedContext }, null, 2), contentType: 'application/json' })
  } finally { gate.release() }
})

test('a message added during a real automation tool reaches its next model step in the same run', acceptance('automation.runs.live-input'), async ({ model, automation, window }, testInfo) => {
  const gate = createAutomationToolGate(automation.session.profile, 'automation-live-input')
  const supplement = 'Include the late correction: the reference date is 2040-06-12.'
  const summary = 'The independent run completed with the late reference-date correction.'
  const observed: Array<{ toolSucceeded: boolean; correctionReceived: boolean }> = []
  model.respond(request => {
    const tool = request.toolResults.find(result => result.id === 'automation-wait-tool')
    if (!tool) return { tools: [modelTool(request, 'Bash', { command: gate.command, timeout: 60000, run_in_background: false }, 'automation-wait-tool')] }
    if (!request.toolResults.some(result => result.id === 'automation-injected-report')) observed.push({ toolSucceeded: !tool.error && tool.text.includes('AUTOMATION_TOOL_RELEASED'), correctionReceived: request.text.includes(supplement) })
    return report(request, 'automation-injected-report', summary)
  })
  try {
    await openAutomation(window, automation)
    const run = await startAutomation(window, automation.appId)
    await expect.poll(gate.started, { timeout: 30000 }).toBe(true)
    await openAutomationProcess(window, automation.appId, run.runId)
    await expect(window.getByText('Running — live', { exact: true })).toBeVisible()
    const input = window.getByPlaceholder('Add a message to guide this run...', { exact: true })
    await input.fill(supplement)
    await input.press('Enter')
    await expect(input).toHaveValue('')
    await expect.poll(async () => (await readAutomationTranscript(window, automation.appId, run.runId)).some(message => message.role === 'user' && message.content.includes(supplement))).toBe(true)
    expect((await readAutomationState(window, automation.appId)).runningRunId).toBe(run.runId)
    gate.release()
    await waitForAutomationResult(window, automation.appId, run.runId, 'ok')
    expect(observed).toEqual([{ toolSucceeded: true, correctionReceived: true }])
    expect(await readAutomationRuns(window, automation.appId)).toHaveLength(1)
    await expect(window.locator('.message-assistant [data-message-content]').filter({ hasText: summary })).toBeVisible()
    const persisted = await readAutomationTranscript(window, automation.appId, run.runId)
    expect(persisted.filter(message => message.role === 'user' && message.content.includes(supplement))).toHaveLength(1)
    const reopened = await automation.session.restart()
    await openAutomation(reopened, automation)
    await openAutomationProcess(reopened, automation.appId, run.runId)
    await expect(reopened.locator('.message-assistant [data-message-content]').filter({ hasText: summary })).toBeVisible()
    expect(await readAutomationTranscript(reopened, automation.appId, run.runId)).toEqual(persisted)
    await testInfo.attach('automation-live-input', { body: JSON.stringify({ runId: run.runId, observed, persisted }, null, 2), contentType: 'application/json' })
  } finally { gate.release() }
})

for (const outcome of ['stopped', 'failed'] as const) {
  test(`a ${outcome} execution retains its actual outcome and a new manual execution can succeed`, acceptance('automation.runs.failure', { outcome }), async ({ model, automationFault, automation, window }, testInfo) => {
    const gate = createAutomationToolGate(automation.session.profile, 'automation-interruption')
    const summary = 'The new independent execution completed after the earlier interruption.'
    let recover = false
    model.respond(request => {
      if (recover) return report(request, 'automation-recovery-report', summary)
      return { tools: [modelTool(request, 'Bash', { command: gate.command, timeout: 60000, run_in_background: false }, 'automation-interrupted-tool')] }
    })
    automationFault.rejectInference = outcome === 'failed'
    try {
      await openAutomation(window, automation)
      const interrupted = await startAutomation(window, automation.appId)
      if (outcome === 'stopped') {
        await expect.poll(gate.started, { timeout: 30000 }).toBe(true)
        await window.getByRole('button', { name: 'Stop this execution', exact: true }).click()
      }
      const failed = await waitForAutomationResult(window, automation.appId, interrupted.runId, 'error')
      const reason = outcome === 'stopped' ? /stopp/i : providerFailure
      expect(failed.errorMessage).toMatch(reason)
      if (outcome === 'failed') expect(automationFault.rejected).toBeGreaterThan(0)
      const entry = (await readAutomationActivity(window, automation.appId)).find(entry => entry.runId === interrupted.runId && entry.type === 'run_error')
      expect(entry).toBeTruthy()
      expect(`${entry!.content.summary} ${entry!.content.error ?? ''}`).toMatch(reason)
      await expect(window.locator(`[id="activity-${entry!.id}"]`)).toContainText(reason)
      expect((await readAutomationActivity(window, automation.appId)).filter(entry => entry.runId === interrupted.runId && entry.type === 'run_complete')).toEqual([])
      gate.release()
      automationFault.rejectInference = false
      recover = true
      const next = await startAutomation(window, automation.appId)
      expect(next.runId).not.toBe(interrupted.runId)
      await waitForAutomationResult(window, automation.appId, next.runId, 'ok')
      const result = (await readAutomationActivity(window, automation.appId)).find(entry => entry.runId === next.runId && entry.content.summary === summary)
      expect(result).toMatchObject({ type: 'run_complete', content: { status: 'ok' } })
      await expect(window.locator(`[id="activity-${result!.id}"]`)).toContainText(summary)
      const reopened = await automation.session.restart()
      await openAutomation(reopened, automation)
      await expect(reopened.locator(`[id="activity-${entry!.id}"]`)).toContainText(reason)
      await expect(reopened.locator(`[id="activity-${result!.id}"]`)).toContainText(summary)
      const runs = await readAutomationRuns(reopened, automation.appId)
      expect(runs).toHaveLength(2)
      expect(runs.find(run => run.runId === interrupted.runId)?.status).toBe('error')
      expect(runs.find(run => run.runId === next.runId)?.status).toBe('ok')
      await testInfo.attach('automation-failure-recovery', { body: JSON.stringify({ outcome, rejected: automationFault.rejected, runs, activity: await readAutomationActivity(reopened, automation.appId) }, null, 2), contentType: 'application/json' })
    } finally {
      automationFault.rejectInference = false
      gate.release()
    }
  })
}

test.describe('automatic schedule pause and resume', () => {
  test.use({ automationInterval: '20s' })
  test('pausing crosses a real due time without a run and resuming restores the saved schedule', {
    annotation: [acceptance('automation.schedule.pause').annotation, acceptance('automation.schedule.fire').annotation],
  }, async ({ model, automation, window }, testInfo) => {
    const summary = 'The saved schedule completed its due execution.'
    model.respond(request => report(request, 'automation-scheduled-report', summary))
    await openAutomation(window, automation)
    const original = await readAutomationPerson(window, automation.appId)
    const due = (await readAutomationState(window, automation.appId)).nextRunAtMs
    expect(due, 'An enabled real schedule must expose its next due time').toBeGreaterThan(Date.now())
    await window.getByRole('button', { name: 'Pause automatic tasks', exact: true }).click()
    await expect.poll(async () => (await readAutomationState(window, automation.appId)).automaticEnabled).toBe(false)
    const pausedAt = Date.now()
    expect(pausedAt, 'Pause must complete before the observed schedule boundary').toBeLessThan(due!)
    const before = await readAutomationRuns(window, automation.appId)
    expect(before).toEqual([])
    await expect.poll(() => Date.now(), { timeout: 30000, intervals: [250] }).toBeGreaterThan(due! + 1000)
    expect(await readAutomationRuns(window, automation.appId)).toEqual(before)
    expect(model.exchanges).toEqual([])
    expect((await readAutomationPerson(window, automation.appId)).spec).toEqual(original.spec)
    await expect(window.getByRole('button', { name: 'Enable automatic tasks', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await window.getByRole('button', { name: 'Enable automatic tasks', exact: true }).click()
    await expect.poll(async () => (await readAutomationState(window, automation.appId)).automaticEnabled).toBe(true)
    const resumedDue = (await readAutomationState(window, automation.appId)).nextRunAtMs
    expect(resumedDue).toBeGreaterThan(Date.now())
    await expect.poll(async () => (await readAutomationRuns(window, automation.appId)).filter(run => run.status === 'ok').length, { timeout: 45000 }).toBe(1)
    await window.getByRole('button', { name: 'Pause automatic tasks', exact: true }).click()
    const runs = await readAutomationRuns(window, automation.appId)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'ok', triggerType: 'schedule' })
    expect(runs[0].startedAt, 'Resuming must wait for the scheduled due time rather than dispatching immediately').toBeGreaterThanOrEqual(resumedDue!)
    const entry = (await readAutomationActivity(window, automation.appId)).find(entry => entry.runId === runs[0].runId && entry.content.summary === summary)
    expect(entry).toMatchObject({ type: 'run_complete', content: { status: 'ok' } })
    await expect(window.locator(`[id="activity-${entry!.id}"]`)).toContainText(summary)
    expect((await readAutomationPerson(window, automation.appId)).spec).toEqual(original.spec)
    await testInfo.attach('schedule-pause-boundaries', { body: JSON.stringify({ due, pausedAt, resumedDue, runs, activity: entry }, null, 2), contentType: 'application/json' })
  })
})
