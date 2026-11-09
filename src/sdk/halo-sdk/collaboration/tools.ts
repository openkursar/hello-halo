import { COLLABORATION_TOOL_NAMES, describeCollaborationTool, parseCollaborationInput } from './tool-contract.js';
import { CollaborationRefusal } from './errors.js';
import type {
  CollaborationCallContext,
  CollaborationOperations,
  CollaborationResult,
  CollaborationServer,
  CollaborationToolName,
} from './types.js';

export function collaborationText(text: string, isError = false): CollaborationResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** Installs only host-authorized operations; tool inputs never select their authority or scope. */
export function createCollaborationServer(operations: CollaborationOperations): CollaborationServer {
  const registered = new Map<CollaborationToolName, (input: unknown, context: CollaborationCallContext) => Promise<CollaborationResult>>();
  function register<K extends CollaborationToolName>(name: K): void {
    const operation = operations[name];
    if (!operation) return;
    registered.set(name, async (input, context) => {
      let parsed;
      try {
        parsed = parseCollaborationInput(name, input);
      } catch (error) {
        console.warn(`[Collaboration] Arguments rejected: tool=${name}`);
        return collaborationText(error instanceof Error ? error.message : 'Invalid arguments.', true);
      }
      if (context.signal?.aborted) {
        console.warn(`[Collaboration] Cancelled before execution: tool=${name}`);
        return collaborationText('Request cancelled before execution.', true);
      }
      try {
        return await operation(parsed, context);
      } catch (error) {
        if (error instanceof CollaborationRefusal) return collaborationText(error.message, true);
        console.error(`[Collaboration] Operation failed: tool=${name}`, error);
        return collaborationText('The collaboration operation failed. Check its current state before retrying; an external action may already have occurred.', true);
      }
    });
  }
  for (const name of COLLABORATION_TOOL_NAMES) register(name);
  return {
    type: 'sdk',
    name: 'halo-team',
    instance: {
      name: 'halo-team',
      version: '2.0.0',
      listTools: () => [...registered.keys()].map(describeCollaborationTool),
      async callTool(name, input, context = {}) {
        return registered.get(name as CollaborationToolName)?.(input, context);
      },
    },
  };
}
