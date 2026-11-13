import { collaborationValue as value } from './collaboration-values.js';
import { baselineCollaborationDescriptors, baselineCollaborationGuidance, baselineCollaborationToolNames } from './generated/collaboration.js';
import { CollaborationRefusal } from '../collaboration/errors.js';
import type {
  CollaborationCallContext, CollaborationInputs, CollaborationOperations, CollaborationResult,
  CollaborationServer, CollaborationToolDescriptor, CollaborationToolName,
} from '../collaboration/types.js';
import type { PublishedArtifactResolution, PublishedRefStore } from '../collaboration/artifacts.js';
import type { Options } from '../types/config.js';
import type { LocalCollaborationOptions } from '../collaboration/sdk/index.js';

export { CollaborationRefusal } from '../collaboration/errors.js';
export * from '../collaboration/protocol.js';
export type * from '../collaboration/types.js';
export type * from '../collaboration/records.js';
export type { PublishedArtifactResolution, PublishedRefStore } from '../collaboration/artifacts.js';

const descriptors = baselineCollaborationDescriptors as unknown as readonly CollaborationToolDescriptor[];
export const COLLABORATION_GUIDANCE = baselineCollaborationGuidance;
export const COLLABORATION_TOOL_NAMES = Object.freeze([...baselineCollaborationToolNames]);

export function describeCollaborationTool(name: CollaborationToolName): CollaborationToolDescriptor {
  return structuredClone(descriptors.find(tool => tool.name === name)!);
}

export function parseCollaborationInput<K extends CollaborationToolName>(name: K, input: unknown): CollaborationInputs[K] {
  return value('parseInput', { name, input });
}

export function collaborationText(text: string, isError = false): CollaborationResult {
  return value('text', { text, isError });
}

export function localCollaborationSettings(options: Options): LocalCollaborationOptions | false {
  return value('localSettings', options);
}

export function appendCollaborationPrompt(prompt: Options['systemPrompt'], text: string): Options['systemPrompt'] {
  return value('appendPrompt', { prompt, text });
}

export function resolvePublishedArtifact(store: PublishedRefStore, teamId: string, epochId: string, ref: string): PublishedArtifactResolution {
  return value('resolvePublished', { ref, findings: store.listFindingsByEpoch(teamId, epochId), tasks: store.listTasksByEpoch(teamId, epochId) });
}

export function isPublishedArtifactRef(store: PublishedRefStore, teamId: string, epochId: string, ref: string): boolean {
  return resolvePublishedArtifact(store, teamId, epochId, ref).kind === 'unique';
}

export function findConflictingPublisher(store: PublishedRefStore, teamId: string, epochId: string, ref: string, claimantAppId: string | null): string | null {
  return value('conflictingPublisher', { ref, claimantAppId, findings: store.listFindingsByEpoch(teamId, epochId), tasks: store.listTasksByEpoch(teamId, epochId) });
}

export function createCollaborationServer(operations: CollaborationOperations): CollaborationServer {
  const registered = new Map(COLLABORATION_TOOL_NAMES.flatMap(name => operations[name] ? [[name, operations[name]] as const] : []));
  return {
    type: 'sdk', name: 'halo-team',
    instance: {
      name: 'halo-team', version: '2.0.0',
      listTools: () => [...registered.keys()].map(describeCollaborationTool),
      async callTool(name, input, context: CollaborationCallContext = {}) {
        const operation = registered.get(name as CollaborationToolName);
        if (!operation) return undefined;
        let parsed;
        try { parsed = parseCollaborationInput(name as CollaborationToolName, input); }
        catch (error) {
          console.warn(`[Collaboration] Arguments rejected: tool=${name}`);
          return collaborationText(error instanceof Error ? error.message : value<string>('feedback', { kind: 'invalid' }), true);
        }
        if (context.signal?.aborted) {
          console.warn(`[Collaboration] Cancelled before execution: tool=${name}`);
          return collaborationText(value<string>('feedback', { kind: 'cancelled' }), true);
        }
        try { return await operation(parsed as never, context); }
        catch (error) {
          if (error instanceof CollaborationRefusal) return collaborationText(error.message, true);
          console.error(`[Collaboration] Operation failed: tool=${name}`, error);
          return collaborationText(value<string>('feedback', { kind: 'failed' }), true);
        }
      },
    },
  };
}
