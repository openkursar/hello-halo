import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const compact = await import(pathToFileURL(join(compiled, process.env.SDK_COMPACT_ENTRY ?? 'native/compact.js')).href);
const { createSession } = await import(pathToFileURL(join(compiled, 'native/session.js')).href);
const history = () => Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `record ${index} ${'earlier evidence '.repeat(350)}` }));
const response = text => ({ id: 'summary', model: 'fixture', content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } });

const largeHandover = `SUMMARY_START ${'verified detail '.repeat(6000)} SUMMARY_END`;
const largeResponse = (stopReason = 'end_turn') => ({ ...response(largeHandover), stopReason, usage: { input_tokens: 100, output_tokens: 30000 } });

for (const thinking of [{ type: 'disabled' }, { type: 'enabled', budgetTokens: 96000 }, { type: 'adaptive' }]) {
  test(`targeted full compaction permits a real large handover with ${thinking.type} thinking`, async () => {
    const source = history().map(message => ({ ...message, content: message.content.repeat(3) }));
    const requests = [];
    const result = await compact.fullCompact(source, { async createMessage(request) { requests.push(request); return largeResponse(); } }, 'fixture', '', [], undefined, undefined, {
      maxTokens: 128000, targetInputTokens: 12000, maxInputTokens: 200000,
      request: { model: 'fixture', messages: source, maxTokens: 128000, thinking, tools: [] },
      estimateInputTokens(messages) { return messages.reduce((total, message) => total + JSON.stringify(message).length * 0.3, 0); },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].maxTokens, 128000);
    assert.deepEqual(requests[0].thinking, thinking);
    assert.equal(result.summary, largeHandover);
    assert.ok(result.summary.length * 0.3 > 20000);
    assert.ok(result.tokensFreed > 0);
  });
}

test('large summaries still refuse real truncation and insufficient retained capacity without mutating history', async () => {
  for (const failure of ['truncated', 'capacity']) {
    const source = history().map(message => ({ ...message, content: message.content.repeat(3) }));
    const original = structuredClone(source);
    let calls = 0;
    await assert.rejects(compact.fullCompact(source, { async createMessage() { calls++; return largeResponse(failure === 'truncated' ? 'max_tokens' : 'end_turn'); } }, 'fixture', '', [], undefined, undefined, {
      maxTokens: 128000, targetInputTokens: 12000, maxInputTokens: failure === 'capacity' ? 20000 : 200000,
      estimateInputTokens(messages) { return messages.reduce((total, message) => total + JSON.stringify(message).length * 0.3, 0); },
    }), error => error.reason === failure || error.details?.reason === failure || (failure === 'truncated' ? /truncat/i : /fit|capacity/i).test(error.message));
    assert.equal(calls, failure === 'truncated' ? 2 : 1);
    assert.deepEqual(source, original);
  }
});

