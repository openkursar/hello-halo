/**
 * Agent RPC contract (passthrough). Request/response agent operations
 * (send, stop, session state, capabilities, MCP test). Handler bodies build
 * their own envelopes, so these are raw passthrough. Event forwarding
 * (onAgentEvent / onAgentBroadcast) stays outside the contract.
 */
import { rawRpcMethod } from '../define'

export const agentRpc = {
  sendMessage: rawRpcMethod('agent:send-message'),
  stopGeneration: rawRpcMethod('agent:stop'),
  approveTool: rawRpcMethod('agent:approve-tool'),
  rejectTool: rawRpcMethod('agent:reject-tool'),
  getSessionState: rawRpcMethod('agent:get-session-state'),
  ensureSessionWarm: rawRpcMethod('agent:ensure-session-warm'),
  answerQuestion: rawRpcMethod('agent:answer-question'),
  getEngineCapabilities: rawRpcMethod('agent:get-engine-capabilities'),
  injectMessage: rawRpcMethod('agent:inject-message'),
  testMcpConnections: rawRpcMethod('agent:test-mcp'),
  // Toolset broker (on-demand MCP toolsets)
  listToolsets: rawRpcMethod('agent:toolsets-list'),
  openToolset: rawRpcMethod('agent:toolsets-open'),
  closeToolset: rawRpcMethod('agent:toolsets-close'),
}
