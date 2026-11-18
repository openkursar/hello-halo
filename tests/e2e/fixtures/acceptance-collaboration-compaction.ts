import { collaboratorReceipt, type CollaboratorReceipt } from './acceptance-collaboration'
import { modelTool, type ModelReply, type ModelRequest } from './acceptance-model'
import { systemOf } from './acceptance-team-awareness'

export const compactionStart = 'COMPACTION_SOURCE: Create two collaborators and retain their separate assignments.'
export const compactionReady = 'Both collaborators and shared records are ready for compaction.'
export const compactionContinue = 'COMPACTION_CONTINUE: Recover the existing collaborators and ask each for its original private reference.'
export const compactionDone = 'Both original collaborators returned their private references after compaction.'
export const compactionSummary = 'Continue the original task. Existing collaborators must be contacted rather than recreated. Shared records remain authoritative.'
export const compactionFinding = 'compaction-evidence.txt'
const references = ['amber-private-741', 'violet-private-862']

export interface CollaborationReminder { raw: string; members: string[]; lines: string[] }

/** Reads the plain-language reminder the way a model would: member names from its Members line. */
export function collaborationReminder(text: string): CollaborationReminder | undefined {
  const match = text.match(/<system-reminder>\nCollaboration state when this conversation was compacted[\s\S]*?<\/system-reminder>/)
  if (!match) return
  const lines = match[0].split('\n')
  const roster = lines.find(line => line.startsWith('Members ('))?.replace(/^Members \(\d+\): /, '').replace(/\.$/, '') ?? ''
  const members = [...roster.matchAll(/(?:^|, )([^,(]+?) \([^)]*\)/g)].map(item => item[1])
  return { raw: match[0], members, lines }
}

export function createCollaborationCompactionScript(trigger: 'manual' | 'auto') {
  const errors: string[] = []
  const created: CollaboratorReceipt[] = []
  const recovered: Array<{ sequence: number } & CollaborationReminder> = []
  const memberRequests: ModelRequest[] = []
  const sourceRequests: ModelRequest[] = []
  let armed = false
  let rejected = false
  let summaries = 0
  let recovery = 0
  const fail = (message: string): ModelReply => { errors.push(message); return { text: `Fixture observation failed: ${message}` } }
  function call(request: ModelRequest, name: string, input: Record<string, unknown>, id: string): ModelReply {
    const discovery = `discover-${id}`
    const advertised = request.tools.filter(tool => tool === name || tool.endsWith(`__${name}`))
    const definition = (request.body.tools ?? []).find((tool: Record<string, any>) => (tool.function?.name ?? tool.name) === advertised[0])
    const deferred = definition?.defer_loading === true || definition?.function?.defer_loading === true
    if (advertised.length === 1 && (!deferred || request.toolResults.some(result => result.id === discovery))) {
      return { tools: [modelTool(request, name, input, id)] }
    }
    if (request.tools.includes('ToolSearch') && !request.toolResults.some(result => result.id === discovery)) {
      return { tools: [modelTool(request, 'ToolSearch', { query: `select:mcp__halo-team__${name}`, max_results: 1 }, discovery)] }
    }
    if (request.tools.includes('CallTool') && request.toolResults.some(result => result.id === discovery)) {
      return { tools: [modelTool(request, 'CallTool', { tool: `mcp__halo-team__${name}`, arguments: input }, id)] }
    }
    return fail(`Missing ${name}`)
  }
  function reply(request: ModelRequest): ModelReply {
    try {
      if (request.lastUserText.startsWith('Prepare a compact handover for another assistant continuing the same task.') || request.lastUserText.includes('<conversation_to_summarize')) {
        summaries++
        return { text: compactionSummary }
      }
      const member = request.text.match(/COMPACTION_MEMBER_(0|1):/)
      const source = systemOf(request).includes("You are Halo, the AI assistant in Halo's chat.")
      if (member && !source) {
        memberRequests.push(request)
        const index = Number(member[1])
        if (request.text.includes('COMPACTION_FOLLOWUP')) {
          if (!request.text.includes(references[index])) return fail(`Member ${index} lost its private assignment`)
          return { text: `COMPACTION_REPORT_${index}: ${references[index]}` }
        }
        return { text: `COMPACTION_MEMBER_READY_${index}` }
      }
      sourceRequests.push(request)
      if (armed) {
        if (trigger === 'auto' && !rejected) {
          rejected = true
          return { failure: { status: 400, type: 'context_window_exceeded', message: 'The input exceeds the context window.' } }
        }
        const reminder = collaborationReminder(request.text)
        if (!reminder) return fail('Next provider request has no collaboration recovery reminder')
        if ([...reminder.raw].length > 12000) return fail('Recovery reminder exceeds 12000 characters')
        if (/[{}]/.test(reminder.raw)) return fail('Recovery reminder is not plain language')
        if (!recovered.some(item => item.sequence === request.sequence)) recovered.push({ sequence: request.sequence, ...reminder })
        const members = reminder.members.filter(name => /^Compaction Checker [01]-/.test(name))
        if (members.length !== 2) return fail('Recovery reminder omitted a collaborator')
        if (!reminder.lines.some(line => line.startsWith('Unfinished tasks (')) || !reminder.lines.some(line => line.startsWith('Recent findings') && line.includes(compactionFinding))) return fail('Recovery reminder omitted task or finding references')
        for (const [index, name] of members.entries()) {
          const readId = `recover-${recovery}-read-${index}`
          const read = request.toolResults.find(result => result.id === readId)
          if (!read) return call(request, 'team_read_member', { member: name }, readId)
          if (read.error) return fail(`Original member read refused: ${read.text}`)
          const sendId = `recover-${recovery}-send-${index}`
          const send = request.toolResults.find(result => result.id === sendId)
          if (!send) return call(request, 'team_send', { to: name, message: 'COMPACTION_FOLLOWUP: Report the reference in your original private assignment.' }, sendId)
          if (send.error) return fail(`Original member send refused: ${send.text}`)
        }
        return { text: references.every((ref, index) => request.text.includes(`COMPACTION_REPORT_${index}: ${ref}`)) ? compactionDone : 'Waiting for both original collaborators to report.' }
      }
      for (let index = 0; index < 2; index++) {
        const id = `compact-spawn-${index}`
        const result = request.toolResults.find(result => result.id === id)
        if (!result) return call(request, 'spawn_agent', { name: `Compaction Checker ${index}`, prompt: `COMPACTION_MEMBER_${index}: Retain private reference ${references[index]}. Wait for follow-up work.` }, id)
        if (!created[index]) created[index] = collaboratorReceipt(result)
      }
      const task = request.toolResults.find(result => result.id === 'compact-task')
      if (!task) return call(request, 'team_post_task', { title: 'Verify retained collaboration references', assignee: created[0].handle }, 'compact-task')
      if (task.error) return fail(task.text)
      const finding = request.toolResults.find(result => result.id === 'compact-finding')
      if (!finding) return call(request, 'team_post_finding', { content: 'Both retained collaborators own independent evidence.', ref: compactionFinding }, 'compact-finding')
      if (finding.error) return fail(finding.text)
      return { text: compactionReady }
    } catch (error) { return fail(String(error)) }
  }
  return { reply, errors, created, recovered, sourceRequests, memberRequests,
    arm() { armed = true; recovery++ }, get summaries() { return summaries }, get rejected() { return rejected } }
}
