import { initialUserInput, type ModelRequest, type ModelReply } from './acceptance-model'
import { securityTool } from './acceptance-subagent-security'

export function scopedDirectoryScript() {
  const ownerResults: string[] = []
  const guestResults: string[] = []
  const guestRequests: ModelRequest[] = []
  const reply = (request: ModelRequest): ModelReply => {
    if (initialUserInput(request).includes('OWNER_DIRECTORY_SCOPE:')) {
      const result = request.toolResults.find(result => result.id === 'owner-scope-directory')
      if (!result) return securityTool(request, 'list_model_profiles', {}, 'owner-scope-directory')
      ownerResults.push(result.text)
      return { text: 'OWNER_SCOPE_DIRECTORY_READY' }
    }
    guestRequests.push(request)
    const result = request.toolResults.find(result => result.id === 'guest-scope-directory')
    if (result) {
      guestResults.push(result.text)
      return { text: 'GUEST_SCOPE_CHECK_COMPLETE' }
    }
    return { tools: [{ id: 'guest-scope-directory', name: 'mcp__halo-team__list_model_profiles', input: {} }] }
  }
  return { reply, ownerResults, guestResults, guestRequests }
}
