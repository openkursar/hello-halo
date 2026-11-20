import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { acceptance } from '../fixtures/acceptance-app'
import {
  OWNER_ID, expect, guestChannelCard, guestConfiguration, imTranscript, switchByText, test, waitForGuestChannel, waitForImIdle,
} from '../fixtures/acceptance-guest'
import { createModelGate, latestUserInput, type ModelRequest } from '../fixtures/acceptance-model'
import type { AcceptanceWecomReply } from '../fixtures/acceptance-wecom'

test.setTimeout(120000)

const MINUTE_MS = 60_000
const CUTOFF_NOTICE = '我还在处理，有新进展会发在这里。'
const QUESTION = 'Check the isolated hand-off records and report the result.'
const NARRATION = 'The first record is checked. I will confirm the final hand-off now.'
const ANSWER = 'The final hand-off is confirmed.'

async function setMainTimeOffset(app: ElectronApplication, offsetMs: number) {
  await app.evaluate((_electron, offset) => {
    const state = globalThis as typeof globalThis & { acceptanceOriginalDateNow?: typeof Date.now }
    if (offset) {
      const now = state.acceptanceOriginalDateNow ??= Date.now
      Date.now = () => now() + offset
    } else if (state.acceptanceOriginalDateNow) {
      Date.now = state.acceptanceOriginalDateNow
      delete state.acceptanceOriginalDateNow
    }
  }, offsetMs)
}

function expectSummaryBefore(reply: AcceptanceWecomReply, operations: string[], words: string) {
  const [summary, ...body] = reply.text.split('\n\n')
  expect(summary.replace(/^_|_$/g, '').split('，').sort()).toEqual([...operations].sort())
  expect(body).toEqual([words])
}

