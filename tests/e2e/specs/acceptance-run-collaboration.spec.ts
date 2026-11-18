import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, createAutomationToolGate, openAutomation, openAutomationProcess, readAutomationActivity, readAutomationRuns, readAutomationState, readAutomationTranscript, startAutomation, waitForAutomationResult } from '../fixtures/acceptance-automation'
import { collaboratorReceipt, type CollaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { initialUserInput, modelTool, type ModelRequest, type ModelReply } from '../fixtures/acceptance-model'
import { planModelTool } from '../fixtures/acceptance-tool-discovery'

test.setTimeout(180000)

function collaborationScript(profile: string) {
  const files = [0, 1, 2].map(index => {
    const path = join(profile, `collaborator-input-${index}.txt`)
    const value = randomUUID()
    writeFileSync(path, value)
    return { path, value }
  })
  const gate = createAutomationToolGate(profile, 'collaborator-delay')
  const members: CollaboratorReceipt[] = []
  const reads = new Set<number>()
  const reports = new Set<number>()
  const errors: string[] = []
  let yielded = false
  let followupContext = false
  const summary = () => `The independent checks are complete: ${files.map(file => file.value).join(', ')}.`
  function tool(request: ModelRequest, name: string, input: Record<string, unknown>, id: string): ModelReply {
    const next = planModelTool(request, name, input, id)
    if ('error' in next) { errors.push(next.error); return { text: 'The requested tool is unavailable.' } }
    if (next.call.name === 'CallTool') {
      const definition = request.body.tools.find((entry: Record<string, any>) => (entry.function?.name ?? entry.name) === 'CallTool')
      const schema = definition?.input_schema ?? definition?.function?.parameters
      if (schema?.properties?.arguments?.type === 'object') next.call.input.arguments = input
    }
    return { tools: [next.call] }
  }
  const reply = (request: ModelRequest): ModelReply => {
    const assignment = initialUserInput(request).match(/^(?:\[Team message from[^\]]*\]\s*)?RUN_FILE_CHECK_(\d)/)
    if (assignment) {
      const index = Number(assignment[1])
      if (index === 2 && !request.toolResults.some(result => result.id === 'child-delay')) return tool(request, 'Bash', { command: gate.command, timeout: 60000 }, 'child-delay')
      const read = request.toolResults.find(result => result.id === `child-read-${index}`)
      if (!read) return tool(request, 'Read', { file_path: files[index].path }, `child-read-${index}`)
      if (!read.error && read.text.includes(files[index].value)) reads.add(index)
      else errors.push(`Child ${index} did not read its assigned value`)
      const sent = request.toolResults.find(result => result.id === `child-report-${index}`)
      if (!sent) return tool(request, 'team_send', { to: 'lead', message: `Verified input ${index}: ${files[index].value}` }, `child-report-${index}`)
      if (sent.error) errors.push(`Child ${index} report failed`)
      else reports.add(index)
      return { text: `Input ${index} was checked and reported.` }
    }
    if (request.text.includes('Continue the same checks without creating another run.')) {
      followupContext = files.every(file => request.text.includes(file.value))
      const receipt = request.toolResults.find(result => result.id === 'followup-report')
      if (!receipt) return tool(request, 'report_to_user', { type: 'run_complete', message: 'The original checks remain available in this execution.' }, 'followup-report')
      if (receipt.error) errors.push('Follow-up report failed')
      return { text: 'The original checks remain available in this execution.' }
    }
    for (let index = 0; index < 3; index++) {
      const receipt = request.toolResults.find(result => result.id === `run-spawn-${index}`)
      if (receipt && !members[index]) {
        try { members[index] = collaboratorReceipt(receipt) } catch (error) { errors.push(String(error)); return { text: 'Collaborator creation failed.' } }
      }
      if (!members[index]) return tool(request, 'spawn_agent', { name: `Input checker ${index}`, prompt: `RUN_FILE_CHECK_${index}: Read ${files[index].path} and report the exact value to lead.` }, `run-spawn-${index}`)
    }
    if (!files.every(file => request.text.includes(file.value))) { yielded = true; return { text: 'The independent checkers are still working.' } }
    const attempts = request.toolResults.filter(result => /^run-report-\d+$/.test(result.id))
    if (attempts.some(result => result.text.startsWith('Report saved (entry:'))) return { text: summary() }
    return tool(request, 'report_to_user', { type: 'run_complete', message: summary() }, `run-report-${attempts.length}`)
  }
  return { reply, files, gate, members, reads, reports, errors, summary, get yielded() { return yielded }, get followupContext() { return followupContext } }
}

