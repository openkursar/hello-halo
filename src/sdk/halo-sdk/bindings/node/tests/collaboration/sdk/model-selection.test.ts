import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSdkCollaboration } from '../../../native/collaboration-sdk.js';

describe('standalone collaboration model directory', () => {
  it('admits the registered directory tool without changing the baseline tool gate', async () => {
    const baseline = createSdkCollaboration({ sessionId: randomUUID(), getOptions: () => ({ model: 'fixture' }),
      deliverToSource: async () => 'buffered' });
    let reads = 0;
    const selected = createSdkCollaboration({ sessionId: randomUUID(), getOptions: () => ({ model: 'fixture' }),
      deliverToSource: async () => 'buffered', settings: { modelSelection: {
        policy: 'inherit', policyRevision: 'one', parentBinding: { bindingId: 'parent', restoreRef: 'parent' },
        getCatalog() { reads++; return { kind: 'snapshot', catalog: { revision: 'one', policy: 'inherit', policyRevision: 'one', profiles: [] } }; },
        async prepare() { throw new Error('Directory lookup cannot prepare a provider'); },
      } } });
    try {
      expect(await baseline.server.instance.callTool('list_model_profiles', {})).toBeUndefined();
      expect(selected.server.instance.listTools().some(tool => tool.name === 'list_model_profiles')).toBe(true);
      expect(reads).toBe(0);
      const result = await selected.server.instance.callTool('list_model_profiles', {});
      expect(result).toBeDefined();
      expect(reads).toBe(1);
    } finally { await Promise.all([baseline.close(), selected.close()]); }
  });
});
