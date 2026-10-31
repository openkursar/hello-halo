import { randomUUID } from 'node:crypto'
import type { ActivityEntry } from '../../../src/shared/apps/app-types'
import {
  test, expect, acceptance, createAutomationToolGate, openAutomation, readAutomationActivity,
  readAutomationRuns, readAutomationState, readAutomationTranscript, startAutomation,
} from '../fixtures/acceptance-automation'
import { assertAnsweredCard, decisionCard, pendingDecisions, readDecision, waitForDecisionCompletion } from '../fixtures/acceptance-decisions'
import { attentionPhase, inspectAttentionRun, openAttentionWork } from '../fixtures/acceptance-attention'
import { createModelGate, type ModelRequest, type ModelReply } from '../fixtures/acceptance-model'
import { navigateToSettings } from '../fixtures/helpers'

test.setTimeout(180000)

test('Tasks follows one real run through work, an unanswered decision, resumed work and completion', acceptance('notifications.attention.status'), async ({ automation, model, window }, info) => {
  const toolGate = createAutomationToolGate(automation.session.profile, 'attention-running-tool')
  const completionGate = createModelGate()
  const progress = `Attention work in progress ${randomUUID()}`
  const question = `Which delivery should this work prepare? ${randomUUID()}`
  const answer = `Prepare the selected delivery ${randomUUID()}`
  const summary = `The selected delivery is complete ${randomUUID()}`
  const observations: Array<Record<string, unknown>> = []
  const destinations: Array<Record<string, unknown>> = []
  const toolReceipts: Array<{ successful: boolean }> = []
  const answerInputs: Array<{ question: boolean; answer: boolean; text: string }> = []
  const completionReceipts: Array<{ successful: boolean }> = []
  const scriptIssues: Array<{ sequence: number; tool: string; matches: number }> = []
  let entry: ActivityEntry | undefined
  let run: Awaited<ReturnType<typeof startAutomation>> | undefined
  let completedDecision: ActivityEntry | undefined
  let finalRuns: Awaited<ReturnType<typeof readAutomationRuns>> | undefined

  const call = (request: ModelRequest, name: string, id: string, input: Record<string, unknown>, extra: Pick<ModelReply, 'text' | 'hold'> = {}): ModelReply => {
    const matches = request.tools.filter(tool => tool === name || tool.endsWith(`__${name}`))
    if (matches.length !== 1) {
      scriptIssues.push({ sequence: request.sequence, tool: name, matches: matches.length })
      return { text: 'The requested task tool is unavailable.' }
    }
    return { ...extra, tools: [{ id, name: matches[0], input }] }
  }

  model.respond(request => {
    const complete = request.toolResults.find(result => result.id === 'attention-complete')
    if (complete) {
      completionReceipts.push({ successful: !complete.error && complete.text.includes('Report saved') })
      return { text: summary }
    }
    if (request.lastUserText.includes(answer)) {
      answerInputs.push({ question: request.lastUserText.includes(question), answer: true, text: request.lastUserText })
      return call(request, 'report_to_user', 'attention-complete', { type: 'run_complete', message: summary }, { hold: completionGate.promise })
    }
    if (request.toolResults.some(result => result.id === 'attention-question')) return { text: 'Waiting for the saved decision.' }
    const tool = request.toolResults.find(result => result.id === 'attention-running-tool')
    if (tool) {
      toolReceipts.push({ successful: !tool.error && tool.text.includes('AUTOMATION_TOOL_RELEASED') })
      return call(request, 'report_to_user', 'attention-question', { type: 'escalation', message: question })
    }
    return call(request, 'Bash', 'attention-running-tool', { command: toolGate.command, timeout: 60000, run_in_background: false }, { text: progress })
  })

  const observe = async (phase: 'running' | 'waiting' | 'idle') => {
    observations.push({ ...(await attentionPhase(window, automation.name, phase)), state: await readAutomationState(window, automation.appId) })
  }

  try {
    await window.setViewportSize({ width: 1600, height: 1000 })
    await openAutomation(window, automation)
    await observe('idle')
    run = await startAutomation(window, automation.appId)
    await expect.poll(toolGate.started, { timeout: 30000 }).toBe(true)
    expect(run.triggerType).toBe('manual')
    await navigateToSettings(window)
    await observe('running')
    await openAttentionWork(window, automation.name)
    destinations.push(await inspectAttentionRun(window, automation.appId, run, progress))

    await navigateToSettings(window)
    toolGate.release()
    await expect.poll(async () => (await readAutomationRuns(window, automation.appId)).find(item => item.runId === run!.runId)?.status, { timeout: 30000 }).toBe('waiting_user')
    await expect.poll(async () => (await readAutomationState(window, automation.appId)).status).toBe('waiting_user')
    const questions = (await readAutomationActivity(window, automation.appId)).filter(item => item.runId === run!.runId && item.type === 'escalation' && item.content.summary === question)
    expect(questions).toHaveLength(1)
    entry = questions[0]
    expect(entry).toMatchObject({ appId: automation.appId, runId: run.runId, sessionKey: run.sessionKey })
    expect(toolReceipts).toEqual([{ successful: true }])
    await observe('waiting')
    await openAttentionWork(window, automation.name)
    await expect(decisionCard(window, entry.id)).toBeVisible()
    await expect(decisionCard(window, entry.id)).toContainText(question)
    expect((await pendingDecisions(window, automation.appId)).map(item => item.id)).toEqual([entry.id])
    destinations.push({ phase: 'waiting', appId: automation.appId, runId: entry.runId, sessionKey: entry.sessionKey, entryId: entry.id })
    await decisionCard(window, entry.id).getByRole('textbox', { name: question, exact: true }).fill(answer)
    await decisionCard(window, entry.id).getByRole('button', { name: 'Submit and continue this work', exact: true }).click()
    await assertAnsweredCard(window, entry.id, answer)
    await expect.poll(async () => (await readDecision(window, automation.appId, entry!.id)).continuation?.status, { timeout: 30000 }).toBe('running')
    expect((await readDecision(window, automation.appId, entry.id)).continuation).toMatchObject({ attempts: 1 })
    await expect.poll(() => answerInputs.length).toBe(1)
    expect(answerInputs[0]).toMatchObject({ question: true, answer: true })

    await navigateToSettings(window)
    await observe('running')
    await openAttentionWork(window, automation.name)
    destinations.push(await inspectAttentionRun(window, automation.appId, run, answer))
    await navigateToSettings(window)
    completionGate.release()
    completedDecision = await waitForDecisionCompletion(window, automation.appId, entry)
    expect(completedDecision).toMatchObject({ runId: run.runId, sessionKey: run.sessionKey, userResponse: { text: answer } })
    await expect.poll(async () => (await readAutomationState(window, automation.appId)).status).toBe('idle')
    await observe('idle')
    expect(await pendingDecisions(window, automation.appId)).toEqual([])
    const runs = finalRuns = await readAutomationRuns(window, automation.appId)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ runId: run.runId, sessionKey: run.sessionKey, status: 'ok' })
    expect(completionReceipts).toEqual([{ successful: true }])
    expect(scriptIssues).toEqual([])

    await window.getByRole('button', { name: 'Digital Humans', exact: true }).click()
    const runLabel = window.getByText(`Run ${run.runId.slice(0, 8)}`, { exact: true })
    await expect(runLabel).toBeVisible()
    await runLabel.locator('..').getByRole('button', { name: automation.name, exact: true }).click()
    await expect(runLabel).toHaveCount(0)
    await expect(window.getByRole('heading', { name: automation.name, exact: true, level: 2 })).toBeVisible()
    await expect(window.getByRole('heading', { name: 'Recent activity', exact: true })).toBeVisible()
    await assertAnsweredCard(window, entry.id, answer)
    const completions = (await readAutomationActivity(window, automation.appId)).filter(item => item.runId === run!.runId && item.type === 'run_complete')
    expect(completions).toHaveLength(1)
    expect(completions[0].content.summary).toBe(summary)
    await expect(window.locator(`[id="activity-${completions[0].id}"]`)).toContainText(summary)
    const transcript = await readAutomationTranscript(window, automation.appId, run.runId)
    expect(transcript.filter(message => message.role === 'user' && message.content.includes(answer))).toHaveLength(1)
    expect(transcript.filter(message => message.role === 'assistant' && message.content === summary)).toHaveLength(1)
    await observe('idle')
  } finally {
    toolGate.release()
    completionGate.release()
    await info.attach('task-attention-transitions', { body: JSON.stringify({ appId: automation.appId, run, entry, completedDecision, finalRuns, observations, destinations, toolReceipts, answerInputs, completionReceipts, scriptIssues }, null, 2), contentType: 'application/json' })
  }
})
