import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../../../stores/chat.store'
import { useRemoteSubscription } from '../../../hooks/useRemoteSubscription'
import { buildTeamSessionKey } from '../../../../shared/apps/im-keys'
import { observeExecution, type ExecutionState } from './execution-state'

export function useExecutionState(teamId: string, epochId: string, appId: string, remote: boolean) {
  const conversationId = buildTeamSessionKey(appId, teamId, epochId)
  useRemoteSubscription(conversationId)
  const live = useChatStore(state => state.getSession(conversationId))
  const [state, setState] = useState<ExecutionState>({ snapshot: null, failed: false, now: Date.now(), requestedAt: -Infinity })
  useEffect(() => {
    setState({ snapshot: null, failed: false, now: Date.now(), requestedAt: -Infinity })
    if (remote) {
      const timer = setInterval(() => setState(current => ({ ...current, now: Date.now(), requestedAt: -Infinity })), 15000)
      return () => clearInterval(timer)
    }
    return observeExecution(appId, conversationId, setState)
  }, [appId, conversationId, remote])
  const boundary = useRef({ conversationId, active: live.isGenerating, at: live.isGenerating ? Date.now() : -Infinity })
  if (boundary.current.conversationId !== conversationId || boundary.current.active !== live.isGenerating) {
    boundary.current = { conversationId, active: live.isGenerating, at: Date.now() }
  }
  const active = state.snapshot && state.requestedAt > boundary.current.at ? state.snapshot.isActive : live.isGenerating
  const thoughts = live.isGenerating && live.thoughts.length ? live.thoughts : state.snapshot?.thoughts ?? []
  return { active, thoughts, now: state.now, failed: state.failed,
    available: remote ? live.isGenerating : state.snapshot !== null, live }
}
