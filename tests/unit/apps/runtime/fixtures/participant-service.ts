import { parseAppChatKey, parseNativeChatKey, parseTeamSessionKey } from '../../../../../src/shared/apps/im-keys'
import type { CollaborationCaller } from '../../../../../src/main/apps/team'

/** Admission double for app-chat tests; only explicitly registered work exists. */
export function createScopedParticipantService() {
  const scopes = new Set<string>()
  const actors = new Set<string>()
  const requests = new Set<string>()
  const assigned = new Map<string, string>()
  const sourceRequests = new Map<string, string>()
  let revision = 0
  const key = (teamId: string, epochId: string, appId: string) => JSON.stringify([teamId, epochId, appId])
  const valid = (caller: { teamId: string; epochId: string; callerAppId?: string; appId?: string }) =>
    scopes.has(key(caller.teamId, caller.epochId, caller.callerAppId ?? caller.appId ?? ''))
  const assert = (caller: CollaborationCaller) => {
    if (!valid(caller)) throw new Error('This fixture has no authority for the requested work.')
  }
  const validSource = (conversationId: string) => {
    const team = parseTeamSessionKey(conversationId)
    if (team) return valid(team)
    const appId = parseNativeChatKey(conversationId)?.appId ?? parseAppChatKey(conversationId)?.appId
    return !!appId && actors.has(appId)
  }
  const requestId = (caller: CollaborationCaller) => {
    assert(caller)
    const scope = key(caller.teamId, caller.epochId, caller.callerAppId)
    const id = caller.requestId ?? assigned.get(scope) ?? `fixture-request-${revision}-${assigned.size}`
    assigned.set(scope, id)
    requests.add(id)
    return id
  }
  const requestAllowed = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) ||
    [...requests].some(accepted => id === accepted || id.startsWith(`${accepted}/`))
  return {
    allow(teamId: string, epochId: string, appId: string) { scopes.add(key(teamId, epochId, appId)); actors.add(appId) },
    reset() { revision++; scopes.clear(); actors.clear(); requests.clear(); assigned.clear(); sourceRequests.clear() },
    service: {
      registerSource(conversationId: string) { if (!validSource(conversationId)) throw new Error('Unknown fixture source.') },
      sourceGeneration(conversationId: string) { if (!validSource(conversationId)) throw new Error('Unknown fixture source.'); return revision },
      sourceRequestId(conversationId: string) {
        if (!validSource(conversationId)) throw new Error('Unknown fixture source.')
        const id = sourceRequests.get(conversationId) ?? `fixture-source-${sourceRequests.size}`
        sourceRequests.set(conversationId, id); requests.add(id); return id
      },
      acceptRecipientFence(target: { teamId: string; epochId: string; appId: string }, fence: unknown) { return valid(target) && (fence === undefined || fence === 'initial') },
      adoptRequest(caller: CollaborationCaller, id: string) { if (!valid(caller) || !id) return false; return requestId({ ...caller, requestId: id }) },
      requestAllowed,
      requestId,
      generation(caller: CollaborationCaller) { assert(caller); return `${revision}:${key(caller.teamId, caller.epochId, caller.callerAppId)}` },
      capture(caller: CollaborationCaller) {
        assert(caller)
        const id = requestId(caller)
        return () => { assert(caller); if (!requestAllowed(id)) throw new Error('Fixture request no longer exists.') }
      },
      reportGuard(teamId: string, epochId: string, id?: string) {
        return () => [...actors].some(appId => scopes.has(key(teamId, epochId, appId))) && !!id && requestAllowed(id)
      },
    },
  }
}
