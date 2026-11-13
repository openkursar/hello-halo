import type { Tool, ToolContext, ToolResult } from '../types/tool.js';
import { getLogger } from '../utils/logger.js';
import { NativeCallbacks } from './callbacks.js';
import { loadBinding, nativeError, parseNativeValue, stringifyNativeValue, type NativeToolOwnerHandle } from './binding.js';
import { runPublic } from './operation.js';
import { registerNativeTool } from './tool-identities.js';
import { toolAuthority } from './tool-authority.js';

interface Descriptor { name: string; description: string; inputSchema: Record<string, unknown>; permissionLevel: Tool['permissionLevel'];
  requiresUserInteraction?: boolean; concurrencySafe: boolean; freshInstance: boolean }
const owners = new Map<string, NativeToolOwnerHandle>();
let maintenance: ReturnType<typeof setInterval> | undefined;
let pending = 0;

function owner(sessionId: string): NativeToolOwnerHandle {
  let value = owners.get(sessionId);
  if (!value) {
    value = new (loadBinding().NativeToolOwner)(sessionId); owners.set(sessionId, value);
    if (!maintenance) {
      maintenance = setInterval(() => getLogger('NativeTools').info('Direct tool state', { owners: owners.size, pending }), 300_000);
      maintenance.unref();
    }
  }
  return value;
}
export async function releaseNativeToolOwner(sessionId: string): Promise<void> {
  const value = owners.get(sessionId); if (!value) return;
  owners.delete(sessionId); if (!owners.size) { clearInterval(maintenance); maintenance = undefined; }
  try { await value.close(); } catch (error) { throw nativeError(error); }
}
async function execute(name: string, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const active = toolAuthority(context); if (active) return active(name, input);
  const callbacks = new NativeCallbacks(); callbacks.bindDirectContext(context);
  const readState = context.readFileState;
  const data = { sessionId: context.sessionId, cwd: context.cwd, env: context.env, currentTurn: context.currentTurn, toolUseId: context.toolUseId,
    conventions: context.conventions, additionalDirectories: context.additionalDirectories, readDenyRoots: context.readDenyRoots, skillCatalog: context.skillCatalog,
    nativeOwner: { readFileStatePresent: Boolean(context.readFileState), externalReadFileState: Boolean(context.readFileState),
      backgroundTasksPresent: Boolean(context.services?.backgroundTasks), externalBackgroundTasks: Boolean(context.services?.backgroundTasks),
      externalToolMessages: Boolean(context.onToolMessage), ...(context.recordFileChange ? { recordFileChange: context.recordFileChange.bind(context) } : {}) },
  };
  pending++;
  try {
    return await runPublic<ToolResult>('tools.execute', data, input, context.abortSignal, { callbacks, advisoryCancellation: true,
      createHandle: (options, payload) => owner(context.sessionId).execute(name, payload, options,
        readState ? path => callbacks.captureDirectReadState(path) : undefined) });
  } finally { pending--; }
}

let factories: (() => Tool)[] | undefined;
function factoriesForTools(): (() => Tool)[] {
  if (factories) return factories;
  const descriptors = parseNativeValue(loadBinding().nativeValue('tools.descriptors', '[]')) as Descriptor[];
  factories = descriptors.map(descriptor => {
    const fields = { name: descriptor.name, description: descriptor.description, inputSchema: descriptor.inputSchema, permissionLevel: descriptor.permissionLevel,
      ...(descriptor.requiresUserInteraction ? { requiresUserInteraction: true } : {}) };
    if (descriptor.freshInstance) {
      class BuiltinTool implements Tool {
        readonly name = fields.name;
        readonly description = fields.description;
        readonly inputSchema = fields.inputSchema;
        readonly permissionLevel = fields.permissionLevel;
        constructor() { if (descriptor.concurrencySafe) Object.assign(this, { isConcurrencySafe: () => true }); registerNativeTool(this, descriptor.name, descriptor.concurrencySafe); }
        execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> { return execute(descriptor.name, input, context); }
      }
      Object.defineProperty(BuiltinTool, 'name', { value: `${descriptor.name}Tool` });
      return () => new BuiltinTool();
    }
    const tool: Tool = { ...fields, ...(descriptor.concurrencySafe ? { isConcurrencySafe: () => true } : {}), execute: (input, context) => execute(descriptor.name, input, context) };
    registerNativeTool(tool, descriptor.name, descriptor.concurrencySafe); return () => tool;
  });
  return factories;
}
export function getAllTools(): Tool[] { return factoriesForTools().map(create => create()); }
export function filterTools(allTools: Tool[], options?: { allowedTools?: string[]; disallowedTools?: string[] }): Tool[] {
  const receipt = parseNativeValue(loadBinding().nativeValue('tools.filter', stringifyNativeValue([allTools.map(tool => tool.name), options]))) as { sameArray: boolean; indices: number[] };
  return receipt.sameArray ? allTools : receipt.indices.map(index => allTools[index]);
}
export function findToolByName(tools: Tool[], name: string): Tool | undefined {
  const index = parseNativeValue(loadBinding().nativeValue('tools.find', stringifyNativeValue([tools.map(tool => tool.name), name]))) as number | undefined;
  return index === undefined ? undefined : tools[index];
}
