import { collaborationValue as value } from './collaboration-values.js';
import { baselineCollaborationDescriptors, baselineCollaborationGuidance, baselineCollaborationToolNames } from './generated/collaboration.js';
import { CollaborationRefusal } from '../collaboration/errors.js';
import type {
  CollaborationCallContext, CollaborationInputs, CollaborationOperations, CollaborationResult,
  CollaborationServer, CollaborationToolDescriptor, CollaborationToolName,
} from '../collaboration/types.js';
import type { PublishedArtifactResolution, PublishedRefStore } from '../contracts/collaboration/artifacts.js';
import type { Options } from '../types/config.js';
import type { LocalCollaborationOptions } from '../contracts/collaboration/sdk/index.js';
import type { CollaborationServerOptions, ModelSelectionCapability } from '../contracts/collaboration/model-selection.js';

export { CollaborationRefusal } from '../collaboration/errors.js';
export * from '../collaboration/protocol.js';
export type * from '../collaboration/types.js';
export type * from '../collaboration/records.js';
export type { PublishedArtifactResolution, PublishedRefStore } from '../contracts/collaboration/artifacts.js';

const descriptors = baselineCollaborationDescriptors as unknown as readonly CollaborationToolDescriptor[];
export const COLLABORATION_GUIDANCE = baselineCollaborationGuidance;
export const COLLABORATION_TOOL_NAMES = Object.freeze([...baselineCollaborationToolNames]);

export function describeCollaborationTool(name: CollaborationToolName, options: CollaborationServerOptions = {}): CollaborationToolDescriptor {
  if (options.modelSelection) return value('describeTool', { name, modelSelection: options.modelSelection });
  const descriptor = descriptors.find(tool => tool.name === name);
  if (!descriptor) throw new CollaborationRefusal('model_selection_unavailable', 'Model selection capability is not registered.');
  return structuredClone(descriptor);
}

export function parseCollaborationInput<K extends CollaborationToolName>(name: K, input: unknown, options: CollaborationServerOptions = {}): CollaborationInputs[K] {
  return value('parseInput', { name, input, ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}) });
}

function parseCollaborationArguments(name: CollaborationToolName, input: unknown, options: CollaborationServerOptions, hasModelDirectory: boolean): { input: unknown; notice: string | null } {
  return value('parseArguments', { name, input, hasModelDirectory, ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}) });
}

export function modelSelectionGuidance(capability: ModelSelectionCapability): string {
  return value('modelSelectionGuidance', capability);
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

export function createCollaborationServer(operations: CollaborationOperations, options: CollaborationServerOptions = {}): CollaborationServer {
  const capability = options.modelSelection ? Object.freeze({ ...options.modelSelection }) : undefined;
  const contract = capability ? { modelSelection: capability } : {};
  const names: readonly CollaborationToolName[] = capability
    ? [...COLLABORATION_TOOL_NAMES, 'list_model_profiles']
    : COLLABORATION_TOOL_NAMES;
  const registered = new Map(names.flatMap(name => operations[name] ? [[name, operations[name]] as const] : []));
  const hasModelDirectory = registered.has('list_model_profiles');
  return {
    type: 'sdk', name: 'halo-team',
    instance: {
      name: 'halo-team', version: '2.0.0',
      listTools: () => [...registered.keys()].map(name => describeCollaborationTool(name, contract)),
      async callTool(name, input, context: CollaborationCallContext = {}) {
        const operation = registered.get(name as CollaborationToolName);
        if (!operation) return undefined;
        let parsed;
        try { parsed = parseCollaborationArguments(name as CollaborationToolName, input, contract, hasModelDirectory); }
        catch (error) {
          console.warn(`[Collaboration] Arguments rejected: tool=${name}`);
          return collaborationText(error instanceof Error ? error.message : value<string>('feedback', { kind: 'invalid' }), true);
        }
        if (context.signal?.aborted) {
          console.warn(`[Collaboration] Cancelled before execution: tool=${name}`);
          return collaborationText(value<string>('feedback', { kind: 'cancelled' }), true);
        }
        try {
          const result = await operation(parsed.input as never, context);
          if (!parsed.notice || result?.isError || !Array.isArray(result?.content) || !result.content.length) return result;
          return { ...result, content: [...result.content, { type: 'text', text: parsed.notice }] };
        }
        catch (error) {
          if (error instanceof CollaborationRefusal) return collaborationText(error.message, true);
          if (error instanceof Error && 'code' in error && error.code === 'MODEL_SELECTION') {
            console.warn(`[Collaboration] Model selection rejected: stage=operation tool=${name}`);
            return collaborationText(error.message, true);
          }
          console.error(`[Collaboration] Operation failed: tool=${name}`, error);
          return collaborationText(value<string>('feedback', { kind: 'failed' }), true);
        }
      },
    },
  };
}
