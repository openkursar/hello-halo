/**
 * services/agent/execution — public surface.
 *
 * Every entry that delegates work opens an execution with its context (who the
 * work is for, who asked, where results go). A headless entry also binds its
 * engine session and submits its messages. A conversation entry only mounts the
 * tools: a digital human's or team member's turn closes its execution when the
 * turn ends, releasing that turn's endpoint. A person's space conversation has no
 * execution: its server lives with the engine session's toolset. Delegated work, its input, completion,
 * stopping and usage are the execution's. A conversation's collaborators outlive
 * its turns, so `bindConversationLifecycle` bridges the conversation's own stop and
 * admission to `ConversationWorkHost`. The application layer implements both hosts.
 */

export { openAgentExecution } from './agent-execution'
export { bindConversationLifecycle } from './conversation-lifecycle'
export { ENGINE_STOP_GRACE_MS } from './engine-stop'
export type {
  AgentExecution,
  AgentExecutionOptions,
  AuthorizedInput,
  ChannelOrigin,
  ConversationWorkHost,
  ExecutionBinding,
  ExecutionEngineControl,
  ExecutionInputPort,
  ExecutionPrincipal,
  ExecutionReader,
  ExecutionRequester,
  ExecutionSessionHandle,
  ExecutionSessionPort,
  ExecutionSource,
  ExecutionWorkHost,
  ExecutionWorkRequest,
  InputDisposition,
  MemberTurn,
  OwnedWork,
} from './types'
