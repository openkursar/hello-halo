/**
 * Canvas show — lets the AI bring its page, a terminal or a file in front of
 * the user. See sdk-mcp-server.ts for the tool and service.ts for how clients
 * answer.
 */

export { createCanvasMcpServer, CANVAS_SHOW_DESCRIPTION, type CanvasToolScope } from './sdk-mcp-server'
export {
  onCanvasShowRequest,
  expectCanvasShowReplies,
  receiveCanvasShowReply,
  type CanvasShowOutcome,
} from './service'