test('an opted-in long WeCom reply closes its stream and sends real work with narration and the answer',
  acceptance('channels.wecom-streaming.continuation'), async ({ acceptanceApp, guestApp, wecom, model, window }) => {
    const card = await guestChannelCard(window, guestApp)
    expect(await switchByText(card, 'Streaming', true), 'Streaming must start off').toBe(false)
    await expect.poll(async () => (await guestConfiguration(window, guestApp.instanceId)).streaming).toBe(true)
    await waitForGuestChannel(window, guestApp, wecom)

    const marker = randomUUID()
    const firstFile = join(guestApp.workDir, 'handoff-initial.txt')
    const lastFile = join(guestApp.workDir, 'handoff-confirmation.txt')
    writeFileSync(firstFile, `initial-record-${marker}\n`)
    writeFileSync(lastFile, `confirmation-record-${marker}\n`)

    const beginWork = createModelGate()
    const checkMissing = createModelGate()
    const narrate = createModelGate()
    const answer = createModelGate()
    const missingTools = new Set<string>()
    const requests: ModelRequest[] = []
    const tool = (request: ModelRequest, name: string, id: string, input: Record<string, unknown>) => {
      const advertised = request.tools.find(tool => tool === name || tool.endsWith(`__${name}`))
      if (!advertised) {
        missingTools.add(name)
        return []
      }
      return [{ id, name: advertised, input }]
    }
    model.respond(async request => {
      if (!latestUserInput(request).includes(QUESTION)) return { text: 'Hand-off verification' }
      requests.push(request)
      const done = (id: string) => request.toolResults.some(result => result.id === id)
      if (done('confirmation-read')) {
        await answer.promise
        return { text: ANSWER }
      }
      if (done('missing-read')) {
        await narrate.promise
        return { text: NARRATION, tools: tool(request, 'Read', 'confirmation-read', { file_path: lastFile }) }
      }
      if (done('initial-command')) {
        await checkMissing.promise
        const tools = tool(request, 'Read', 'missing-read', { file_path: join(guestApp.workDir, 'missing-record.txt') })
        return tools.length ? { tools } : { text: 'The missing-record check was unavailable.' }
      }
      await beginWork.promise
      const tools = [
        ...tool(request, 'Read', 'initial-read', { file_path: firstFile }),
        ...tool(request, 'Bash', 'initial-command', { command: `printf 'command-result-${marker}'`, run_in_background: false }),
      ]
      return tools.length === 2 ? { tools } : { text: 'The local work tools were not available.' }
    })

    const before = wecom.replies.length
    const observed = () => wecom.replies.slice(before)
    const pushes = () => observed().filter(reply => reply.command === 'aibot_send_msg')
    try {
      const inbound = await wecom.sendText({ senderId: OWNER_ID, chatId: OWNER_ID, chatType: 'direct', text: QUESTION })
      const initial = await wecom.waitForReply({ requestId: inbound.requestId, chatId: OWNER_ID, finished: false })
      expect(initial.messageType).toBe('stream')
      expect(initial.streamId).toBeTruthy()
      await expect.poll(() => requests.length).toBe(1)
      expect(observed().every(reply => reply.command === 'aibot_respond_msg' && !reply.finished)).toBe(true)

      // Advance only the isolated main process's wall clock; real tools and provider frames remain in the path.
      await setMainTimeOffset(acceptanceApp.app, 9.5 * MINUTE_MS)
      beginWork.release()
      const cutoff = await wecom.waitForReply({ requestId: inbound.requestId, chatId: OWNER_ID, contains: CUTOFF_NOTICE })
      expect(cutoff).toMatchObject({ command: 'aibot_respond_msg', messageType: 'stream', streamId: initial.streamId })
      await expect.poll(() => requests.length).toBe(2)
      expect([...missingTools]).toEqual([])
      const initialResults = requests[1].toolResults
      expect(initialResults.find(result => result.id === 'initial-read')?.text).toContain(`initial-record-${marker}`)
      expect(initialResults.find(result => result.id === 'initial-command')?.text).toContain(`command-result-${marker}`)
      expect(pushes()).toEqual([])

      await setMainTimeOffset(acceptanceApp.app, 13 * MINUTE_MS)
      checkMissing.release()
      await expect.poll(() => requests.length).toBe(3)
      const failed = requests[2].toolResults.find(result => result.id === 'missing-read')
      expect(failed).toBeDefined()
      expect(failed!.error || /not found|does not exist|no such file/i.test(failed!.text)).toBe(true)
      expect(pushes()).toEqual([])
      narrate.release()
      const progress = await wecom.waitForReply({ chatId: OWNER_ID, after: cutoff.index + 1, contains: NARRATION })
      expect(progress).toMatchObject({ command: 'aibot_send_msg', messageType: 'markdown' })
      expectSummaryBefore(progress, ['读取了 1 个文件', '运行了 1 条命令'], NARRATION)
      await expect.poll(() => requests.length).toBe(4)
      expect(requests[3].toolResults.find(result => result.id === 'confirmation-read')?.text).toContain(`confirmation-record-${marker}`)
      expect(pushes()).toEqual([progress])

      answer.release()
      const final = await wecom.waitForReply({ chatId: OWNER_ID, after: progress.index + 1, contains: ANSWER })
      expect(final).toMatchObject({ command: 'aibot_send_msg', messageType: 'markdown' })
      expectSummaryBefore(final, ['读取了 1 个文件'], ANSWER)
      await waitForImIdle(window, guestApp, OWNER_ID)
      const history = await imTranscript(window, guestApp, OWNER_ID)
      expect(history.messages.filter(message => message.role === 'assistant' && message.content.includes(ANSWER))).toHaveLength(1)
      expect(observed().filter(reply => reply.index > cutoff.index)).toEqual([progress, final])
      expect(observed().filter(reply => reply.text.includes(CUTOFF_NOTICE))).toEqual([cutoff])
      expect(observed().every(reply => reply.chatId === OWNER_ID)).toBe(true)
      expect([progress, final].map(reply => reply.text).join('\n')).not.toMatch(/<think>|任务进行中|missing-record\.txt|(?:initial-record|confirmation-record|command-result)-/)
    } finally {
      beginWork.release()
      checkMissing.release()
      narrate.release()
      answer.release()
      await setMainTimeOffset(acceptanceApp.app, 0)
    }
  })
