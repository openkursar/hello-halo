import { collaboratorReceipt, hasRetiredDailyTeamTool } from './acceptance-collaboration'
import { initialUserInput, latestUserInput, createModelGate, modelTool, type ModelRequest, type ModelReply } from './acceptance-model'

export const question = 'Ask one collaborator to check alpha and bring the conclusion back to this group.'
export const later = 'A different sender is here now. Just acknowledge this message.'
export const started = 'The collaborator is checking alpha.'
export const acknowledged = 'The later sender was acknowledged.'
export const assignment = 'IM_MEMBER_ASSIGNMENT: Check alpha independently and report your result.'
export const raw = 'UNREVIEWED_COLLABORATOR_EVIDENCE_769'
export const reviewed = 'I reviewed the collaborator’s evidence: alpha is confirmed.'
export const probe = 'Confirm this group can continue with a fresh human request.'
export const probeReply = 'This group can continue.'

export function createImCollaborationScript(options: { onReview?: (request: ModelRequest) => ModelReply | undefined } = {}) {
  const gate = createModelGate()
  const errors: string[] = []
  const callbacks: ModelRequest[] = []
  const initialRequests: ModelRequest[] = []
  const laterRequests: ModelRequest[] = []
  let memberStarted = false
  const reply = (request: ModelRequest) => {
    if (hasRetiredDailyTeamTool(request)) errors.push('A retired team tool was advertised.')
    const initial = initialUserInput(request)
    const current = latestUserInput(request)
    if (initial.includes(assignment)) { memberStarted = true; return { text: raw, hold: gate.promise } }
    if (current.includes(probe)) return { text: probeReply }
    if (current.includes(later)) { laterRequests.push(request); return { text: acknowledged } }
    if (current.includes(raw)) { callbacks.push(request); return options.onReview?.(request) ?? { text: reviewed } }
    if (initial.includes(question)) {
      initialRequests.push(request)
      const result = request.toolResults.find(result => result.id === 'im-spawn')
      if (!result) return { tools: [modelTool(request, 'spawn_agent', { name: 'Checker', prompt: assignment }, 'im-spawn')] }
      try { collaboratorReceipt(result) }
      catch (error) { errors.push(String(error)); return { text: 'The collaborator was refused.' } }
      return { text: started }
    }
    errors.push(`Unexpected IM collaboration request ${request.sequence}`)
    return { text: 'No fixture work was requested.' }
  }
  return { reply, callbacks, initialRequests, laterRequests, errors, release: gate.release, get memberStarted() { return memberStarted } }
}

