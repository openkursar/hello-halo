import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { createSession, queryLoop, getSessionMessages } = await import(pathToFileURL(join(compiled, 'index.js')).href);

const capabilities = { streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false, audioInput: false,
  videoInput: false, caching: false, systemPromptStyle: 'top_level' };
const text = value => ({ type: 'text', text: value });
const call = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
let todoSequence = 0;
const todos = (...items) => call(`todo-${++todoSequence}`, 'TodoWrite', { todos: items.map(([content, status]) => ({ content, status, activeForm: content })) });
const deadline = { timeout: 30_000 };

function scripted(script, requests) {
  return { id: 'fixture', name: 'Fixture', capabilities: () => capabilities,
    async createMessage() { throw new Error('Unexpected summary request'); },
    async *createMessageStream(request) {
      requests.push(JSON.stringify(request.messages));
      const blocks = await script(requests.length, request);
      assert.ok(Array.isArray(blocks), `Unexpected model request ${requests.length}`);
      yield { type: 'message_start', id: `response-${requests.length}`, model: request.model, usage: { input_tokens: 1, output_tokens: 0 } };
      for (const [index, block] of blocks.entries()) {
        if (block.type === 'text') {
          yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
          yield { type: 'text_delta', index, text: block.text };
        } else yield { type: 'content_block_start', index, content_block: block };
        yield { type: 'content_block_stop', index };
      }
      yield { type: 'message_delta', stopReason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { output_tokens: 1 } };
      yield { type: 'message_stop' };
    } };
}
async function fixture(t, script, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'halo-turn-end-'));
  const requests = [];
  const session = await createSession({ model: 'fixture', provider: scripted(script, requests), cwd: root, env: { HOME: root }, persistSession: false,
    tools: ['TodoWrite', 'Goal', 'Glob'], collaboration: false, settingSources: [], skillCatalog: [], systemPrompt: 'Fixture instructions.',
    thinking: { type: 'disabled' }, permissionMode: 'bypassPermissions', includePartialMessages: true, ...options });
  t.after(async () => { await session[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); });
  return { root, session, requests };
}
async function turn(session, prompt) {
  await session.send(prompt);
  const events = [];
  for await (const event of session.stream()) { events.push(event); if (event.type === 'result') break; }
  return events;
}
const everywhere = (events, needle) => events.some(event => JSON.stringify(event).includes(needle));
const resultOf = events => events.find(event => event.type === 'result').result;
const assistantBlocks = events => events.filter(event => event.type === 'assistant').flatMap(event => event.message.content);
const requestBlocks = request => JSON.parse(request).flatMap(message => Array.isArray(message.content) ? message.content : []);
const toolFeedback = (request, id) => requestBlocks(request).find(block => block.type === 'tool_result' && block.tool_use_id === id);