for (const { automatic = false, corrected = false, thinking = { type: 'disabled' }, remaining = false, truncated = false } of [
  {}, { automatic: true }, { corrected: true },
  { thinking: { type: 'enabled', budgetTokens: 96000 } }, { thinking: { type: 'adaptive' } },
  { thinking: { type: 'enabled', budgetTokens: 96000 }, remaining: true },
  { truncated: true },
]) {
  test(`native ${automatic ? 'automatic' : 'manual'} session retains a large summary and accounts usage${corrected ? ' after an explicit server correction' : ''} (${thinking.type}, remaining=${remaining}, truncated=${truncated})`,  { timeout: 30000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'halo-large-compact-'));
    const summaries = [];
    const work = [];
    let session;
    const provider = {
      id: 'large-compact', name: 'Large compact fixture',
      capabilities: () => ({ streaming: true, toolCalling: true, thinking: true, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      async createMessage(request) {
        summaries.push(structuredClone(request));
        if (corrected && summaries.length === 1) {
          const error = new Error('max_tokens must be between 1 and 64000');
          Object.assign(error, { status: 400, statusCode: 400, requestRejected: true });
          throw error;
        }
        return largeResponse(truncated ? 'max_tokens' : 'end_turn');
      },
      async *createMessageStream(request) {
        work.push(structuredClone(request));
        const text = work.length === 1 ? `ORIGINAL_DETAIL ${'original evidence '.repeat(automatic ? 34000 : 25000)}` : 'done';
        yield { type: 'message_start', id: `work-${work.length}`, model: 'fixture', usage: { input_tokens: 10, output_tokens: 2 } };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'end_turn' };
        yield { type: 'message_stop' };
      },
    };
    const send = async text => { await session.send(text); const events = []; for await (const event of session.stream()) events.push(event); return events; };
    const options = { provider, model: 'fixture', cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'state') },
      tools: [], settingSources: [], collaboration: false, persistSession: true, systemPrompt: 'Fixture system',
      contextWindow: remaining ? 275000 : automatic ? 260000 : 500000, maxOutputTokens: 128000, thinking, turnEndChecks: { openWork: false, completion: false } };
    try {
      session = await createSession(options);
      await send('original task');
      await session.flush();
      const transcript = join(options.env.CLAUDE_CONFIG_DIR, 'projects', directory.replace(/[^a-zA-Z0-9]/g, '-'), `${session.sessionId}.jsonl`);
      const beforeJournal = await readFile(transcript, 'utf8');
      const beforeHistory = await session.command('readHistory');
      const events = await send(automatic ? 'continue' : '/compact');
      if (truncated) {
        assert.equal(summaries.length, 2);
        assert.ok(summaries.every(request => request.maxTokens === 128000));
        assert.equal(events.some(event => event.subtype === 'compact_boundary'), false);
        assert.deepEqual(await session.command('readHistory'), beforeHistory);
        await session.flush();
        const journal = await readFile(transcript, 'utf8');
        assert.ok(journal.startsWith(beforeJournal));
        assert.ok(journal.includes('ORIGINAL_DETAIL'));
        assert.ok(!journal.includes('SUMMARY_END'));
        const usage = await send('/usage');
        assert.ok(JSON.stringify(usage).includes('| Output | 60,002 |'), 'Both rejected summaries retain synthetic usage once');
        const continued = await send('continue after failed compaction');
        assert.equal(continued.findLast(event => event.type === 'result').is_error, false);
        assert.ok(JSON.stringify(work.at(-1).messages).includes('ORIGINAL_DETAIL'));
        return;
      }
      assert.equal(events.findLast(event => event.type === 'result').is_error, false);
      const boundary = events.find(event => event.subtype === 'compact_boundary');
      assert.ok(boundary, JSON.stringify(events.map(event => [event.type, event.subtype])));
      assert.equal(boundary.compact_metadata.trigger, automatic ? 'auto' : 'manual');
      assert.equal(summaries.length, corrected ? 2 : 1);
      assert.ok(summaries[0].maxTokens > 20000);
      assert.deepEqual(summaries[0].thinking, thinking);
      if (!automatic && !remaining) assert.equal(summaries[0].maxTokens, 128000);
      if (remaining) {
        assert.ok(summaries[0].maxTokens > 97024);
        assert.ok(summaries[0].maxTokens < 128000);
        assert.equal(summaries[0].thinking.budgetTokens, 96000);
      }
      assert.ok(largeResponse().usage.output_tokens <= summaries.at(-1).maxTokens);
      if (corrected) assert.equal(summaries[1].maxTokens, 64000);
      assert.ok(JSON.stringify(await session.command('readHistory')).includes('SUMMARY_END'));
      if (automatic) assert.ok(JSON.stringify(work.at(-1).messages).includes('SUMMARY_END'));
      const usage = await send('/usage');
      const outputTokens = 30000 + work.length * 2;
      assert.ok(JSON.stringify(usage).includes(`| Output | ${outputTokens.toLocaleString('en-US')} |`), 'Reported synthetic usage must be accounted exactly once, not interpreted as real provider billing');
      await session.flush();
      assert.ok((await readFile(transcript, 'utf8')).includes('SUMMARY_END'));
      const id = session.sessionId;
      await session[Symbol.asyncDispose]();
      session = await createSession({ ...options, resume: id, strictResume: true });
      assert.ok(JSON.stringify(await session.command('readHistory')).includes('SUMMARY_END'));
      const resumed = await send('continue from durable handover');
      assert.equal(resumed.findLast(event => event.type === 'result').is_error, false);
      assert.ok(JSON.stringify(work.at(-1).messages).includes('SUMMARY_END'));
      assert.equal(summaries.length, corrected ? 2 : 1, 'Resume must not replay summary generation or its usage');
      const resumedUsage = await send('/usage');
      assert.ok(JSON.stringify(resumedUsage).includes('| Output | 2 |'), 'A reopened execution accounts only new synthetic work, not historical summary usage');
    } finally { await session?.[Symbol.asyncDispose](); await rm(directory, { recursive: true, force: true }); }
  });
}

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

test('partial compaction validates output against the provider-adjusted actual request ceiling', async () => {
  for (const outputTokens of [30000, 32001]) {
    const source = history().map(message => ({ ...message, content: message.content.repeat(3) }));
    const original = structuredClone(source);
    let calls = 0;
    const operation = compact.partialCompact(source, {
      pivotIndex: 20, direction: 'up_to', model: 'fixture', maxTokens: 128000,
      provider: { async createMessage(request) {
        calls++;
        assert.equal(request.maxTokens, 128000);
        request.maxTokens = 32000;
        return { ...largeResponse(), usage: { input_tokens: 100, output_tokens: outputTokens } };
      } },
    });
    if (outputTokens <= 32000) assert.equal((await operation).summary, largeHandover);
    else await assert.rejects(operation, { code: 'COMPACT_ERROR', reason: 'truncated' });
    assert.equal(calls, 1);
    assert.deepEqual(source, original);
  }
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
