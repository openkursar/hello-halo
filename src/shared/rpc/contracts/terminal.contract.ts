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
  // Viewer flow control: attach/detach mark a live consumer of terminal:data;
  // ack reports rendered chars so a flooding pty can be paused.
  terminalAttach: rawRpcMethod('terminal:attach'),
  terminalDetach: rawRpcMethod('terminal:detach'),
  terminalAck: rawRpcMethod('terminal:ack'),
}
