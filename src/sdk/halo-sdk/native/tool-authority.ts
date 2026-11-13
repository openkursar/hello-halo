import type { ToolContext, ToolResult } from '../types/tool.js';

type Execute = (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
const authorities = new WeakMap<ToolContext, Execute>();
export function registerToolAuthority(context: ToolContext, execute: Execute): void { authorities.set(context, execute); }
export function toolAuthority(context: ToolContext): Execute | undefined { return authorities.get(context); }

type Formatter = (method: string, value: unknown) => ToolResult;
const formatters = new WeakMap<ToolContext, Formatter>();
export function registerToolFormatter(context: ToolContext, format: Formatter): void { formatters.set(context, format); }
export function toolFormatter(context: ToolContext): Formatter | undefined { return formatters.get(context); }
