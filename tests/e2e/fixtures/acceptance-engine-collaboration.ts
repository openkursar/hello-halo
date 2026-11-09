import { collaboratorReceipt, hasRetiredDailyTeamTool, type CollaboratorReceipt } from './acceptance-collaboration'
import { initialUserInput, modelTool, type ModelRequest, type ModelReply } from './acceptance-model'

export const engineSourceQuestion = 'ENGINE_COLLABORATION_CHECK: Create one collaborator, then ask it a follow-up after its first reply. Summarize its answer here.'
export const engineMemberAssignment = 'ENGINE_MEMBER_ASSIGNMENT: Remember the reference amber-parity-826 in your own context and wait for follow-up work.'
export const engineFollowup = 'ENGINE_MEMBER_FOLLOWUP: Report the reference from your original assignment.'
export const engineReady = 'The collaborator is ready for its follow-up.'
export const engineMemberResult = 'The retained reference is amber-parity-826.'
export const engineSourceAnswer = 'The collaborator answered the follow-up with amber-parity-826.'
export const engineRestartReady = 'The original collaborator is ready to continue after restarting the application.'
export const engineResumeQuestion = 'Continue the original collaboration. Ask the existing member for the reference from its assignment, then summarize its answer.'

function originalInput(request: ModelRequest): { text: string; restored: boolean } {
  const initial = initialUserInput(request)
  if (!initial.startsWith('Historical conversation context follows as JSON data.')) return { text: initial, restored: false }
  const lineEnd = initial.indexOf('\n')
  const current = initial.indexOf('\n\nCurrent message:\n', lineEnd)
  const context = JSON.parse(initial.slice(lineEnd + 1, current < 0 ? undefined : current))
  if (context.version !== 1 || !Array.isArray(context.records)) throw new Error('The restored collaboration history is malformed.')
  const record = context.records.find((record: Record<string, unknown>) => record.role !== 'assistant' && typeof record.text === 'string' && record.text.trim())
  return { text: record?.text ?? '', restored: true }
}

export function createEngineCollaborationScript(options: { restartBeforeFollowup?: boolean } = {}) {
  let created: CollaboratorReceipt | undefined
  let followedUp = false
  let restarted = false
  const restoredSourceRequests: number[] = []
  const restoredMemberRequests: number[] = []
  const errors: string[] = []
  function tool(request: ModelRequest, name: string, input: Record<string, unknown>, id: string): ModelReply {
    const discoveryId = `discover-${name}`
    const advertised = request.tools.filter(tool => tool === name || tool.endsWith(`__${name}`))
    const definition = (request.body.tools ?? []).find((tool: Record<string, any>) => (tool.function?.name ?? tool.name) === advertised[0])
    const deferred = definition?.defer_loading === true || definition?.function?.defer_loading === true
    if (advertised.length === 1 && (!deferred || request.toolResults.some(result => result.id === discoveryId))) return { tools: [modelTool(request, name, input, id)] }
    if (advertised.length <= 1 && request.tools.includes('ToolSearch') && !request.toolResults.some(result => result.id === discoveryId)) {
      return { tools: [modelTool(request, 'ToolSearch', { query: `select:mcp__halo-team__${name}`, max_results: 1 }, discoveryId)] }
    }
    errors.push(`The selected engine did not expose ${name}.`)
    return { text: 'The collaboration tool is unavailable.' }
  }
  const reply = (request: ModelRequest): ModelReply => {
    if (hasRetiredDailyTeamTool(request)) errors.push('A retired daily collaboration tool was advertised.')
    const native = request.tools.filter(tool => ['Agent', 'Task', 'spawn_agent', 'subagent', 'spawn_subagent'].includes(tool))
    if (native.length) errors.push(`Native delegation was advertised: ${native.join(', ')}`)
    let input: ReturnType<typeof originalInput>
    try { input = originalInput(request) }
    catch (error) { errors.push(String(error)); return { text: 'The original collaboration context is unavailable.' } }
    const initial = input.text
    if (initial.includes(engineSourceQuestion)) {
      const result = request.toolResults.find(result => result.id === 'engine-spawn')
      if (result) {
        try { created = collaboratorReceipt(result) }
        catch (error) { errors.push(String(error)); return { text: 'The collaborator could not be created.' } }
      } else if (!input.restored && !restarted && !created) {
        return tool(request, 'spawn_agent', { name: 'Checker', prompt: engineMemberAssignment }, 'engine-spawn')
      } else if (!input.restored || !created || !request.text.includes(created.handle)) {
        errors.push('The source lost its original task or accepted member handle during recovery.')
        return { text: 'The original collaboration context is unavailable.' }
      }
      if (restarted && input.restored) restoredSourceRequests.push(request.sequence)
      if (!request.text.includes(engineReady)) return { text: 'The collaborator is preparing.' }
      if (options.restartBeforeFollowup && !restarted) return { text: engineRestartReady }
      const sent = request.toolResults.find(result => result.id === 'engine-followup')
      if (!sent) return tool(request, 'team_send', { to: created!.handle, message: engineFollowup }, 'engine-followup')
      if (sent.error) errors.push(`The follow-up was refused: ${sent.text}`)
      return { text: request.text.includes(engineMemberResult) ? engineSourceAnswer : 'The collaborator is answering the follow-up.' }
    }
    if (/^(?:\[Team message from [^\]]+\]\s*)?ENGINE_MEMBER_ASSIGNMENT:/.test(initial)) {
      if (request.text.includes(engineFollowup)) {
        if (restarted && (!input.restored || !request.text.includes(engineMemberAssignment))) {
          errors.push('The member lost its private assignment during recovery.')
          return { text: 'The original member context is unavailable.' }
        }
        if (restarted) restoredMemberRequests.push(request.sequence)
        followedUp = true
        if (!request.text.includes('amber-parity-826')) errors.push('The member lost its initial assignment context.')
        return { text: engineMemberResult }
      }
      return { text: engineReady }
    }
    errors.push(`Unrecognized engine collaboration actor in request ${request.sequence}`)
    return { text: 'No matching collaboration fixture work.' }
  }
  return {
    reply, errors, restoredSourceRequests, restoredMemberRequests,
    resumeAfterRestart() { if (!created) throw new Error('The original member must exist before restart'); restarted = true },
    get created() { return created }, get followedUp() { return followedUp },
  }
}
