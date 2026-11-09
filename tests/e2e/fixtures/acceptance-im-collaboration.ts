import { collaboratorReceipt, hasRetiredDailyTeamTool } from './acceptance-collaboration'
import { initialUserInput, latestUserInput, createModelGate, modelTool, type ModelRequest, type ModelReply } from './acceptance-model'
import { planModelTool } from './acceptance-tool-discovery'

export const question = 'Ask one collaborator to check alpha and bring the conclusion back to this group.'
export const later = 'A different sender is here now. Just acknowledge this message.'
export const started = 'The collaborator is checking alpha.'
export const acknowledged = 'The later sender was acknowledged.'
export const assignment = 'IM_MEMBER_ASSIGNMENT: Check alpha independently and report your result.'
export const raw = 'UNREVIEWED_COLLABORATOR_EVIDENCE_769'
export const reviewed = 'I reviewed the collaborator’s evidence: alpha is confirmed.'
export const probe = 'Confirm this group can continue with a fresh human request.'
export const probeReply = 'This group can continue.'

export interface DeferredProbeState {
  name: string
  id: string
  results: ModelRequest['toolResults']
  error?: string
  done: boolean
}

export function createImCollaborationScript(options: {
  onReview?: (request: ModelRequest) => ModelReply | undefined
  /** A real tool this turn must discover through the client gateway before using it. */
  deferredProbe?: { name: string; id: string }
} = {}) {
  const gate = createModelGate()
  const errors: string[] = []
  const callbacks: ModelRequest[] = []
  const initialRequests: ModelRequest[] = []
  const laterRequests: ModelRequest[] = []
  const deferred: DeferredProbeState | undefined = options.deferredProbe
    ? { ...options.deferredProbe, results: [], done: false }
    : undefined
  let memberStarted = false
  const reply = (request: ModelRequest): ModelReply => {
    if (hasRetiredDailyTeamTool(request)) errors.push('A retired team tool was advertised.')
    const initial = initialUserInput(request)
    const current = latestUserInput(request)
    if (initial.includes(assignment)) { memberStarted = true; return { text: raw, hold: gate.promise } }
    if (current.includes(probe)) return { text: probeReply }
    if (current.includes(later)) { laterRequests.push(request); return { text: acknowledged } }
    if (current.includes(raw)) { callbacks.push(request); return options.onReview?.(request) ?? { text: reviewed } }
    if (initial.includes(question)) {
      initialRequests.push(request)
      if (deferred && !deferred.done) {
        const result = request.toolResults.find(item => item.id === deferred.id)
        if (result) {
          deferred.results.push(result)
          deferred.done = true
        } else {
          const plan = planModelTool(request, deferred.name, {}, deferred.id)
          if ('call' in plan) return { tools: [plan.call] }
          deferred.error = plan.error
          deferred.done = true
        }
      }
      const result = request.toolResults.find(result => result.id === 'im-spawn')
      if (!result) return { tools: [modelTool(request, 'spawn_agent', { name: 'Checker', prompt: assignment }, 'im-spawn')] }
      try { collaboratorReceipt(result) }
      catch (error) { errors.push(String(error)); return { text: 'The collaborator was refused.' } }
      return { text: started }
    }
    errors.push(`Unexpected IM collaboration request ${request.sequence}`)
    return { text: 'No fixture work was requested.' }
  }
  return {
    reply, callbacks, initialRequests, laterRequests, errors, release: gate.release,
    get memberStarted() { return memberStarted },
    get probe() { return deferred },
  }
}

