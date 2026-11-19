import { describe, expect, it } from 'vitest';
import { HostCallbacks } from '../../worker/callbacks.js';
import { CALLBACK, SIGNAL } from '../../worker/options.js';
import { WORKER_PROTOCOL_VERSION } from '../../worker/protocol.js';

describe('Worker model preparation callbacks', () => {
  it('preserves captured policy and cancellation while rejecting custom provider transport', async () => {
    const owner = new AbortController();
    const callbacks = new HostCallbacks(owner.signal);
    let result: unknown = { providerConfig: { type: 'openai-compat', apiKey: '' } };
    let observed: AbortSignal | undefined;
    const encoded = callbacks.encode({ collaboration: { mode: 'local', modelSelection: {
      policy: 'task', policyRevision: 'policy-one', parentBinding: { bindingId: 'parent', restoreRef: 'parent-ref' },
      getCatalog: () => ({ kind: 'unchanged', revision: 'catalog-one' }),
      prepare: async (_request, context) => { observed = context.signal; return result as any; },
    } } });
    const host = (encoded.options.collaboration as any).modelSelection;
    expect(host.policy).toBe('task');
    expect(host.policyRevision).toBe('policy-one');
    expect(WORKER_PROTOCOL_VERSION).toBe(6);
    const context = { signal: { [SIGNAL]: true } };
    const active = new AbortController();
    expect(await callbacks.call(host.prepare[CALLBACK], [{ kind: 'restore' }, context], active.signal)).toEqual(result);
    expect(observed).toBe(active.signal);
    result = { provider: { id: 'custom' } };
    await expect(callbacks.call(host.prepare[CALLBACK], [{}, context], active.signal)).rejects.toThrow('setup module');
    result = { providerConfig: { apiKey: '' } };
    await expect(callbacks.call(host.prepare[CALLBACK], [{}, context], active.signal)).rejects.toThrow('explicit');
    callbacks.clear();
  });
});
