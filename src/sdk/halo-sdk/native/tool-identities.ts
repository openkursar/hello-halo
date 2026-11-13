import type { Tool } from '../types/tool.js';

const implementations = new WeakMap<Tool['execute'], { name: string; concurrency: WeakSet<NonNullable<Tool['isConcurrencySafe']>>; noClassifier: boolean; concurrencySafe?: boolean }>();
export function registerNativeTool(tool: Tool, name: string, concurrencySafe?: boolean): void {
  let implementation = implementations.get(tool.execute);
  if (!implementation) { implementation = { name, concurrency: new WeakSet(), noClassifier: tool.isConcurrencySafe === undefined, concurrencySafe }; implementations.set(tool.execute, implementation); }
  if (tool.isConcurrencySafe) implementation.concurrency.add(tool.isConcurrencySafe);
}
export function nativeToolImplementation(tool: Tool): { name: string; concurrencySafe?: boolean; nativeConcurrency: boolean } | undefined {
  const implementation = implementations.get(tool.execute);
  return implementation ? { name: implementation.name, concurrencySafe: implementation.concurrencySafe,
    nativeConcurrency: tool.isConcurrencySafe ? implementation.concurrency.has(tool.isConcurrencySafe) : implementation.noClassifier } : undefined;
}

const definitions = new WeakMap<Tool, { resource: string; snapshot: string }>();
function definitionSnapshot(tool: { name?: unknown; description?: unknown; inputSchema?: unknown }): string {
  return JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
}
export function registerNativeToolDefinition(tool: Tool, resource: 'CodeSearchDefinition'): void {
  definitions.set(tool, { resource, snapshot: definitionSnapshot(tool) });
}
export function nativeToolDefinition(tool: Tool, encoded: Record<string, unknown>): string | undefined {
  const definition = definitions.get(tool);
  return definition && definition.snapshot === definitionSnapshot(encoded) ? definition.resource : undefined;
}
