import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const compact = await import(pathToFileURL(join(compiled, process.env.SDK_COMPACT_ENTRY ?? 'native/compact.js')).href);
const history = () => Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `record ${index} ${'earlier evidence '.repeat(350)}` }));
const response = text => ({ id: 'summary', model: 'fixture', content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } });

test('compaction retains exact history, attachment and arrival objects in every direction', async () => {
  for (const direction of ['full', 'up_to', 'from']) {
    const source = history();
    const attachment = { role: 'user', isMeta: true, content: 'Required state' };
    const arrival = { role: 'user', content: 'Latest correction' };
    const provider = { async createMessage() { source.push(arrival); return response('Verified progress'); } };
    const result = direction === 'full'
      ? await compact.fullCompact(source, provider, 'fixture', '', [attachment])
      : await compact.partialCompact(source, { pivotIndex: 8, direction, provider, model: 'fixture', attachments: [attachment] });
    assert.equal(result.messages.at(-1), arrival);
    assert.ok(result.messages.includes(attachment));
    const retained = result.messages.filter(message => source.includes(message));
    assert.deepEqual(retained, direction === 'from' ? [...source.slice(0, 8), arrival] : source.slice(direction === 'full' ? 20 : 8));
    assert.deepEqual(Object.keys(result), ['messages', 'summary', 'tokensFreed']);
  }
});

test('candidate callbacks and estimators observe the same arrays and original messages', async () => {
  const source = history();
  const attachment = { role: 'user', isMeta: true, content: 'Required state' };
  const created = { role: 'user', isMeta: true, content: 'Added by the callback' };
  const prepared = [];
  let measuredSource = false;
  const result = await compact.fullCompact(source, { async createMessage() { return response('Short handover'); } }, 'fixture', '', [attachment], undefined, undefined, {
    maxTokens: 512, targetInputTokens: 4000, maxInputTokens: 5000,
    prepareCandidate(candidate) {
      assert.ok(candidate.includes(attachment));
      for (const message of candidate) {
        if (String(message.content).startsWith('record ')) assert.ok(source.includes(message));
      }
      const output = [...candidate, created];
      prepared.push(output);
      return output;
    },
    estimateInputTokens(messages) {
      if (messages === source) measuredSource = true;
      else assert.ok(prepared.includes(messages));
      return messages === source ? 50000 : 1000;
    },
  });
  assert.equal(prepared.length, 2);
  assert.equal(result.messages, prepared.at(-1));
  assert.equal(result.messages.at(-1), created);
  assert.equal(measuredSource, true);
});

test('response observers receive the provider object and their mutations affect the summary', async () => {
  const original = response('Before observation');
  let observed;
  const result = await compact.fullCompact(history(), { async createMessage() { return original; } }, 'fixture', '', [], undefined, undefined, {
    onResponse(value) { observed = value; value.content[0].text = 'After observation'; },
  });
  assert.equal(observed, original);
  assert.equal(result.summary, 'After observation');
});

test('provider request mutation is retained when summary output recovery retries', async () => {
  const requests = [];
  const result = await compact.fullCompact(history(), { async createMessage(request) {
    requests.push(request.maxTokens);
    request.maxTokens = 3;
    const output = response('Finished handover');
    if (requests.length === 1) output.usage.output_tokens = 10;
    return output;
  } }, 'fixture', '', [], undefined, undefined, { maxTokens: 256 });
  assert.deepEqual(requests, [256, 256]);
  assert.equal(result.summary, 'Finished handover');
});

test('candidate mutation followed by an undefined return preserves the candidate and source aliases', async () => {
  const source = history();
  const attachment = { role: 'user', isMeta: true, content: 'Required state' };
  let candidate;
  const result = await compact.fullCompact(source, { async createMessage() { return response('Handover'); } }, 'fixture', '', [attachment], undefined, undefined, {
    prepareCandidate(messages) {
      candidate = messages;
      assert.equal(messages[1], attachment);
      messages.at(-1).content = 'Changed retained evidence';
      messages.push({ role: 'user', content: 'Added in place' });
    },
  });
  assert.equal(result.messages, candidate);
  assert.equal(source.at(-1).content, 'Changed retained evidence');
  assert.equal(result.messages.at(-1).content, 'Added in place');
});
