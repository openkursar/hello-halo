export type EffectiveReasoning =
  | { version: 1; mode: 'provider-default' }
  | { version: 1; mode: 'off' }
  | { version: 1; mode: 'effort'; effort: string }
  | { version: 1; mode: 'budget'; budgetTokens: number; effort?: string }
  | { version: 1; mode: 'adaptive'; effort?: string };

export interface SpawnModelSelection {
  model_profile?: string;
  reasoning_effort?: string;
}

export interface ModelProfileDescriptor {
  selectionRef: string;
  name: string;
  description: string;
  target: {
    kind: 'single' | 'pool';
    label: string;
    models: readonly string[];
    accountLabel?: string;
  };
  reasoning: {
    supported?: readonly string[];
    profileDefault?: string;
    modelDefault?: string;
  };
  available: boolean;
  unavailableReason?: string;
}

export interface ModelProfileEntry extends Omit<ModelProfileDescriptor, 'selectionRef'> {
  profileId: string;
  profileRevision: string;
}

export interface ModelProfileCatalog {
  revision: string;
  policy: 'inherit' | 'task';
  policyRevision: string;
  profiles: readonly ModelProfileEntry[];
}

export interface ParentModelBinding {
  bindingId: string;
  restoreRef: string;
  model: string;
  reasoning: EffectiveReasoning;
}

export type ModelChoicePlan = {
  parent: ParentModelBinding;
  policyRevision: string;
  requestedEffort?: string;
} & (
  | { selection: { kind: 'inherit' }; target?: never; profileDefaultEffort?: never }
  | {
      selection: { kind: 'profile'; profileId: string; profileRevision: string; selectionRef: string };
      target: { kind: 'single' | 'pool'; models: readonly string[] };
      profileDefaultEffort?: string;
    }
);

export interface PreparedModelMetadata {
  bindingId: string;
  restoreRef: string;
  model: string;
  targetKind: 'single' | 'pool';
  contextWindow: number;
  maxOutputTokens: number;
  modalities: readonly string[];
  reasoning: {
    supported?: readonly string[];
    default: EffectiveReasoning;
    effortMapping?: Readonly<Record<string, EffectiveReasoning>>;
    modes?: readonly EffectiveReasoning['mode'][];
    maxBudgetTokens?: number;
  };
}

export interface ModelSelectionSnapshot {
  version: 1;
  selection: ModelChoicePlan['selection'];
  bindingId: string;
  restoreRef: string;
  model: string;
  targetKind: 'single' | 'pool';
  reasoning: EffectiveReasoning;
}

export interface ListModelProfilesInput {
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface ModelProfileQueryResult {
  revision: string;
  policy: ModelProfileCatalog['policy'];
  policyRevision: string;
  parent: Pick<ParentModelBinding, 'model' | 'reasoning'>;
  profiles: readonly ModelProfileDescriptor[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface PlanModelSelectionInput {
  input: SpawnModelSelection;
  parent: ParentModelBinding;
  catalog: ModelProfileCatalog;
  policyRevision: string;
}

export interface FinalizeModelSelectionInput {
  plan: ModelChoicePlan;
  binding: PreparedModelMetadata;
}

export interface QueryModelProfilesInput {
  catalog: ModelProfileCatalog;
  parent: ParentModelBinding;
  policyRevision: string;
  input: ListModelProfilesInput;
}

export interface ModelSelectionCapability {
  policy: ModelProfileCatalog['policy'];
  policyRevision?: string;
}

export interface CollaborationServerOptions {
  modelSelection?: ModelSelectionCapability;
}
