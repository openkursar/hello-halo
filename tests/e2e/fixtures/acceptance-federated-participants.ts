import { startAcceptanceModel, modelTool, initialUserInput, contentText, createModelGate, type ModelRequest, type ModelReply } from './acceptance-model'
import { collaboratorReceipt } from './acceptance-collaboration'

interface ParticipantCase {
  id: string
  marker: string
  file: string
  lead: string
  action: 'exchange' | 'stop' | 'delete'
}

export async function startFederatedParticipantModel() {
  const model = await startAcceptanceModel()
  const cases = new Map<string, ParticipantCase & {
    child?: string
    gate: ReturnType<typeof createModelGate>
    held: boolean
    seen: { returned: boolean; history: boolean; bytes: boolean; followedUp: boolean; summary: boolean }
  }>()
  const errors: string[] = []
  const checked = (request: ModelRequest, id: string) => {
    const result = request.toolResults.find(result => result.id === id)
    if (result?.error) errors.push(`Tool ${id} failed: ${result.text}`)
    return result
  }
  const prompt = (id: string, role: string) => `PARTICIPANT_FLOW ${JSON.stringify({ id, role })}\nFollow the assigned fixture work only.`
  const respond = (request: ModelRequest): ModelReply => {
    const label = initialUserInput(request).match(/PARTICIPANT_FLOW (\{[^\n]+\})/)
    if (!label) { errors.push(`Unidentified participant request ${request.sequence}`); return { text: 'No fixture assignment was found.' } }
    const { id, role } = JSON.parse(label[1]) as { id: string; role: string }
    const state = cases.get(id)
    if (!state) { errors.push(`Unknown participant case ${id}`); return { text: 'The requested fixture work does not exist.' } }
    const input = request.messages.filter(message => message.role === 'user').map(message => contentText(
      Array.isArray(message.content) ? message.content.filter(part => part.type !== 'tool_result') : message.content
    )).join('\n')
    if (role === 'parent') {
      if (input.includes(`LATE_RESULT_${state.marker}`)) throw new Error('An invalidated assistant result reached the parent model context.')
      const spawn = checked(request, `${id}-spawn`)
      if (!spawn) return { tools: [modelTool(request, 'spawn_agent', { name: 'Private checker', prompt: prompt(id, 'child') }, `${id}-spawn`)] }
      try { state.child = collaboratorReceipt(spawn).handle }
      catch (error) { errors.push(String(error)); return { text: 'The internal assistant was not created.' } }
      if (input.includes(`FRESH_AFTER_STOP_${id}`)) return { text: `FRESH_RESPONSE_${id}` }
      if (input.includes(`STOP_CHILD_${id}`)) {
        const stopped = checked(request, `${id}-stop`)
        if (!stopped) return { tools: [modelTool(request, 'team_stop', { to: state.child }, `${id}-stop`)] }
        try {
          const rows = JSON.parse(stopped.text) as Array<{ stopped: boolean; pending: boolean }>
          if (!rows.some(row => row.stopped && !row.pending)) throw new Error('The active assistant stop was not confirmed.')
        } catch (error) { errors.push(String(error)); return { text: 'The assistant stop was not confirmed.' } }
        return { text: `STOP_CONFIRMED_${id}` }
      }
      if (state.action !== 'exchange') return { text: `CHILD_CREATED_${id}` }
      const excerpts = input.split('\n').filter(line => /^\s*Final reply excerpt \(not a completion claim\): /.test(line))
        .map(line => JSON.parse(line.slice(line.indexOf(': ') + 2)) as string)
      const result = [...excerpts, input].map(text => text.match(new RegExp(`HELPER_RESULT_${id} (\\{[^\\n]+\\})`))).find(Boolean)
      if (!result) return { text: `CHILD_CREATED_${id}` }
      state.seen.returned = true
      const { file } = JSON.parse(result[1]) as { file: string }
      if (file !== state.file) throw new Error('The assistant did not return its actual private file reference.')
      const history = checked(request, `${id}-history`)
      if (!history) return { tools: [modelTool(request, 'team_read_member', { member: state.child }, `${id}-history`)] }
      if (history.error || !history.text.includes(`HELPER_RESULT_${id}`)) throw new Error('The parent did not read its private assistant record.')
      state.seen.history = true
      const bytes = checked(request, `${id}-bytes`)
      if (!bytes) return { tools: [modelTool(request, 'Read', { file_path: file }, `${id}-bytes`)] }
      if (bytes.error || !bytes.text.includes(`PRIVATE_DETAIL_${state.marker}`)) throw new Error('The parent did not read the private file bytes.')
      state.seen.bytes = true
      if (!input.includes(`FOLLOW_UP_PARENT_${id}`)) return { text: `HELPER_REVIEWED_${id}` }
      const followup = checked(request, `${id}-followup`)
      if (!followup) return { tools: [modelTool(request, 'team_send', { to: state.child, message: `LOCAL_FOLLOWUP_${id}` }, `${id}-followup`)] }
      if (followup.error || !/Message (delivered|accepted)/.test(followup.text)) throw new Error('The local assistant follow-up was refused.')
      if (!input.includes(`HELPER_FOLLOWUP_${id}`)) return { text: `FOLLOWUP_SENT_${id}` }
      state.seen.followedUp = true
      const published = checked(request, `${id}-publish`)
      if (!published) return { tools: [modelTool(request, 'team_post_finding', { content: `PARENT_SUMMARY_${id}` }, `${id}-publish`)] }
      if (published.error || !published.text.includes('Finding posted')) throw new Error('The parent summary was not published.')
      const shared = checked(request, `${id}-share`)
      if (!shared) return { tools: [modelTool(request, 'team_send', { to: 'lead', message: `PARENT_SUMMARY_${id}` }, `${id}-share`)] }
      if (shared.error || !/Message (delivered|accepted)/.test(shared.text)) throw new Error('The parent summary was not sent to the public lead.')
      return { text: `SUMMARY_SHARED_${id}` }
    }
    if (role === 'child') {
      if (input.includes(`FORBIDDEN_PUBLIC_SEND_${id}`)) throw new Error('A public team send reached the private helper.')
      if (input.includes(`LOCAL_FOLLOWUP_${id}`)) return { text: `HELPER_FOLLOWUP_${id}` }
      if (state.action !== 'exchange') {
        state.held = true
        return { text: `LATE_RESULT_${state.marker}`, hold: state.gate.promise }
      }
      const written = checked(request, `${id}-write`)
      if (!written) return { tools: [modelTool(request, 'Write', { file_path: state.file, content: `PRIVATE_DETAIL_${state.marker}\n` }, `${id}-write`)] }
      if (written.error) return { text: 'The private file was not written.' }
      const published = checked(request, `${id}-private-publish`)
      if (!published) return { tools: [modelTool(request, 'team_post_finding', { content: `PRIVATE_FINDING_${id}`, ref: state.file }, `${id}-private-publish`)] }
      if (published.error || !published.text.includes('Finding posted')) throw new Error('The private reference was not published.')
      return { text: `HELPER_RESULT_${id} ${JSON.stringify({ file: state.file })}` }
    }
    if (role === 'lead') {
      if (request.text.includes(`HELPER_RESULT_${id}`) || request.text.includes(`PRIVATE_DETAIL_${state.marker}`)
        || request.text.includes(`LATE_RESULT_${state.marker}`)) throw new Error('Private assistant content reached the public lead model context.')
      if (input.includes(`PARENT_SUMMARY_${id}`)) state.seen.summary = true
      const verification = input.match(new RegExp(`VERIFY_ISOLATION_${id} (\\{[^\\n]+\\})`))
      if (!verification) return { text: state.seen.summary ? `SUMMARY_RECEIVED_${id}` : `SOURCE_READY_${id}` }
      const { ref, member } = JSON.parse(verification[1]) as { ref: string; member: string }
      const artifact = request.toolResults.find(result => result.id === `${id}-denied-artifact`)
      if (!artifact) return { tools: [modelTool(request, 'team_read_artifact', { ref }, `${id}-denied-artifact`)] }
      if (artifact.text.includes(state.marker) || (!artifact.error && !/not published|not found|unavailable|not available|unknown|cannot|no published/i.test(artifact.text))) {
        throw new Error('The public lead did not receive a private artifact refusal.')
      }
      const history = request.toolResults.find(result => result.id === `${id}-denied-history`)
      if (!history) return { tools: [modelTool(request, 'team_read_member', { member }, `${id}-denied-history`)] }
      if (history.text.includes(`HELPER_RESULT_${id}`) || history.text.includes(state.marker)
        || (!history.error && !/not found|not available|unknown|cannot|no member/i.test(history.text))) {
        throw new Error('The public lead did not receive a private record refusal.')
      }
      return { text: `ISOLATION_VERIFIED_${id}` }
    }
    errors.push(`Unknown participant role ${role}`)
    return { text: 'No matching participant work.' }
  }
  model.respond(request => {
    try { return respond(request) }
    catch (error) {
      errors.push(`Fixture prerequisite failed for request ${request.sequence}: ${error instanceof Error ? error.message : String(error)}`)
      return { text: 'The requested fixture operation is unavailable; this verification cannot proceed.' }
    }
  })
  const requests = (id: string, role: string) => model.exchanges.filter(exchange => initialUserInput(exchange.request).includes(JSON.stringify({ id, role })))
  return {
    model, errors, prompt,
    register(input: ParticipantCase) { cases.set(input.id, { ...input, gate: createModelGate(), held: false,
      seen: { returned: false, history: false, bytes: false, followedUp: false, summary: false } }) },
    child: (id: string) => cases.get(id)?.child,
    seen: (id: string) => cases.get(id)?.seen,
    held: (id: string) => cases.get(id)?.held ?? false,
    cancelled(id: string) { return requests(id, 'child').some(exchange => exchange.cancelled && !exchange.completed) },
    release: (id: string) => cases.get(id)?.gate.release(),
    leadRequests(id: string) { return requests(id, 'lead').length },
    parentRequests(id: string) { return requests(id, 'parent').length },
    childRequests(id: string) { return requests(id, 'child').length },
    async close() { for (const state of cases.values()) state.gate.release(); await model.close() },
  }
}
