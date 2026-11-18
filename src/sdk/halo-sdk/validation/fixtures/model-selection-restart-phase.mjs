import assert from 'node:assert/strict';
import { join } from 'node:path';
import { entry } from './model-selection-entry.mjs';

const { createSdkCollaboration } = await entry('collaboration/sdk');
const { queryModelProfiles } = await entry('collaboration');
const [directory, url, phase] = process.argv.slice(2);
const parent = { bindingId: 'root-A', restoreRef: 'root-A-ref', model: 'A', reasoning: { version: 1, mode: 'off' } };
const profile = (profileId, profileRevision) => ({ profileId, profileRevision, name: 'Same display name', description: '', target: { kind: 'single', label: 'Endpoint', models: ['same-wire-model'] }, reasoning: {}, available: true });
const catalog = { revision: phase, policy: 'inherit', policyRevision: '1', profiles: phase === 'initial' ? [profile('B', '1')] : phase === 'updated' ? [profile('B', '2')] : [profile('C', '1')] };
const prepared = [];
const binding = createSdkCollaboration({ sessionId: 'restart-source', getOptions: () => ({ model: 'A', cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') }, permissionMode: 'bypassPermissions', systemPrompt: 'Retain original context.', tools: ['Write'], thinking: { type: 'disabled' }, persistSession: true }), settings: { maxMembers: 2, maxIdleSessions: 0, modelSelection: { policy: 'inherit', policyRevision: '1', parentBinding: parent, getCatalog: () => ({ kind: 'snapshot', catalog }), async prepare(request) {
  prepared.push(request);
  if (phase !== 'initial') {
    assert.equal(request.kind, 'restore');
    assert.equal(request.snapshot.bindingId, 'account-B');
    assert.equal(request.snapshot.restoreRef, 'account-B-ref');
    assert.equal(request.snapshot.selection.profileId, 'B');
  }
  if (phase === 'revoked') throw new Error('Original account B revoked');
  return { bindingId: 'account-B', restoreRef: 'account-B-ref', model: 'same-wire-model', targetKind: 'single', contextWindow: 32000, maxOutputTokens: 1024, modalities: ['text'], reasoning: { default: { version: 1, mode: 'off' } }, providerConfig: { type: 'openai-compat', baseUrl: url, apiKey: 'restart-B-canary' } };
} } }, async deliverToSource() { return 'buffered'; } });
try {
  const tool = phase === 'initial' ? 'spawn_agent' : 'team_send';
  const input = phase === 'initial' ? { name: 'retained-B', prompt: 'Write evidence once.', model_profile: queryModelProfiles({ catalog, parent, policyRevision: '1', input: {} }).profiles[0].selectionRef } : { to: 'retained-B', message: `Continue retained history after ${phase}. Do not replay Write.` };
  const receipt = await binding.server.instance.callTool(tool, input);
  assert.notEqual(receipt.isError, true, JSON.stringify(receipt));
  while (binding.activeCount > 0) await binding.waitForChange(binding.revision);
  await binding.flush();
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].kind, phase === 'initial' ? 'new' : 'restore');
  console.log(JSON.stringify({ phase, prepared, receipt }));
} finally { await binding.close(); }
