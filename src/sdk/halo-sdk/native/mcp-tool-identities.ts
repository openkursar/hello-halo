import type { Tool } from '../types/tool.js';

export interface McpToolRegistration {
  descriptor: Record<string, any>;
  invoke(input: Record<string, unknown>, signal: AbortSignal): unknown;
}
const tools = new WeakMap<Tool['execute'], McpToolRegistration>();
export function registerMcpTool(tool: Tool, registration: McpToolRegistration): void { tools.set(tool.execute, registration); }
export function mcpToolRegistration(tool: Tool): McpToolRegistration | undefined { return tools.get(tool.execute); }
