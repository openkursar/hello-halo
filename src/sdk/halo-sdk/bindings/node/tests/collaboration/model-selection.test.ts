import { describe, expect, it, vi } from 'vitest';
import {
  collaborationText, createCollaborationServer, finalizeModelSelection,
  ModelProfileCatalogView, modelSelectionGuidance, planModelSelection, queryModelProfiles,
  validateEffectiveReasoning, validateModelSelectionRestore,
} from '../../native/collaboration.js';
import { MODEL_SELECTION_LIMITS } from '../../collaboration/protocol.js';
import type { ModelProfileCatalog, ParentModelBinding, PreparedModelMetadata } from '../../collaboration/protocol.js';

const parent: ParentModelBinding = {
  bindingId: 'parent-binding', restoreRef: 'parent-restore', model: 'parent-model',
  reasoning: { version: 1, mode: 'budget', budgetTokens: 4096, effort: 'high' },
};
const catalog: ModelProfileCatalog = {
  revision: 'catalog-1', policy: 'inherit', policyRevision: 'policy-1',
  profiles: [{
    profileId: 'reviewer', profileRevision: '1', name: 'Reviewer', description: 'Review changes',
    target: { kind: 'single', label: 'Review model', models: ['review-model'] },
    reasoning: { supported: ['low', 'high'], profileDefault: 'low' }, available: true,
  }],
};
const binding: PreparedModelMetadata = {
  bindingId: 'review-binding', restoreRef: 'review-restore', model: 'review-model',
  targetKind: 'single', contextWindow: 32000, maxOutputTokens: 4096, modalities: ['text'],
  reasoning: { supported: ['low', 'high'], default: { version: 1, mode: 'off' } },
};

function plan(input = {}) {
  return planModelSelection({ input, parent, catalog, policyRevision: catalog.policyRevision });
}

function query(input = {}) {
  return queryModelProfiles({ input, parent, catalog, policyRevision: catalog.policyRevision });
}

