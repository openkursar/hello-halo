import { initialUserInput, type ModelRequest, type ModelReply } from './acceptance-model'
import { decodeSecurityResult, securityTool } from './acceptance-subagent-security'

export function scopedDirectoryScript() {
  let cursor: string | undefined
  const ownerResults: string[] = []
  const guestResults: string[] = []
  const guestRequests: ModelRequest[] = []
  const reply = (request: ModelRequest): ModelReply => {
    if (initialUserInput(request).includes('OWNER_DIRECTORY_SCOPE:')) {
      const result = request.toolResults.find(result => result.id === 'owner-scope-page')
      if (!result) return securityTool(request, 'list_model_profiles', { limit: 1 }, 'owner-scope-page')
      ownerResults.push(result.text)
      cursor = decodeSecurityResult(result.text).nextCursor
      return { text: 'OWNER_SCOPE_CURSOR_READY' }
    }
    guestRequests.push(request)
    const result = request.toolResults.find(result => result.id === 'guest-scope-page')
    if (result) {
      guestResults.push(result.text)
      return { text: 'GUEST_SCOPE_CHECK_COMPLETE' }
    }
    return { tools: [{ id: 'guest-scope-page', name: 'mcp__halo-team__list_model_profiles', input: { limit: 1, cursor } }] }
  }
  return { reply, ownerResults, guestResults, guestRequests, get cursor() { return cursor } }
}