for (const includePartialMessages of [false, true]) test(`text-only check replies remain visible and retained (partials=${includePartialMessages})`, deadline, async t => {
  const { session, requests } = await fixture(t, step => ({
    1: [todos(['step one', 'pending'])], 2: [text('ANSWER')], 3: [text('TAIL: I stopped on purpose.')], 4: [text('NEXT ANSWER')],
  })[step], { includePartialMessages });
  const events = await turn(session, 'Plan it.');
  assert.equal(resultOf(events), 'TAIL: I stopped on purpose.');
  assert.equal(requests.length, 3);
  assert.match(requests[2], /work still open/);
  assert.deepEqual(assistantBlocks(events).filter(block => block.type === 'text').map(block => block.text), ['ANSWER', 'TAIL: I stopped on purpose.']);
  assert.equal(events.filter(event => event.type === 'stream_event' && event.event?.delta?.text === 'TAIL: I stopped on purpose.').length, includePartialMessages ? 1 : 0);
  assert.deepEqual(events.find(event => event.type === 'result').usage,
    { input_tokens: 3, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  assert.equal(events.some(event => event.type === 'stream_event' && event.event?.delta?.text === 'ANSWER'), includePartialMessages);
  const next = await turn(session, 'Thanks.');
  assert.equal(resultOf(next), 'NEXT ANSWER');
  assert.ok(requests[3].includes('TAIL: I stopped on purpose.'), 'the check reply is ordinary retained history');
});

test('check text streams before the provider finishes without waiting for a tool call', deadline, async t => {
  let release, paused, observed;
  const releaseProvider = new Promise(resolve => { release = resolve; });
  const providerPaused = new Promise(resolve => { paused = resolve; });
  const textObserved = new Promise(resolve => { observed = resolve; });
  const requests = [];
  const provider = scripted(step => ({ 1: [text('ANSWER A')], 2: [text('ANSWER B')] })[step], requests);
  const stream = provider.createMessageStream.bind(provider);
  provider.createMessageStream = async function* (request) {
    for await (const event of stream(request)) {
      yield event;
      if (requests.length === 2 && event.type === 'text_delta') { paused(); await releaseProvider; }
    }
  };
  const { session } = await fixture(t, () => [], { provider, tools: [],
    goal: { objective: 'Finish analysis', doneWhen: ['Analysis complete'] } });
  t.signal.addEventListener('abort', release, { once: true });
  await session.send('Analyze.');
  const events = [];
  const consuming = (async () => {
    for await (const event of session.stream()) {
      events.push(event);
      if (event.type === 'stream_event' && event.event?.delta?.text === 'ANSWER B') observed();
    }
  })();
  try {
    await providerPaused;
    await textObserved;
    assert.ok(!events.some(event => event.type === 'result'), 'the provider has not finished');
  } finally { release(); await consuming; }
  assert.equal(resultOf(events), 'ANSWER B');
  assert.deepEqual(assistantBlocks(events).filter(block => block.type === 'text').map(block => block.text), ['ANSWER A', 'ANSWER B']);
});

test('a check can complete a missing analysis using only text', deadline, async t => {
  const { session, requests } = await fixture(t, step => ({
    1: [text('Analysis of options one and two.')],
    2: [text('Option three: this is the missing comparison.')],
  })[step], { goal: { objective: 'Compare three options', doneWhen: ['All three compared'] }, tools: [] });
  const events = await turn(session, 'Compare the options.');
  assert.equal(resultOf(events), 'Option three: this is the missing comparison.');
  assert.equal(requests.length, 2);
  assert.deepEqual(assistantBlocks(events).map(block => block.text),
    ['Analysis of options one and two.', 'Option three: this is the missing comparison.']);
  assert.match(requests[1], /work still open/);
});

for (const reply of ['Completion check: the explanation is complete.', '']) test(`completion-check text uses ordinary output and the empty fallback (empty=${!reply})`, deadline, async t => {
  const { session, requests } = await fixture(t, step => ({ 1: [text('INITIAL EXPLANATION')], 2: reply ? [text(reply)] : [] })[step],
    { tools: [], turnEndChecks: { openWork: false, completion: true } });
  const events = await turn(session, 'Explain it.');
  assert.equal(resultOf(events), reply || 'INITIAL EXPLANATION');
  assert.equal(requests.length, 2);
  assert.deepEqual(assistantBlocks(events).filter(block => block.type === 'text').map(block => block.text),
    reply ? ['INITIAL EXPLANATION', reply] : ['INITIAL EXPLANATION']);
  assert.deepEqual(events.find(event => event.type === 'result').usage,
    { input_tokens: 2, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
});

test('a completed todo update streams text before the tool and sends its result back to the model', deadline, async t => {
  const { session, requests } = await fixture(t, step => ({
    1: [todos(['step one', 'pending'])], 2: [text('ANSWER')],
    3: [text('Updating the list.'), todos(['step one', 'completed'])], 4: [text('TAIL AFTER BOOKKEEPING')],
  })[step]);
  const events = await turn(session, 'Plan it.');
  assert.equal(resultOf(events), 'TAIL AFTER BOOKKEEPING');
  assert.equal(requests.length, 4);
  assert.match(requests[3], /All todos completed/);
  const blocks = events.filter(event => event.type === 'assistant').flatMap(event => event.message.content);
  const said = blocks.findIndex(block => block.type === 'text' && block.text === 'Updating the list.');
  const updated = blocks.findIndex((block, index) => index > said && block.type === 'tool_use' && block.name === 'TodoWrite');
  assert.ok(said >= 0 && updated > said);
  assert.equal(events.filter(event => event.type === 'stream_event' && event.event?.delta?.text === 'Updating the list.').length, 1);
  assert.ok(events.some(event => event.type === 'assistant' && event.message.content.some(block => block.type === 'tool_use' && block.name === 'TodoWrite')), 'the list update stays visible to the host');
  assert.ok(everywhere(events, 'All todos completed'), 'the update was executed');
});

test('successive bookkeeping updates each return feedback and do not terminate the run', deadline, async t => {
  const planned = await fixture(t, step => ({
    1: [todos(['step one', 'pending'], ['step two', 'pending'])], 2: [text('ANSWER')],
    3: [text('Planning.'), todos(['step one', 'in_progress'], ['step two', 'pending'])],
    4: [call('work', 'Glob', { pattern: '*' }), todos(['step one', 'completed'], ['step two', 'completed'])], 5: [text('FINAL')],
  })[step]);
  const events = await turn(planned.session, 'Do it.');
  assert.equal(resultOf(events), 'FINAL');
  assert.equal(planned.requests.length, 5);
  assert.ok(assistantBlocks(events).some(block => block.type === 'text' && block.text === 'Planning.'));
  const stalled = await fixture(t, step => ({
    1: [todos(['step one', 'pending'])], 2: [text('ANSWER')],
    3: [todos(['step one', 'in_progress'])], 4: [todos(['step one', 'pending'])], 5: [text('TAIL')],
  })[step]);
  const ended = await turn(stalled.session, 'Do it.');
  assert.equal(resultOf(ended), 'TAIL');
  assert.equal(stalled.requests.length, 5, 'both updates receive ordinary model feedback');
  for (const index of [3, 4]) {
    const update = requestBlocks(stalled.requests[index]).findLast(block => block.type === 'tool_use');
    assert.ok(toolFeedback(stalled.requests[index], update.id));
    assert.notEqual(toolFeedback(stalled.requests[index], update.id).is_error, true);
  }
  assert.ok(everywhere(ended, 'TAIL'));
});

test('a genuinely changed unfinished list can receive a fresh check in the same turn', deadline, async t => {
  const { session, requests } = await fixture(t, step => ({
    1: [todos(['step one', 'pending']), call('work', 'Glob', { pattern: '*' })], 2: [text('ANSWER')],
    3: [text('Adding an item.'), todos(['step one', 'pending'], ['step two', 'pending'])], 4: [text('CLOSING NOTE')],
    5: [text('LATEST CHECK ANSWER')],
  })[step]);
  const events = await turn(session, 'Do it.');
  assert.equal(resultOf(events), 'LATEST CHECK ANSWER');
  assert.equal(requests.length, 5);
  assert.match(requests[4], /work still open/);
  for (const value of ['ANSWER', 'Adding an item.', 'CLOSING NOTE', 'LATEST CHECK ANSWER']) assert.ok(everywhere(events, value));
});

test('a reply that resumes real work shows its text before the tool and its final answer becomes the result', deadline, async t => {
  const { session, requests } = await fixture(t, step => ({
    1: [todos(['step one', 'pending'])], 2: [text('ANSWER')],
    3: [text('Continuing with the rest.'), call('work', 'Glob', { pattern: '*' })], 4: [text('FINAL')],
  })[step]);
  const events = await turn(session, 'Plan it.');
  assert.equal(resultOf(events), 'FINAL');
  assert.equal(requests.length, 4);
  const frames = events.filter(event => event.type === 'assistant').flatMap(event => event.message.content);
  const said = frames.findIndex(block => block.type === 'text' && block.text === 'Continuing with the rest.');
  const worked = frames.findIndex(block => block.type === 'tool_use' && block.name === 'Glob');
  assert.ok(said >= 0 && worked > said, 'ordinary text is emitted ahead of the tool call');
  const deltas = events.filter(event => event.type === 'stream_event' && event.event?.delta?.text === 'Continuing with the rest.');
  assert.equal(deltas.length, 1);
});

test('the same unfinished state is asked about once; a plain question does not ask again, work on it does', deadline, async t => {
  const { session, requests } = await fixture(t, step => ({
    1: [todos(['step one', 'pending'])], 2: [text('ANSWER 1')], 3: [text('ok')],
    4: [text('ANSWER 2')],
    5: [call('work', 'Glob', { pattern: '*' })], 6: [text('ANSWER 3')], 7: [text('ok again')],
  })[step]);
  assert.equal(resultOf(await turn(session, 'Plan it.')), 'ok');
  assert.equal(requests.length, 3);
  assert.equal(resultOf(await turn(session, 'A question.')), 'ANSWER 2');
  assert.equal(requests.length, 4, 'no check: the state is unchanged and the turn did no work');
  assert.equal(resultOf(await turn(session, 'Do some work.')), 'ok again');
  assert.equal(requests.length, 7, 'a turn with work asks again');
  assert.match(requests[6], /work still open/);
});

test('an empty check reply keeps the preceding answer and counts both responses once', deadline, async t => {
  const { session, requests } = await fixture(t, step => ({
    1: [todos(['step one', 'pending'])], 2: [text('ORIGINAL ANSWER')], 3: [],
  })[step]);
  const events = await turn(session, 'Plan it.');
  assert.equal(resultOf(events), 'ORIGINAL ANSWER');
  assert.equal(requests.length, 3);
  const result = events.find(event => event.type === 'result');
  assert.equal(result.usage.input_tokens, 3);
  assert.equal(result.usage.output_tokens, 3);
  assert.equal(result.num_turns, 3);
});

for (const prevent of [false, true]) test(`normal Stop hooks control continuation after a bookkeeping reply (prevent=${prevent})`, deadline, async t => {
  let stops = 0;
  const { session, requests } = await fixture(t, step => ({
    1: [todos(['step one', 'pending'])], 2: [text('ANSWER')],
    3: [text('Updating.'), todos(['step one', 'completed'])], 4: [text('AFTER FEEDBACK')], 5: [text('AFTER STOP BLOCK')],
  })[step], { hooks: { Stop: [{ hooks: [async () => {
    stops++;
    assert.equal(requests.length, [0, 2, 4, 5][stops]);
    return stops === 2 ? { decision: 'block', reason: 'STOP_REVIEW_REQUIRED', preventContinuation: prevent } : {};
  }] }] } });
  const events = await turn(session, 'Plan it.');
  if (prevent) {
    assert.equal(events.some(event => event.type === 'result'), false, 'preventContinuation ends the loop without a success result');
    assert.ok(everywhere(events, 'AFTER FEEDBACK'));
  } else assert.equal(resultOf(events), 'AFTER STOP BLOCK');
  assert.equal(stops, prevent ? 2 : 3);
  const update = requestBlocks(requests[3]).findLast(block => block.type === 'tool_use');
  assert.ok(toolFeedback(requests[3], update.id));
  assert.equal(requests.length, prevent ? 4 : 5);
  if (!prevent) assert.match(requests[4], /STOP_REVIEW_REQUIRED/);
});

for (const tool of ['TodoWrite', 'Goal']) test(`two successive ${tool} updates retain text order and ordinary tool feedback`, deadline, async t => {
  const update = (id, status) => tool === 'TodoWrite' ? call(id, tool, { todos: [{ content: 'work', status, activeForm: 'Working' }] })
    : call(id, tool, status === 'completed' ? { action: 'complete' } : { action: 'set', objective: 'Finish work', doneWhen: ['Work verified'] });
  const { session, requests } = await fixture(t, step => ({
    1: [todos(['work', 'pending'])], 2: [text('ANSWER')],
    3: [text('FIRST UPDATE'), update('first-update', 'in_progress')],
    4: [text('SECOND UPDATE'), update('second-update', 'completed')],
    5: [text('FEEDBACK ANSWER')], 6: [text('CHECKED ANSWER')],
  })[step]);
  const events = await turn(session, 'Work.');
  assert.equal(resultOf(events), 'FEEDBACK ANSWER');
  assert.equal(requests.length, 5);
  const blocks = events.filter(event => event.type === 'assistant').flatMap(event => event.message.content);
  for (const [label, id, requestIndex] of [['FIRST UPDATE', 'first-update', 3], ['SECOND UPDATE', 'second-update', 4]]) {
    const said = blocks.findIndex(block => block.type === 'text' && block.text === label);
    const used = blocks.findIndex(block => block.type === 'tool_use' && block.id === id);
    assert.ok(said >= 0 && used > said);
    assert.ok(toolFeedback(requests[requestIndex], id));
    assert.notEqual(toolFeedback(requests[requestIndex], id).is_error, true);
    assert.equal(events.filter(event => event.type === 'stream_event' && event.event?.delta?.text === label).length, 1);
  }
});

for (const arrivalStep of [2, 3]) test(`live input at response ${arrivalStep} is consumed without losing the ordinary answer`, deadline, async t => {
  let session;
  const f = await fixture(t, step => {
    if (step === arrivalStep) assert.equal(session.sendIntoLiveTurn('LIVE_CORRECTION'), true);
    return ({ 1: [todos(['work', 'pending'])], 2: [text('ANSWER BEFORE CHECK')],
      3: [text('ANSWER DURING CHECK')], 4: [text('ANSWER TO LIVE INPUT')], 5: [text('LATEST ANSWER')] })[step];
  });
  session = f.session;
  const events = await turn(session, 'Work.');
  const answers = assistantBlocks(events).filter(block => block.type === 'text').map(block => block.text);
  assert.deepEqual(answers, arrivalStep === 2
    ? ['ANSWER BEFORE CHECK', 'ANSWER DURING CHECK']
    : ['ANSWER BEFORE CHECK', 'ANSWER DURING CHECK', 'ANSWER TO LIVE INPUT']);
  assert.match(f.requests[arrivalStep], /LIVE_CORRECTION/);
  assert.equal(f.requests.length, arrivalStep + 1);
  assert.equal(session.hasPendingInput(), false);
  assert.equal(resultOf(events), arrivalStep === 2 ? 'ANSWER DURING CHECK' : 'ANSWER TO LIVE INPUT');
});

for (const answer of ['ORIGINAL ANSWER', '']) test(`empty end-turn replies still consume live input and retain earlier output (answer=${!!answer})`, deadline, async t => {
  let session, stops = 0;
  const f = await fixture(t, step => {
    if (step === 1) assert.equal(session.sendIntoLiveTurn('LIVE_INPUT'), true);
    return ({ 1: answer ? [text(answer)] : [], 2: [], 3: [text('NEXT TURN ANSWER')] })[step];
  }, { tools: [], turnEndChecks: { openWork: false, completion: false },
    hooks: { Stop: [{ hooks: [async () => { stops++; return {}; }] }] } });
  session = f.session;
  const events = await turn(session, 'Work.');
  const results = events.filter(event => event.type === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].is_error, false);
  assert.equal(results[0].result, '');
  assert.equal(results[0].num_turns, 2);
  assert.equal(results[0].usage.input_tokens, 2);
  assert.equal(results[0].usage.output_tokens, 2);
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1], /LIVE_INPUT/);
  assert.equal(session.hasPendingInput(), false);
  assert.equal(stops, 2);
  assert.deepEqual(assistantBlocks(events), answer ? [text(answer)] : []);
  const next = await turn(session, 'A new question.');
  assert.equal(resultOf(next), 'NEXT TURN ANSWER');
  assert.equal(f.requests.length, 3);
  if (answer) assert.ok(requestBlocks(f.requests[2]).some(block => block.text === answer));
});

for (const prevent of [false, true]) test(`normal Stop hooks run after an empty end-turn reply (prevent=${prevent})`, deadline, async t => {
  let stops = 0;
  const { session, requests } = await fixture(t, step => ({ 1: [], 2: [text('AFTER STOP BLOCK')] })[step], {
    tools: [], turnEndChecks: { openWork: false, completion: false },
    hooks: { Stop: [{ hooks: [async () => ++stops === 1
      ? { decision: 'block', reason: 'EMPTY_STOP_REVIEW_REQUIRED', preventContinuation: prevent } : {}] }] },
  });
  const events = await turn(session, 'Work.');
  assert.equal(stops, prevent ? 1 : 2);
  assert.equal(requests.length, prevent ? 1 : 2);
  if (prevent) assert.equal(events.some(event => event.type === 'result'), false);
  else {
    assert.equal(events.find(event => event.type === 'result').is_error, false);
    assert.equal(resultOf(events), 'AFTER STOP BLOCK');
    assert.match(requests[1], /EMPTY_STOP_REVIEW_REQUIRED/);
  }
});

for (const kind of ['no-events', 'start-only', 'usage-only', 'end-turn', 'message-stop', 'legacy-text'])
  test(`custom provider completion distinguishes an empty result from a missing response (${kind})`, deadline, async t => {
    let requests = 0;
    const provider = { id: 'fixture', name: 'Fixture', capabilities: () => capabilities,
      async *createMessageStream() {
        requests++;
        if (kind === 'start-only') yield { type: 'message_start', id: 'unfinished', model: 'fixture' };
        if (kind === 'usage-only') yield { type: 'message_delta', usage: { output_tokens: 1 } };
        if (kind === 'end-turn') yield { type: 'message_delta', stopReason: 'end_turn' };
        if (kind === 'message-stop') yield { type: 'message_stop' };
        if (kind === 'legacy-text') yield { type: 'text_delta', index: 0, text: 'LEGACY ANSWER' };
      } };
    const { session } = await fixture(t, () => [], { provider, tools: [], turnEndChecks: { openWork: false, completion: false } });
    const events = await turn(session, 'Work.');
    const result = events.find(event => event.type === 'result');
    const incomplete = ['no-events', 'start-only', 'usage-only'].includes(kind);
    assert.equal(requests, 1);
    assert.equal(result.is_error, incomplete);
    if (!incomplete) assert.equal(result.result, kind === 'legacy-text' ? 'LEGACY ANSWER' : '');
    else assert.match(result.result, /without receiving message_stop/);
  });

for (const [reason, count] of [['refusal', 1], ['stop_sequence', 1], ['max_tokens', 4], ['unreadable', 3]])
  test(`empty responses preserve terminal failure and recovery limits (${reason})`, deadline, async t => {
    const requests = [];
    const provider = scripted(() => [], requests);
    const stream = provider.createMessageStream.bind(provider);
    provider.createMessageStream = async function* (request) {
      for await (const event of stream(request)) {
        if (event.type === 'message_delta') yield { ...event, stopReason: reason === 'unreadable' ? 'end_turn' : reason };
        else if (event.type === 'message_stop' && reason === 'unreadable') yield { ...event, unreadableToolCall: 'Malformed fixture arguments.' };
        else yield event;
      }
    };
    const { session } = await fixture(t, () => [], { provider, tools: [], turnEndChecks: { openWork: false, completion: false } });
    const events = await turn(session, 'Work.');
    const result = events.find(event => event.type === 'result');
    assert.equal(result.is_error, true);
    assert.equal(requests.length, count);
    assert.equal(result.num_turns, count);
    assert.equal(result.usage.input_tokens, count);
    assert.equal(result.usage.output_tokens, count);
    assert.match(result.result, reason === 'unreadable' ? /tool call/i : new RegExp(reason));
  });

for (const blocks of [[], [text(' \t\n')], [{ type: 'thinking', thinking: 'Considering the fixture.' }]])
  test(`low-level callbacks retain a completed response without answer text (blocks=${blocks[0]?.type ?? 'none'})`, deadline, async t => {
    const root = await mkdtemp(join(tmpdir(), 'halo-empty-owner-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const requests = [], checkpoints = [], responses = [], usages = [];
    const config = { model: 'fixture', maxTokens: 1024, contextWindow: 200_000, maxTurns: 6, maxBudgetUsd: Infinity,
      cwd: root, env: { HOME: root }, systemPrompt: 'Fixture instructions.', thinking: { type: 'disabled' }, thinkingExplicit: true,
      effort: 'high', toolResultBudget: 50_000, includePartialMessages: true, permissionMode: 'bypassPermissions', toolCallingMode: 'native',
      turnEndChecks: { openWork: false, completion: false }, settingSources: [], abortSignal: t.signal };
    const events = [];
    for await (const event of queryLoop(config, scripted(() => blocks, requests), [], 'Work.', {
      onAssistantBlock: frame => checkpoints.push(frame),
      onAssistantMessage: frame => responses.push(frame),
      onUsage: usage => usages.push(usage),
    })) events.push(event);
    assert.equal(requests.length, 1);
    assert.equal(events.at(-1).is_error, false);
    assert.equal(events.at(-1).result, '');
    assert.equal(events.at(-1).usage.input_tokens, 1);
    assert.equal(events.at(-1).usage.output_tokens, 1);
    assert.deepEqual(assistantBlocks(events), blocks);
    assert.deepEqual(checkpoints.flatMap(frame => frame.message.content), blocks);
    assert.equal(responses.length, 1);
    assert.deepEqual(responses[0].message.content, blocks);
    assert.equal(usages.reduce((sum, usage) => sum + (usage.input_tokens ?? 0), 0), 1);
    assert.equal(usages.reduce((sum, usage) => sum + (usage.output_tokens ?? 0), 0), 1);
  });

test('low-level owner callbacks receive both check answers and account every response once', deadline, async t => {
  const root = await mkdtemp(join(tmpdir(), 'halo-turn-end-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [], checkpoints = [], responses = [], usages = [];
  const goal = { objective: 'Finish fixture work', doneWhen: ['Verified'], status: 'active' };
  const config = { model: 'fixture', maxTokens: 1024, contextWindow: 200_000, maxTurns: 6, maxBudgetUsd: Infinity,
    cwd: root, env: { HOME: root }, systemPrompt: 'Fixture instructions.', thinking: { type: 'disabled' }, thinkingExplicit: true,
    effort: 'high', toolResultBudget: 50_000, includePartialMessages: true, permissionMode: 'bypassPermissions', toolCallingMode: 'native',
    turnEndChecks: { openWork: true, completion: false }, settingSources: [], abortSignal: new AbortController().signal };
  const provider = scripted(step => ({ 1: [text('OWNER ANSWER A')], 2: [text('OWNER ANSWER B')] })[step], requests);
  const events = [];
  for await (const event of queryLoop(config, provider, [], 'Work.', {
    getGoal: () => goal,
    onAssistantBlock: (frame, responseUuid) => { assert.equal(typeof responseUuid, 'string'); checkpoints.push(frame); },
    onAssistantMessage: frame => responses.push(frame),
    onUsage: usage => usages.push(usage),
  })) events.push(event);
  assert.equal(resultOf(events), 'OWNER ANSWER B');
  assert.equal(requests.length, 2);
  for (const answer of ['OWNER ANSWER A', 'OWNER ANSWER B']) {
    assert.equal(checkpoints.filter(frame => JSON.stringify(frame.message.content).includes(answer)).length, 1);
    assert.equal(responses.filter(frame => JSON.stringify(frame.message.content).includes(answer)).length, 1);
  }
  assert.equal(usages.reduce((sum, usage) => sum + (usage.input_tokens ?? 0), 0), 2);
  assert.equal(usages.reduce((sum, usage) => sum + (usage.output_tokens ?? 0), 0), 2);
  assert.equal(events.at(-1).usage.input_tokens, 2);
  assert.equal(events.at(-1).usage.output_tokens, 2);
});

test('persistent resume retains check text, mixed tool text and exact response usage', deadline, async t => {
  const root = await mkdtemp(join(tmpdir(), 'halo-turn-end-persistence-'));
  const requests = [], resumedRequests = [];
  let session, resumed;
  t.after(async () => {
    await resumed?.[Symbol.asyncDispose]();
    await session?.[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  });
  const options = { cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') }, model: 'fixture',
    persistSession: true, tools: ['TodoWrite', 'Goal', 'Glob'], collaboration: false, settingSources: [], skillCatalog: [],
    systemPrompt: 'Fixture instructions.', thinking: { type: 'disabled' }, permissionMode: 'bypassPermissions' };
  session = await createSession({ ...options, provider: scripted(step => ({
    1: [todos(['work', 'pending'])], 2: [text('PERSISTED ANSWER A')],
    3: [text('PERSISTED MIXED TEXT'), todos(['work', 'completed'])], 4: [text('PERSISTED ANSWER B')],
  })[step], requests) });
  const first = await turn(session, 'Plan it.');
  assert.equal(resultOf(first), 'PERSISTED ANSWER B');
  const id = session.sessionId;
  await session[Symbol.asyncDispose]();
  const recorded = await getSessionMessages(id, options);
  const assistant = recorded.filter(event => event.type === 'assistant');
  const expected = ['PERSISTED ANSWER A', 'PERSISTED MIXED TEXT', 'PERSISTED ANSWER B'];
  assert.deepEqual(assistantBlocks(recorded).filter(block => block.type === 'text').map(block => block.text), expected);
  assert.equal(assistant.reduce((sum, event) => sum + (event.message.usage?.input_tokens ?? 0), 0), 4);
  assert.equal(assistant.reduce((sum, event) => sum + (event.message.usage?.output_tokens ?? 0), 0), 4);
  assert.equal(assistantBlocks(recorded).filter(block => block.type === 'tool_use').length, 2);
  resumed = await createSession({ ...options, resume: id, strictResume: true,
    provider: scripted(() => [text('RESUMED ANSWER')], resumedRequests) });
  const next = await turn(resumed, 'A plain question.');
  assert.equal(resultOf(next), 'RESUMED ANSWER');
  assert.equal(resumedRequests.length, 1);
  assert.deepEqual(requestBlocks(resumedRequests[0]).filter(block => block.type === 'text' && expected.includes(block.text)).map(block => block.text), expected);
  assert.equal(assistantBlocks(next).some(block => block.type === 'tool_use'), false);
  assert.equal(requests.length, 4);
});

test('host goal updates during a check are retained and reach the next model request', deadline, async t => {
  let session;
  const f = await fixture(t, step => {
    if (step === 3) session.setGoal({ objective: 'LATEST_HOST_GOAL', doneWhen: ['Use latest direction'] });
    return ({ 1: [todos(['work', 'pending'])], 2: [text('ANSWER')], 3: [text('CHECK ANSWER')],
      4: [text('LATEST GOAL ANSWER')], 5: [text('NEXT ANSWER')] })[step];
  });
  session = f.session;
  const events = await turn(session, 'Work.');
  assert.equal(session.getGoal().objective, 'LATEST_HOST_GOAL');
  assert.deepEqual(assistantBlocks(events).filter(block => block.type === 'text').map(block => block.text),
    ['ANSWER', 'CHECK ANSWER', 'LATEST GOAL ANSWER']);
  assert.equal(resultOf(events), 'LATEST GOAL ANSWER');
  assert.match(f.requests[3], /LATEST_HOST_GOAL/);
  assert.match(f.requests[3], /work still open/);
  assert.equal(f.requests.length, 4);
  assert.ok(events.some(event => event.type === 'system' && event.subtype === 'goal_updated'
    && event.source === 'user' && event.goal.objective === 'LATEST_HOST_GOAL'));
});

for (const withGoal of [false, true]) test(`todo reminders repeat after quiet requests (goal=${withGoal})`, deadline, async t => {
  const { session, requests } = await fixture(t, step => step === 1 ? [todos(['write it', 'in_progress'], ['test it', 'pending'])]
    : step <= 40 ? [call(`work-${step}`, 'Glob', { pattern: '*' })] : [text('Done.')], {
      ...(withGoal ? { goal: { objective: 'Finish the work', doneWhen: ['Verified'] } } : {}),
      turnEndChecks: { openWork: false, completion: false },
    });
  await turn(session, 'Work through the list.');
  const reminded = requests.map((messages, index) => /Todo reminder — unchanged for/.test(messages) ? index + 1 : 0).filter(Boolean);
  assert.equal(reminded[0], 17, 'first reminder after fifteen quiet requests');
  assert.match(requests[16], /\[~\] write it/);
  assert.match(requests[16], /\[ \] test it/);
  assert.equal(requests[15].includes('Todo reminder — unchanged for'), false);
  assert.equal(requests[31].includes('Todo reminder — unchanged for 15 steps:'), true, 'it repeats after another quiet stretch');
});

test('changing the todo list restarts the quiet count', deadline, async t => {
  const { session, requests } = await fixture(t, step => step === 1 ? [todos(['write it', 'in_progress'])]
    : step === 10 ? [todos(['write it', 'completed'], ['test it', 'in_progress'])]
    : step <= 40 ? [call(`work-${step}`, 'Glob', { pattern: '*' })] : [text('Done.')], { turnEndChecks: { openWork: false, completion: false } });
  await turn(session, 'Work through the list.');
  const reminded = requests.map((messages, index) => /Todo reminder — unchanged for/.test(messages) ? index + 1 : 0).filter(Boolean);
  assert.equal(reminded[0], 26, 'counted from the last change at request 10');
});

test('a model-written answer to AskUserQuestion is not a user decision', deadline, async t => {
  const questions = [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }];
  const script = step => ({ 1: [call('ask', 'AskUserQuestion', { questions, answers: { 'Which one?': 'MODEL CHOICE' }, annotations: { 'Which one?': { notes: 'MODEL NOTE' } } })], 2: [text('Noted.')] })[step];
  const asked = await fixture(t, script, { tools: ['AskUserQuestion'], permissionMode: 'default', turnEndChecks: { openWork: false, completion: false },
    canUseTool: async (name, input) => { assert.equal(input.answers, undefined); assert.equal(input.annotations, undefined); return { behavior: 'allow', updatedInput: { ...input, answers: { 'Which one?': 'USER CHOICE' } } }; } });
  const results = events => events.filter(event => event.type === 'user');
  const events = await turn(asked.session, 'Ask me.');
  assert.ok(everywhere(results(events), 'USER CHOICE'));
  assert.equal(everywhere(results(events), 'MODEL CHOICE'), false);
  assert.equal(everywhere(results(events), 'MODEL NOTE'), false);
  const unattended = await fixture(t, script, { tools: ['AskUserQuestion'], permissionMode: 'bypassPermissions', turnEndChecks: { openWork: false, completion: false } });
  const withoutHost = await turn(unattended.session, 'Ask me.');
  assert.equal(everywhere(results(withoutHost), 'MODEL CHOICE'), false, 'without a host answer the question stays unanswered');
});

test('Grep reports the searched path, honours a glob with a directory part and names the filters when nothing matches', deadline, async t => {
  const root = await mkdtemp(join(tmpdir(), 'halo-grep-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src/core'), { recursive: true }); await mkdir(join(root, 'tests'), { recursive: true }); await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'src/core/a.ts'), 'line\n// needle in src\n'); await writeFile(join(root, 'tests/b.ts'), '// needle in tests\n'); await writeFile(join(root, 'docs/c.md'), 'needle in docs\n');
  const link = join(tmpdir(), `halo-grep-link-${process.pid}`);
  await symlink(root, link); t.after(() => rm(link, { force: true }));
  const searches = [
    { pattern: 'needle', path: root, glob: '{src,tests}/**/*.ts', output_mode: 'content' },
    { pattern: 'needle', path: link, glob: 'src/**/*.ts', output_mode: 'files_with_matches' },
    { pattern: 'needle', path: join(root, 'src/core/a.ts'), output_mode: 'content' },
    { pattern: 'needle', path: root, glob: 'docs/**/*.ts' },
    { pattern: 'needle', path: join(root, 'missing') },
  ];
  const { session } = await fixture(t, step => step <= searches.length ? [call(`g${step}`, 'Grep', searches[step - 1])] : [text('Done.')],
    { tools: ['Grep'], cwd: root, turnEndChecks: { openWork: false, completion: false } });
  const events = await turn(session, 'Search.');
  const results = events.filter(event => event.type === 'user').flatMap(event => event.message.content.filter(block => block.type === 'tool_result')).map(block => String(typeof block.content === 'string' ? block.content : JSON.stringify(block.content)));
  assert.equal(results.length, searches.length);
  assert.match(results[0], new RegExp(`${root}/src/core/a\\.ts:2:// needle in src`));
  assert.match(results[0], new RegExp(`${root}/tests/b\\.ts:1:// needle in tests`));
  assert.equal(results[0].includes('docs'), false);
  assert.ok(results[1].startsWith(`${link}/src/core/a.ts`), results[1]);
  assert.match(results[2], /^2:\/\/ needle in src/, 'one explicit file is printed without its name, as rg does');
  assert.match(results[3], /No matches found.*with glob "docs\/\*\*\/\*\.ts"/);
  assert.match(results[4], /missing/);
});

test('zsh passes a pattern that matches nothing on to the command, as bash does', deadline, async t => {
  try { await access('/bin/zsh'); } catch { t.skip('zsh is not installed'); return; }
  const { session } = await fixture(t, step => step === 1 ? [call('sh', 'Bash', { command: 'echo before; echo /definitely-missing-dir/*.nothing; echo after' })] : [text('Done.')],
    { tools: ['Bash'], env: { HOME: tmpdir(), AGENT_SHELL: '/bin/zsh', PATH: process.env.PATH }, turnEndChecks: { openWork: false, completion: false } });
  const events = await turn(session, 'Run it.');
  const output = JSON.stringify(events.filter(event => event.type === 'user'));
  assert.match(output, /before/); assert.match(output, /\/definitely-missing-dir\/\*\.nothing/); assert.match(output, /after/);
  assert.equal(output.includes('no matches found'), false);
});
