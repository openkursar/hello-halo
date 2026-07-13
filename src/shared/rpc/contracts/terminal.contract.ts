/**
 * Terminal RPC contract (passthrough). User-facing terminal operations for the
 * canvas TerminalViewer. AI-facing operations go through MCP tools, not here.
 * Event forwarding (terminal:data / terminal:lifecycle) stays outside the
 * contract (see ipc/terminal.ts).
 */
import { rawRpcMethod } from '../define'

export const terminalRpc = {
  listTerminals: rawRpcMethod('terminal:list'),
  createTerminal: rawRpcMethod('terminal:create'),
  terminalInput: rawRpcMethod('terminal:input'),
  terminalResize: rawRpcMethod('terminal:resize'),
  killTerminal: rawRpcMethod('terminal:kill'),
  getTerminalReplay: rawRpcMethod('terminal:replay'),
}
