import { randomUUID } from 'node:crypto'
import type { ActivityEntry } from '../../../src/shared/apps/app-types'
import {
  test, expect, acceptance, openAutomation, startAutomation, readAutomationActivity,
  readAutomationRuns, readAutomationTranscript, decisionCard, readDecision, pendingDecisions,
  waitForDecisionQuestion, waitForDecisionCompletion, assertAnsweredCard,
} from '../fixtures/acceptance-decisions'
import { createModelGate, type ModelReply, type ModelRequest } from '../fixtures/acceptance-model'

test.setTimeout(180000)

test('two independent decisions resume only their own runs and an answered card cannot submit twice', acceptance('people.decisions.answer-once'), async ({ model, automation, window }, info) => {
  const tasks = ['alpha', 'beta'].map(label => ({
    label,
    question: `Which release should ${label} use? Reference ${randomUUID()}`,
    answer: `${label} approval ${randomUUID()}`,
    summary: `${label} completed after its own decision ${randomUUID()}`,
    askToolId: `decision-${label}-ask`,
    completionToolId: `decision-${label}-complete`,
    gate: createModelGate(),
  }))
  const entries = new Map<string, ActivityEntry>()
  const savedDecisions = new Map<string, ActivityEntry>()
  const initialRuns = new Map<string, { runId: string; sessionKey: string }>()
  let finalRuns: Awaited<ReturnType<typeof readAutomationRuns>> | undefined
  const observations: Array<{ task: string; sequence: number; ownQuestion: boolean; ownAnswer: boolean; otherQuestion: boolean; otherAnswer: boolean; input: string }> = []
  const reports: Array<{ task: string; sequence: number; successful: boolean }> = []
  const scriptIssues: Array<{ sequence: number; reason: string }> = []
  let launching: typeof tasks[number] | undefined

  function report(request: ModelRequest, task: typeof tasks[number], type: 'escalation' | 'run_complete'): ModelReply {
    const tools = request.tools.filter(name => name === 'report_to_user' || name.endsWith('__report_to_user'))
    if (tools.length !== 1) {
      scriptIssues.push({ sequence: request.sequence, reason: 'The real report tool was not advertised exactly once' })
      return { text: 'The requested reporting tool is unavailable.' }
    }
    return {
      tools: [{ id: type === 'escalation' ? task.askToolId : task.completionToolId, name: tools[0], input: { type, message: type === 'escalation' ? task.question : task.summary } }],
      ...(type === 'run_complete' ? { hold: task.gate.promise } : {}),
    }
  }

  model.respond(request => {
    for (const task of tasks) {
      const receipt = request.toolResults.find(result => result.id === task.completionToolId)
      if (receipt) {
        reports.push({ task: task.label, sequence: request.sequence, successful: !receipt.error && receipt.text.includes('Report saved') })
        return { text: task.summary }
      }
    }
    const answered = tasks.find(task => request.lastUserText.includes(task.answer))
    if (answered) {
      const other = tasks.find(task => task !== answered)!
      observations.push({
        task: answered.label, sequence: request.sequence,
        ownQuestion: request.lastUserText.includes(answered.question), ownAnswer: request.lastUserText.includes(answered.answer),
        otherQuestion: request.lastUserText.includes(other.question), otherAnswer: request.lastUserText.includes(other.answer),
        input: request.lastUserText,
      })
      return report(request, answered, 'run_complete')
    }
    // The runtime may cut a turn after its report result; never invent another question at that boundary.
    if (request.toolResults.some(result => tasks.some(task => task.askToolId === result.id))) return { text: 'Waiting for the owner to answer the saved question.' }
    if (launching) return report(request, launching, 'escalation')
    scriptIssues.push({ sequence: request.sequence, reason: 'A request arrived without its independent launch or decision answer' })
    return { text: 'No decision answer has reached this request.' }
  })

  try {
    await openAutomation(window, automation)
    for (const task of tasks) {
      launching = task
      const run = await startAutomation(window, automation.appId)
      const entry = await waitForDecisionQuestion(window, automation.appId, run.runId, task.question)
      entries.set(task.label, entry)
      initialRuns.set(task.label, { runId: run.runId, sessionKey: run.sessionKey })
      launching = undefined
      expect(scriptIssues).toEqual([])
    }
    expect(new Set([...entries.values()].map(entry => entry.id)).size).toBe(2)
    expect(new Set([...entries.values()].map(entry => entry.runId)).size).toBe(2)
    expect((await pendingDecisions(window, automation.appId)).map(entry => entry.id).sort()).toEqual([...entries.values()].map(entry => entry.id).sort())
    expect(observations).toEqual([])

    // Answer the later question first so activity order cannot stand in for decision identity.
    for (const task of [...tasks].reverse()) {
      const entry = entries.get(task.label)!
      const other = tasks.find(candidate => candidate !== task)!
      const card = decisionCard(window, entry.id)
      await expect(card.getByRole('textbox', { name: task.question, exact: true })).toBeVisible()
      await card.getByRole('textbox', { name: task.question, exact: true }).fill(task.answer)
      const submit = card.getByRole('button', { name: 'Submit and continue this work', exact: true })
      await expect(submit).toBeEnabled()
      if (task.label === 'beta') await submit.dblclick()
      else await submit.click()
      await assertAnsweredCard(window, entry.id, task.answer)
      await expect.poll(async () => (await readDecision(window, automation.appId, entry.id)).continuation?.status, { timeout: 30000 }).toBe('running')
      const received = await readDecision(window, automation.appId, entry.id)
      savedDecisions.set(task.label, received)
      expect(received.userResponse).toMatchObject({ text: task.answer })
      expect(received.continuation).toMatchObject({ attempts: 1 })
      await expect.poll(() => observations.filter(item => item.task === task.label).length, { timeout: 30000 }).toBe(1)
      expect(observations.find(item => item.task === task.label)).toMatchObject({ ownQuestion: true, ownAnswer: true, otherQuestion: false, otherAnswer: false })
      if (task.label === 'beta') {
        const unanswered = await readDecision(window, automation.appId, entries.get(other.label)!.id)
        expect(unanswered.userResponse).toBeUndefined()
        expect(unanswered.continuation).toBeUndefined()
        expect((await pendingDecisions(window, automation.appId)).map(item => item.id)).toEqual([unanswered.id])
        expect(observations.some(item => item.task === other.label)).toBe(false)
      }
      task.gate.release()
      const completed = await waitForDecisionCompletion(window, automation.appId, entry)
      savedDecisions.set(task.label, completed)
      expect(completed.userResponse).toMatchObject({ text: task.answer })
      const completions = (await readAutomationActivity(window, automation.appId)).filter(item => item.runId === entry.runId && item.type === 'run_complete')
      expect(completions).toHaveLength(1)
      expect(completions[0].content.summary).toBe(task.summary)
      await expect(window.locator(`[id="activity-${completions[0].id}"]`)).toContainText(task.summary)
      const transcript = await readAutomationTranscript(window, automation.appId, entry.runId)
      expect(transcript.filter(message => message.role === 'user' && message.content.includes(task.answer))).toHaveLength(1)
      expect(transcript.filter(message => message.role === 'assistant' && message.content === task.summary)).toHaveLength(1)
      expect(transcript.some(message => message.content.includes(other.answer))).toBe(false)
      await openAutomation(window, automation)
      await assertAnsweredCard(window, entry.id, task.answer)
      expect((await readDecision(window, automation.appId, entry.id)).continuation).toMatchObject({ status: 'completed', attempts: 1 })
    }

    const runs = finalRuns = await readAutomationRuns(window, automation.appId)
    expect(runs).toHaveLength(2)
    for (const task of tasks) {
      expect(runs.find(run => run.runId === initialRuns.get(task.label)!.runId)).toMatchObject({ ...initialRuns.get(task.label), status: 'ok' })
      expect((await readDecision(window, automation.appId, entries.get(task.label)!.id)).continuation).toMatchObject({ status: 'completed', attempts: 1 })
      expect(reports.filter(item => item.task === task.label)).toEqual([expect.objectContaining({ successful: true })])
    }
    expect(await pendingDecisions(window, automation.appId)).toEqual([])
    expect(observations.map(item => item.task)).toEqual(['beta', 'alpha'])
    expect(scriptIssues).toEqual([])
  } finally {
    for (const task of tasks) task.gate.release()
    await info.attach('independent-decision-routing', { body: JSON.stringify({ appId: automation.appId, initialRuns: Object.fromEntries(initialRuns), questions: Object.fromEntries(entries), decisions: Object.fromEntries(savedDecisions), finalRuns, observations, reports, scriptIssues }, null, 2), contentType: 'application/json' })
  }
})
