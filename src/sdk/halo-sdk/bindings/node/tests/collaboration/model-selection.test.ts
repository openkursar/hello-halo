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

function query() {
  return queryModelProfiles({ input: {}, parent, catalog, policyRevision: catalog.policyRevision });
}

const obsoleteDirectoryInputs = [{ query: 'review' }, { cursor: 'obsolete' }, { limit: 10 }];

describe('public model selection contract', () => {
  it('exports the bounded resource contract without loading an execution runtime', () => {
    expect(MODEL_SELECTION_LIMITS).toEqual({
      nameCodePoints: 80, descriptionCodePoints: 1000, catalogBytes: 1048576, resultBytes: 16384,
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
      mutable.profiles[0].name = 'Changed after construction';
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
    const captured = finalizeModelSelection({ plan: plan(), binding: modeOnly });
    expect(captured.reasoning).toEqual(parent.reasoning);
    expect(() => validateModelSelectionRestore({ snapshot: captured, binding: modeOnly })).toThrow('reasoning effort');
    expect(() => finalizeModelSelection({ plan: plan(), binding: {
      ...inherited, reasoning: { ...inherited.reasoning, maxBudgetTokens: 4095 },
    } })).toThrow();
    expect(() => finalizeModelSelection({ plan: plan(), binding: { ...inherited, maxOutputTokens: 4096 } })).toThrow();
    const differentMode = { ...inherited, reasoning: { ...inherited.reasoning, modes: ['off'] as const } };
    expect(finalizeModelSelection({ plan: plan(), binding: differentMode }).reasoning).toEqual(parent.reasoning);
    expect(() => validateModelSelectionRestore({ snapshot: captured, binding: differentMode })).toThrow();
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

  it('returns every configured profile in one directory, including unavailable entries', () => {
    const unavailable = { ...catalog.profiles[0], available: false, unavailableReason: 'Not configured' };
    const directory: ModelProfileCatalog = {
      ...catalog,
      profiles: [unavailable, ...Array.from({ length: 35 }, (_, index) => ({
        ...catalog.profiles[0], profileId: `profile-${index}`, name: `Profile ${index}`,
      }))],
    };
    const request = { catalog: directory, parent, policyRevision: directory.policyRevision };
    const result = queryModelProfiles({ ...request, input: {} });
    expect(result.profiles.map(profile => profile.name)).toEqual(directory.profiles.map(profile => profile.name));
    expect(new Set(result.profiles.map(profile => profile.selectionRef)).size).toBe(directory.profiles.length);
    expect(result.profiles[0]).toMatchObject({ available: false, unavailableReason: unavailable.unavailableReason });
    expect(result).not.toHaveProperty('hasMore');
    expect(result).not.toHaveProperty('nextCursor');
    expect(() => planModelSelection({ ...request, input: { model_profile: result.profiles[0].selectionRef } }))
      .toThrow('unavailable');
  });

  it('rejects removed or revised profile references and accepts the refreshed reference', () => {
    const previousRef = query().profiles[0].selectionRef;
    const refreshed: ModelProfileCatalog = {
      ...catalog, revision: 'catalog-2', profiles: [{ ...catalog.profiles[0], profileRevision: '2' }],
    };
    const view = new ModelProfileCatalogView(refreshed);
    const request = { parent, policyRevision: refreshed.policyRevision };
    try {
      expect(() => view.plan({ ...request, input: { model_profile: previousRef } })).toThrow('missing or changed');
      expect(() => planModelSelection({
        ...request, catalog: { ...refreshed, profiles: [] }, input: { model_profile: previousRef },
      })).toThrow('missing or changed');
      const currentRef = view.query({ ...request, input: {} }).profiles[0].selectionRef;
      expect(currentRef).not.toBe(previousRef);
      expect(view.plan({ ...request, input: { model_profile: currentRef } }).selection).toEqual({
        kind: 'profile', profileId: 'reviewer', profileRevision: '2', selectionRef: currentRef,
      });
    } finally { view.close(); }
  });

  it('rejects legacy directory arguments at both catalog query entry points', () => {
    const view = new ModelProfileCatalogView(catalog);
    const request = { parent, policyRevision: catalog.policyRevision };
    try {
      for (const legacyInput of obsoleteDirectoryInputs) {
        const input = legacyInput as never;
        expect(() => queryModelProfiles({ ...request, catalog, input })).toThrow();
        expect(() => view.query({ ...request, input })).toThrow();
      }
    } finally { view.close(); }
  });

  it('preserves Unicode and escaped text in a complete projection while enforcing the catalog byte limit', () => {
    const name = '🧪'.repeat(80);
    const description = '\u0000'.repeat(1000);
    const profile = { ...catalog.profiles[0], name, description };
    const bounded: ModelProfileCatalog = {
      ...catalog,
      profiles: Array.from({ length: 20 }, (_, index) => ({ ...profile, profileId: `unicode-${index}` })),
    };
    const request = { parent, policyRevision: bounded.policyRevision, input: {} };
    const view = new ModelProfileCatalogView(bounded);
    try {
      const result = view.query(request);
      expect(result).toEqual(queryModelProfiles({ ...request, catalog: bounded }));
      expect(result.profiles.map(({ name, description }) => ({ name, description })))
        .toEqual(bounded.profiles.map(() => ({ name, description })));
      expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(MODEL_SELECTION_LIMITS.resultBytes);
    } finally { view.close(); }
    for (const invalidProfile of [{ ...profile, name: `${name}🧪` }, { ...profile, description: `${description}\u0000` }]) {
      expect(() => new ModelProfileCatalogView({ ...bounded, profiles: [invalidProfile] })).toThrow();
    }
    const oversized = {
      ...bounded, profiles: Array.from({ length: 200 }, (_, index) => ({ ...profile, profileId: `oversized-${index}` })),
    };
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(MODEL_SELECTION_LIMITS.catalogBytes);
    expect(() => new ModelProfileCatalogView(oversized)).toThrow('byte limit');
    expect(() => queryModelProfiles({ ...request, catalog: oversized })).toThrow('byte limit');
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

  it.each([
    { policy: 'inherit' }, { policy: 'task' },
    { policy: 'inherit', reasoningPolicy: 'inherit' }, { policy: 'task', reasoningPolicy: 'inherit' },
  ] as const)('exposes an empty directory tool input under %j and reports only unapplied filtering or pagination', async modelSelection => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const list = vi.fn(async () => collaborationText('catalog'));
      const server = createCollaborationServer({ list_model_profiles: list }, { modelSelection });
      const [tool] = server.instance.listTools();
      expect(tool.inputSchema).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false });
      for (const input of obsoleteDirectoryInputs) {
        const result = await server.instance.callTool('list_model_profiles', input);
        expect(result?.isError).toBeUndefined();
        expect(result?.content).toEqual([
          { type: 'text', text: 'catalog' },
          { type: 'text', text: 'This is the full model directory; no filter was applied.' },
        ]);
        expect(list).toHaveBeenLastCalledWith({}, {});
      }
      expect(list).toHaveBeenCalledTimes(obsoleteDirectoryInputs.length);
      expect(await server.instance.callTool('list_model_profiles', {})).toEqual(collaborationText('catalog'));
      expect(await server.instance.callTool('list_model_profiles', { summary: 'Find a model' })).toEqual(collaborationText('catalog'));
      expect(list).toHaveBeenLastCalledWith({}, {});
      list.mockResolvedValueOnce(collaborationText('No profiles were listed.', true));
      expect(await server.instance.callTool('list_model_profiles', { query: 'Small' })).toEqual(collaborationText('No profiles were listed.', true));
    } finally { warn.mockRestore(); }
  });

  it.each(['inherit', 'task'] as const)('inherits reasoning without exposing an override under %s model selection', async policy => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const spawn = vi.fn(async () => collaborationText('accepted'));
      const list = vi.fn(async () => collaborationText('model_profile: p1'));
      const modelSelection = { policy, reasoningPolicy: 'inherit' } as const;
      const server = createCollaborationServer({ spawn_agent: spawn, list_model_profiles: list }, { modelSelection });
      const [spawnTool, listTool] = server.instance.listTools();
      expect(spawnTool.inputSchema.properties).toHaveProperty('model_profile');
      expect(spawnTool.inputSchema.properties).not.toHaveProperty('reasoning_effort');
      expect(spawnTool.inputSchema.additionalProperties).toBe(false);
      const guidance = modelSelectionGuidance(modelSelection);
      expect(listTool.description).toContain(guidance);
      expect(guidance).toContain("direct parent's reasoning settings even when the model changes");
      expect(guidance).toContain('unchanged as model_profile');
      expect(guidance).not.toContain('selectionRef');
      expect(guidance).not.toContain('reasoning effort');

      const input = { prompt: 'work', model_profile: 'p1' };
      const rejected = await server.instance.callTool('spawn_agent', { ...input, reasoning_effort: 'high' });
      expect(rejected?.isError).toBe(true);
      expect(rejected?.content[0].text).toContain('reasoning_effort');
      expect(rejected?.content[0].text).toContain('Accepted arguments: prompt, name, cwd, isolation, model_profile.');
      const rawModel = await server.instance.callTool('spawn_agent', { prompt: 'work', model: 'review-model' });
      expect(rawModel).toEqual(collaborationText('No collaborator was created. Unsupported argument: model. Accepted arguments: prompt, name, cwd, isolation, model_profile. To choose a model, call list_model_profiles and pass the returned profile reference as model_profile.', true));
      expect(spawn).not.toHaveBeenCalled();
      expect(await server.instance.callTool('list_model_profiles', {})).toEqual(collaborationText('model_profile: p1'));
      expect(await server.instance.callTool('spawn_agent', input)).toEqual(collaborationText('accepted'));
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(input, {});
    } finally { warn.mockRestore(); }
  });
});