for (const trigger of ['manual', 'schedule', 'webhook'] as const) {
  test.describe(`Run collaboration through ${trigger}`, () => {
    test.use({ automationInterval: trigger === 'schedule' ? '20s' : '24h' })
    test('waits for three real file readers and retains their combined report', acceptance('automation.runs.collaboration', { trigger }), async ({ model, automation, window }, testInfo) => {
      const script = collaborationScript(automation.session.profile)
      model.respond(script.reply)
      try {
        await openAutomation(window, automation)
        let run: Awaited<ReturnType<typeof startAutomation>>
        if (trigger === 'manual') run = await startAutomation(window, automation.appId)
        else {
          if (trigger === 'webhook') {
            const hook = `acceptance-${randomUUID()}`
            const port = await new Promise<number>((resolve, reject) => {
              const server = createServer()
              server.once('error', reject)
              server.listen(0, '127.0.0.1', () => {
                const port = (server.address() as { port: number }).port
                server.close(error => error ? reject(error) : resolve(port))
              })
            })
            const configured = await window.evaluate(async ({ appId, hook, port }) => {
              const api = (globalThis as unknown as { halo: HaloAPI }).halo
              const updated = await api.appUpdateSpec({ appId, specPatch: { subscriptions: [{ id: 'collaboration-hook', source: { type: 'webhook', config: { path: hook } } }] } })
              if (!updated.success) throw new Error(String(updated.error))
              const enabled = await api.enableRemoteAccess(port)
              if (!enabled.success) throw new Error(String(enabled.error))
              return api.getRemoteStatus()
            }, { appId: automation.appId, hook, port })
            expect(configured.success).toBe(true)
            const status = configured.data as { server: { port: number } }
            const response = await fetch(`http://127.0.0.1:${status.server.port}/hooks/${hook}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dedupKey: randomUUID() }) })
            expect(response.ok).toBe(true)
          }
          await expect.poll(async () => (await readAutomationRuns(window, automation.appId)).length, { timeout: 45000 }).toBe(1)
          run = (await readAutomationRuns(window, automation.appId))[0]
          if (trigger === 'schedule') await window.getByRole('button', { name: 'Pause automatic tasks', exact: true }).click()
        }
        expect(run.triggerType).toBe(trigger === 'webhook' ? 'event' : trigger)
        await expect.poll(script.gate.started, { timeout: 45000 }).toBe(true)
        await expect.poll(() => script.yielded, { timeout: 45000 }).toBe(true)
        expect((await readAutomationState(window, automation.appId)).runningRunId).toBe(run.runId)
        expect((await readAutomationActivity(window, automation.appId)).filter(entry => entry.runId === run.runId && entry.type === 'run_complete')).toEqual([])
        script.gate.release()
        await waitForAutomationResult(window, automation.appId, run.runId, 'ok')
        await expect.poll(() => script.reports.size).toBe(3)
        expect(script.reads.size).toBe(3)
        expect(new Set(script.members.map(member => member.handle)).size).toBe(3)
        expect(script.errors).toEqual([])
        const activity = (await readAutomationActivity(window, automation.appId)).filter(entry => entry.runId === run.runId && entry.type === 'run_complete')
        expect(activity).toHaveLength(1)
        expect(activity[0].content.summary).toBe(script.summary())
        for (const file of script.files) expect(readFileSync(file.path, 'utf8')).toBe(file.value)
        await openAutomationProcess(window, automation.appId, run.runId)
        await expect(window.locator('.message-assistant [data-message-content]').filter({ hasText: script.summary() })).toBeVisible()
        if (trigger === 'manual') {
          const before = await readAutomationTranscript(window, automation.appId, run.runId)
          await window.getByPlaceholder('Reply to continue this run...', { exact: true }).fill('Continue the same checks without creating another run.')
          await window.locator('textarea').press('Enter')
          await expect.poll(() => script.followupContext, { timeout: 45000 }).toBe(true)
          await expect.poll(async () => (await readAutomationActivity(window, automation.appId)).some(entry => entry.content.summary === 'The original checks remain available in this execution.'), { timeout: 45000 }).toBe(true)
          await waitForAutomationResult(window, automation.appId, run.runId, 'ok')
          expect(await readAutomationRuns(window, automation.appId)).toHaveLength(1)
          expect((await readAutomationTranscript(window, automation.appId, run.runId)).slice(0, before.length)).toEqual(before)
        }
        await testInfo.attach('run-collaboration', { body: JSON.stringify({ run, members: script.members, reads: [...script.reads], reports: [...script.reports], activity, errors: script.errors }), contentType: 'application/json' })
      } finally {
        script.gate.release()
        writeFileSync(testInfo.outputPath('collaboration-diagnostic.json'), JSON.stringify({
          errors: script.errors, members: script.members, reads: [...script.reads], reports: [...script.reports],
          exchanges: model.exchanges.map(exchange => ({ sequence: exchange.request.sequence, tools: exchange.request.tools,
            initial: initialUserInput(exchange.request).slice(0, 350), results: exchange.request.toolResults.slice(-3), reply: exchange.reply })),
        }, null, 2))
      }
    })
  })
}

test('stopping a run invalidates a delayed collaborator result', acceptance('automation.runs.collaboration-stop'), async ({ model, automation, window }) => {
  const script = collaborationScript(automation.session.profile)
  model.respond(script.reply)
  try {
    await openAutomation(window, automation)
    const run = await startAutomation(window, automation.appId)
    await expect.poll(script.gate.started, { timeout: 45000 }).toBe(true)
    await expect.poll(() => script.yielded, { timeout: 45000 }).toBe(true)
    await window.getByRole('button', { name: 'Stop this execution', exact: true }).click()
    const stopped = await waitForAutomationResult(window, automation.appId, run.runId, 'error')
    expect(stopped.errorMessage).toMatch(/stopp/i)
    script.gate.release()
    await expect.poll(() => model.exchanges.every(exchange => exchange.completed || exchange.cancelled || !!exchange.error), { timeout: 45000 }).toBe(true)
    const recoveredSummary = 'A new independent execution completed after stopping its collaborators.'
    model.respond(request => {
      const receipt = request.toolResults.find(result => result.id === 'recovery-report')
      if (!receipt) return { tools: [modelTool(request, 'report_to_user', { type: 'run_complete', message: recoveredSummary }, 'recovery-report')] }
      return { text: recoveredSummary }
    })
    const next = await startAutomation(window, automation.appId)
    expect(next.runId).not.toBe(run.runId)
    await waitForAutomationResult(window, automation.appId, next.runId, 'ok')
    await expect.poll(() => model.exchanges.every(exchange => exchange.completed || exchange.cancelled || !!exchange.error), { timeout: 45000 }).toBe(true)
    expect((await readAutomationActivity(window, automation.appId)).filter(entry => entry.runId === run.runId && entry.type === 'run_complete')).toEqual([])
    expect((await readAutomationActivity(window, automation.appId)).some(entry => entry.runId === next.runId && entry.content.summary === recoveredSummary)).toBe(true)
    const reopened = await automation.session.restart()
    expect((await readAutomationRuns(reopened, automation.appId)).find(row => row.runId === next.runId)?.status).toBe('ok')
    expect((await readAutomationRuns(reopened, automation.appId)).find(row => row.runId === run.runId)?.status).toBe('error')
    expect((await readAutomationActivity(reopened, automation.appId)).filter(entry => entry.runId === run.runId && entry.type === 'run_complete')).toEqual([])
  } finally { script.gate.release() }
})

test('explicitly disabled delegation is not exposed to a run', acceptance('automation.runs.collaboration-disabled'), async ({ model, automation, window }) => {
  const advertised: string[][] = []
  model.respond(request => {
    advertised.push(request.tools)
    const receipt = request.toolResults.find(result => result.id === 'disabled-report')
    if (!receipt) return { tools: [modelTool(request, 'report_to_user', { type: 'run_complete', message: 'This execution used no collaborators.' }, 'disabled-report')] }
    return { text: 'This execution used no collaborators.' }
  })
  const updated = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.setConfig({ agent: { disabledTools: ['Task', 'spawn_agent'] } }))
  expect(updated.success, String(updated.error)).toBe(true)
  await openAutomation(window, automation)
  const run = await startAutomation(window, automation.appId)
  await waitForAutomationResult(window, automation.appId, run.runId, 'ok')
  expect(advertised.length).toBeGreaterThan(0)
  expect(advertised.flat().filter(name => /(?:^|__)(?:spawn_agent|Task|Agent)$/.test(name))).toEqual([])
  const scope = await window.evaluate(key => (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(key), `app-run:${automation.appId}:${run.runId}`)
  expect(scope.success).toBe(true)
  expect(scope.data ?? null).toBeNull()
})