describe('public model selection contract', () => {
  it('exports the bounded resource contract without loading an execution runtime', () => {
    expect(MODEL_SELECTION_LIMITS).toEqual({
      nameCodePoints: 80, descriptionCodePoints: 1000, queryCodePoints: 200,
      catalogBytes: 1048576, pageDefault: 10, pageMaximum: 20, resultBytes: 16384,
    });
    expect(Object.isFrozen(MODEL_SELECTION_LIMITS)).toBe(true);
  });

  it('retains an immutable catalog view and releases it without affecting other views', () => {
    const mutable = structuredClone(catalog);
    const view = new ModelProfileCatalogView(mutable);
    const other = new ModelProfileCatalogView(catalog);
    const request = { input: {}, parent, policyRevision: catalog.policyRevision };
    try {
      expect(view.query(request)).toEqual(query());
      expect(view.plan(request)).toEqual(plan());
      (mutable.profiles as Array<{ name: string }>)[0].name = 'Changed after construction';
      expect(view.query(request).profiles[0].name).toBe('Reviewer');
      view.close();
      expect(() => view.query(request)).toThrow();
      expect(() => view.plan(request)).toThrow();
      expect(other.query(request).profiles[0].name).toBe('Reviewer');
    } finally { view.close(); other.close(); }
  });

  it('preserves all reasoning modes and rejects contradictory or unknown fields', () => {
    for (const reasoning of [
      { version: 1, mode: 'provider-default' }, { version: 1, mode: 'off' },
      { version: 1, mode: 'effort', effort: 'high' },
      { version: 1, mode: 'budget', budgetTokens: 4096, effort: 'high' },
      { version: 1, mode: 'adaptive', effort: 'high' },
    ]) expect(validateEffectiveReasoning(reasoning)).toEqual(reasoning);
    for (const reasoning of [
      { version: 1, mode: 'off', budgetTokens: 1 },
      { version: 1, mode: 'effort' }, { version: 2, mode: 'off' },
      { version: 1, mode: 'budget', budgetTokens: -1 },
      { version: 1, mode: 'provider-default', apiKey: 'synthetic-secret' },
    ]) expect(() => validateEffectiveReasoning(reasoning)).toThrow();
  });

  it('issues references usable for exact profile planning and applies target defaults once', () => {
    const profile = query().profiles[0];
    expect(query().parent).toEqual({ model: parent.model, reasoning: parent.reasoning });
    expect(profile.name).toBe('Reviewer');
    expect(profile.selectionRef).not.toBe('inherit');
    const choice = plan({ model_profile: profile.selectionRef });
    expect(choice.selection).toEqual({ kind: 'profile', profileId: 'reviewer', profileRevision: '1', selectionRef: profile.selectionRef });
    expect(choice.profileDefaultEffort).toBe('low');
    expect(finalizeModelSelection({ plan: choice, binding }).reasoning).toEqual({ version: 1, mode: 'effort', effort: 'low' });
    expect(finalizeModelSelection({ plan: plan({ model_profile: profile.selectionRef, reasoning_effort: 'high' }), binding }).reasoning)
      .toEqual({ version: 1, mode: 'effort', effort: 'high' });
  });

  it('inherits the direct parent binding and effective reasoning without using profile defaults', () => {
    const snapshot = finalizeModelSelection({
      plan: plan(), binding: {
        ...binding, bindingId: parent.bindingId, restoreRef: parent.restoreRef, model: parent.model,
        maxOutputTokens: 8192,
        reasoning: { ...binding.reasoning, modes: ['budget'], maxBudgetTokens: 4096 },
      },
    });
    expect(snapshot.reasoning).toEqual(parent.reasoning);
    expect(snapshot.selection).toEqual({ kind: 'inherit' });
    expect(snapshot).not.toHaveProperty('contextWindow');
    expect(snapshot).not.toHaveProperty('modalities');
  });

  it('checks declared reasoning modes and budget bounds without silently clamping', () => {
    const inherited: PreparedModelMetadata = {
      ...binding, bindingId: parent.bindingId, restoreRef: parent.restoreRef, model: parent.model,
      maxOutputTokens: 8192,
      reasoning: { default: { version: 1, mode: 'off' }, supported: ['high'], modes: ['budget'], maxBudgetTokens: 4096 },
    };
    expect(finalizeModelSelection({ plan: plan(), binding: inherited }).reasoning).toEqual(parent.reasoning);
    const modeOnly: PreparedModelMetadata = {
      ...inherited, reasoning: { default: { version: 1, mode: 'off' }, modes: ['budget'], maxBudgetTokens: 6000 },
    };
    const budgetOnly = { version: 1, mode: 'budget', budgetTokens: 6000 } as const;
    const budgetPlan = planModelSelection({
      input: {}, parent: { ...parent, reasoning: budgetOnly }, catalog, policyRevision: catalog.policyRevision,
    });
    expect(finalizeModelSelection({ plan: budgetPlan, binding: modeOnly }).reasoning).toEqual(budgetOnly);
    expect(() => finalizeModelSelection({ plan: plan(), binding: modeOnly })).toThrow('reasoning effort');
    expect(() => finalizeModelSelection({ plan: plan(), binding: {
      ...inherited, reasoning: { ...inherited.reasoning, maxBudgetTokens: 4095 },
    } })).toThrow();
    expect(() => finalizeModelSelection({ plan: plan(), binding: { ...inherited, maxOutputTokens: 4096 } })).toThrow();
    expect(() => finalizeModelSelection({ plan: plan(), binding: {
      ...inherited, reasoning: { ...inherited.reasoning, modes: ['off'] },
    } })).toThrow();
    expect(() => finalizeModelSelection({ plan: plan(), binding: {
      ...inherited, reasoning: { ...inherited.reasoning, modes: ['budget', 'budget'] },
    } })).toThrow();
  });

  it('restores only the recorded logical binding and reasoning', () => {
    const profile = query().profiles[0];
    const snapshot = finalizeModelSelection({ plan: plan({ model_profile: profile.selectionRef }), binding });
    expect(validateModelSelectionRestore({ snapshot, binding })).toEqual(snapshot);
    expect(() => validateModelSelectionRestore({ snapshot, binding: { ...binding, bindingId: 'replacement' } })).toThrow();
    expect(() => validateModelSelectionRestore({ snapshot, binding: { ...binding, model: 'replacement-model' } })).toThrow();
    expect(() => validateModelSelectionRestore({
      snapshot, binding: { ...binding, reasoning: { default: { version: 1, mode: 'off' }, supported: ['high'] } },
    })).toThrow();
  });

  it('keeps large catalogs reachable through bounded pages and invalidates stale cursors', () => {
    const largeCatalog: ModelProfileCatalog = {
      ...catalog,
      profiles: Array.from({ length: 35 }, (_, index) => ({
        ...catalog.profiles[0], profileId: `profile-${index}`, name: `Profile ${index}`,
      })),
    };
    let cursor: string | undefined;
    const references = new Set<string>();
    do {
      const page = queryModelProfiles({ catalog: largeCatalog, parent, policyRevision: catalog.policyRevision, input: { limit: 10, cursor } });
      expect(page.profiles.length).toBeLessThanOrEqual(10);
      for (const profile of page.profiles) references.add(profile.selectionRef);
      cursor = page.nextCursor;
      expect(page.hasMore).toBe(Boolean(cursor));
    } while (cursor);
    expect(references.size).toBe(35);
    const first = queryModelProfiles({ catalog: largeCatalog, parent, policyRevision: catalog.policyRevision, input: { limit: 10 } });
    expect(() => queryModelProfiles({
      catalog: { ...largeCatalog, revision: 'catalog-2' }, parent, policyRevision: catalog.policyRevision,
      input: { cursor: first.nextCursor },
    })).toThrow();
    expect(() => query({ query: 'x'.repeat(MODEL_SELECTION_LIMITS.queryCodePoints + 1) })).toThrow();
  });

  it('binds cursors to the query and authorized catalog without accepting them as selection references', () => {
    const scoped: ModelProfileCatalog = {
      ...catalog,
      profiles: Array.from({ length: 3 }, (_, index) => ({
        ...catalog.profiles[0], profileId: `scope-${index}`, name: `Scope ${index}`,
      })),
    };
    const request = { catalog: scoped, parent, policyRevision: scoped.policyRevision };
    const first = queryModelProfiles({ ...request, input: { query: 'scope', limit: 1 } });
    expect(first.nextCursor).toBeTruthy();
    expect(queryModelProfiles({ ...request, input: { query: ' SCOPE ', cursor: first.nextCursor } }).profiles).toHaveLength(2);
    expect(() => queryModelProfiles({ ...request, input: { query: 'review', cursor: first.nextCursor } })).toThrow();
    expect(() => queryModelProfiles({ ...request, catalog: { ...scoped, profiles: scoped.profiles.slice(1) },
      input: { query: 'scope', cursor: first.nextCursor } })).toThrow();
    expect(() => queryModelProfiles({ ...request, catalog: { ...scoped, policyRevision: 'policy-two' },
      policyRevision: 'policy-two', input: { query: 'scope', cursor: first.nextCursor } })).toThrow();
    expect(() => planModelSelection({ ...request, input: { model_profile: first.nextCursor } })).toThrow();
    expect(() => queryModelProfiles({ ...request, input: { cursor: first.profiles[0].selectionRef } })).toThrow();
  });

  it('counts Unicode code points while bounding complete escaped pages and total catalog bytes', () => {
    const bounded: ModelProfileCatalog = {
      ...catalog,
      profiles: Array.from({ length: 20 }, (_, index) => ({
        ...catalog.profiles[0], profileId: `unicode-${index}`, name: '🧪'.repeat(80),
        description: '\u0000'.repeat(1000),
      })),
    };
    const request = { catalog: bounded, parent, policyRevision: bounded.policyRevision };
    const view = new ModelProfileCatalogView(bounded);
    const references = new Set<string>();
    let cursor: string | undefined;
    try {
      do {
        const page = view.query({ parent, policyRevision: bounded.policyRevision, input: { limit: 20, cursor } });
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MODEL_SELECTION_LIMITS.resultBytes);
        for (const profile of page.profiles) {
          expect(profile.name).toBe('🧪'.repeat(80));
          expect(profile.description).toBe('\u0000'.repeat(1000));
          references.add(profile.selectionRef);
        }
        cursor = page.nextCursor;
      } while (cursor);
      expect(references.size).toBe(20);
      expect(view.query({ parent, policyRevision: bounded.policyRevision, input: { query: '🧪'.repeat(200) } }).profiles).toEqual([]);
      expect(() => view.query({ parent, policyRevision: bounded.policyRevision, input: { query: '🧪'.repeat(201) } })).toThrow();
    } finally { view.close(); }
    for (const invalidProfile of [
      { ...bounded.profiles[0], name: '🧪'.repeat(81) },
      { ...bounded.profiles[0], description: '\u0000'.repeat(1001) },
    ]) expect(() => new ModelProfileCatalogView({ ...bounded, profiles: [invalidProfile] })).toThrow();
    expect(() => queryModelProfiles({ ...request, catalog: {
      ...bounded, profiles: Array.from({ length: 200 }, (_, index) => ({ ...bounded.profiles[0], profileId: `oversized-${index}` })),
    }, input: {} })).toThrow('byte limit');
  });

  it('refuses raw model identifiers, stale policy overrides and unsupported effort', () => {
    expect(() => plan({ model_profile: 'review-model' })).toThrow();
    expect(() => planModelSelection({ input: { reasoning_effort: 'high' }, parent, catalog, policyRevision: 'old-policy' })).toThrow();
    expect(() => queryModelProfiles({ input: {}, parent, catalog, policyRevision: 'old-policy' })).toThrow();
    expect(() => finalizeModelSelection({ plan: plan({ reasoning_effort: 'unknown' }), binding })).toThrow();
    expect(planModelSelection({ input: {}, parent, catalog, policyRevision: 'old-policy' }).selection).toEqual({ kind: 'inherit' });
  });

  it('gates new tool declarations and parsing on explicit capability registration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const spawn = vi.fn(async () => collaborationText('accepted'));
      const list = vi.fn(async () => collaborationText('catalog'));
      const operations = { spawn_agent: spawn, list_model_profiles: list };
      const baseline = createCollaborationServer(operations);
      expect(baseline.instance.listTools().map(tool => tool.name)).toEqual(['spawn_agent']);
      expect(await baseline.instance.callTool('list_model_profiles', {})).toBeUndefined();
      expect((await baseline.instance.callTool('spawn_agent', { prompt: 'work', model_profile: 'inherit' }))?.isError).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
      const server = createCollaborationServer(operations, { modelSelection: { policy: 'inherit', policyRevision: 'policy-1' } });
      expect(server.instance.listTools().map(tool => tool.name)).toEqual(['spawn_agent', 'list_model_profiles']);
      await server.instance.callTool('spawn_agent', { prompt: 'work', model_profile: 'inherit', reasoning_effort: 'high' });
      expect(spawn).toHaveBeenCalledWith({ prompt: 'work', model_profile: 'inherit', reasoning_effort: 'high' }, {});
      expect(list).not.toHaveBeenCalled();
      expect(modelSelectionGuidance({ policy: 'inherit' })).not.toEqual(modelSelectionGuidance({ policy: 'task' }));
    } finally { warn.mockRestore(); }
  });
});
