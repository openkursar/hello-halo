import { loadBinding, nativeError } from '../native/binding.js';
import { collaborationValue } from '../native/collaboration-values.js';
import type {
  EffectiveReasoning, FinalizeModelSelectionInput, ModelChoicePlan,
  ModelProfileCatalog, ModelProfileQueryResult, ModelSelectionSnapshot, PlanModelSelectionInput,
  QueryModelProfilesInput,
} from '../contracts/collaboration/model-selection.js';

export type * from '../contracts/collaboration/model-selection.js';

export class ModelProfileCatalogView {
  private readonly handle: InstanceType<ReturnType<typeof loadBinding>['NativeModelProfileCatalog']>;

  constructor(catalog: ModelProfileCatalog) {
    try { this.handle = new (loadBinding().NativeModelProfileCatalog)(JSON.stringify(catalog)); }
    catch (error) { throw nativeError(error); }
  }

  plan(input: Omit<PlanModelSelectionInput, 'catalog'>): ModelChoicePlan {
    try { return JSON.parse(this.handle.call('plan', JSON.stringify(input))) as ModelChoicePlan; }
    catch (error) { throw nativeError(error); }
  }

  query(input: Omit<QueryModelProfilesInput, 'catalog'>): ModelProfileQueryResult {
    try { return JSON.parse(this.handle.call('query', JSON.stringify(input))) as ModelProfileQueryResult; }
    catch (error) { throw nativeError(error); }
  }

  close(): void {
    try { this.handle.close(); }
    catch (error) { throw nativeError(error); }
  }
}

export function planModelSelection(input: PlanModelSelectionInput): ModelChoicePlan {
  return collaborationValue('planModelSelection', input);
}

export function finalizeModelSelection(input: FinalizeModelSelectionInput): ModelSelectionSnapshot {
  return collaborationValue('finalizeModelSelection', input);
}

export function queryModelProfiles(input: QueryModelProfilesInput): ModelProfileQueryResult {
  return collaborationValue('queryModelProfiles', input);
}

export function validateEffectiveReasoning(input: unknown): EffectiveReasoning {
  return collaborationValue('validateEffectiveReasoning', input);
}

export function validateModelSelectionRestore(input: {
  snapshot: ModelSelectionSnapshot;
  binding: FinalizeModelSelectionInput['binding'];
}): ModelSelectionSnapshot {
  return collaborationValue('validateModelSelectionRestore', input);
}
