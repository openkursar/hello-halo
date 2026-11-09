import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { queryLoop, resolveQueryConfig } from '../dist/index.js';

const { values } = parseArgs({ options: {
  repetitions: { type: 'string', default: '3' }, warmup: { type: 'string', default: '1' },
  output: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('node validation/streaming.mjs [--repetitions 3] [--warmup 1] [--output report.json]');
  process.exit(0);
}
const integer = (name, minimum) => {
  const value = Number(values[name]);
  assert(Number.isInteger(value) && value >= minimum && value <= 20, `${name} must be ${minimum}..20`);
  return value;
};
const repetitions = integer('repetitions', 1);
const warmup = integer('warmup', 0);
const capabilities = { streaming: true, toolCalling: true, thinking: false, imageInput: false,
  pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' };
const usage = { input_tokens: 100, output_tokens: 40 };
const expectedIds = ['call-0', 'call-1', 'call-2', 'call-3'];
const elapsed = start => Math.round((performance.now() - start) * 10) / 10;

async function run(mode, scenario = 'overlap') {
  const directory = await mkdtemp(join(tmpdir(), 'halo-streaming-benchmark-'));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Scenario deadline exceeded')), 5000);
  const started = performance.now();
  const calls = [];
  const events = [];
  let active = 0;
  let maximumActive = 0;
  let writing = false;
  let requests = 0;
  let permissions = 0;
  let streamEndMs;
  const staggerMs = scenario === 'overlap' ? 40 : 0;
  const tailMs = scenario === 'overlap' ? 160 : 0;
  const toolMs = scenario === 'overlap' ? 220 : scenario === 'cancel' ? 1000 : 40;
  const names = scenario === 'barrier' ? ['ReadFixture', 'WriteFixture', 'ReadFixture', 'ReadFixture']
    : Array(4).fill('ReadFixture');

  const makeTool = (name, safe) => ({
    name, description: 'Offline validation fixture.', permissionLevel: safe ? 'readonly' : 'write',
    inputSchema: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] },
    isConcurrencySafe: () => safe,
    async execute(input, context) {
      assert.equal(context.toolUseId, `call-${input.index}`);
      assert(!calls.includes(input.index), 'A tool call executed more than once');
      assert(!writing, 'A call overlapped an exclusive write');
      if (!safe) assert.equal(active, 0, 'An exclusive write overlapped a previous read');
      calls.push(input.index);
      active++;
      maximumActive = Math.max(maximumActive, active);
      writing = !safe;
      events.push({ type: 'start', index: input.index, atMs: elapsed(started) });
      if (scenario === 'cancel' && calls.length === 2) controller.abort(new Error('Fixture cancellation'));
      try {
        await delay(toolMs, undefined, { signal: context.abortSignal });
        events.push({ type: 'finish', index: input.index, atMs: elapsed(started) });
        return { content: `done:${input.index}`, isError: false };
      } finally {
        active--;
        if (!safe) writing = false;
      }
    },
  });

  async function* response(request, first) {
    const signal = request.providerOptions.signal;
    yield { type: 'message_start', id: `response-${requests}`, model: request.model, usage };
    if (first) {
      for (let index = 0; index < names.length; index++) {
        if (index && staggerMs) await delay(staggerMs, undefined, { signal });
        yield { type: 'content_block_start', index,
          content_block: { type: 'tool_use', id: `call-${index}`, name: names[index], input: { index } } };
        yield { type: 'content_block_stop', index };
      }
      if (tailMs) await delay(tailMs, undefined, { signal });
    } else {
      const results = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(block => block.type === 'tool_result');
      assert.deepEqual(results.map(result => result.tool_use_id), expectedIds);
      assert.deepEqual(results.map(result => result.content), [0, 1, 2, 3].map(index => `done:${index}`));
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Verified.' } };
      yield { type: 'content_block_stop', index: 0 };
    }
    yield { type: 'message_delta', stopReason: first ? 'tool_use' : 'end_turn', usage };
    yield { type: 'message_stop' };
    if (first) streamEndMs = elapsed(started);
  }
  const provider = {
    id: 'offline-script', name: 'Offline scripted provider', capabilities: () => capabilities,
    async createMessage() { throw new Error('Unexpected model summary request'); },
    async *createMessageStream(request) {
      const first = requests++ === 0;
      const source = response(request, first);
      if (mode === 'buffered' && first) {
        const buffered = [];
        for await (const event of source) buffered.push(event);
        yield* buffered;
      } else yield* source;
    },
  };

  try {
    const config = resolveQueryConfig({
      cwd: directory, model: 'offline-script', systemPrompt: 'Run the supplied fixture.',
      settingSources: [], env: {}, abortController: controller, permissionMode: 'default',
      maxTurns: 3, thinking: { type: 'disabled' }, includePartialMessages: true,
      turnEndChecks: { openWork: false, completion: false },
      canUseTool: async (_name, input) => { permissions++; return { behavior: 'allow', updatedInput: input }; },
    });
    const messages = [];
    for await (const message of queryLoop(config, provider,
      [makeTool('ReadFixture', true), makeTool('WriteFixture', false)], 'Run the fixture.')) messages.push(message);
    const results = messages.filter(message => message.type === 'result');
    assert.equal(results.length, 1, 'Exactly one terminal result is required');
    assert.equal(active, 0, 'A tool remained active after completion');
    if (scenario === 'cancel') {
      assert.equal(results[0].is_error, true);
      assert.equal(requests, 1);
      assert.deepEqual(calls, [0, 1]);
      assert.equal(events.filter(event => event.type === 'finish').length, 0);
    } else {
      assert.equal(results[0].is_error, false);
      assert.equal(results[0].result, 'Verified.');
      assert.equal(requests, 2);
      assert.equal(permissions, 4);
      assert.deepEqual(calls, [0, 1, 2, 3]);
      assert.equal(events.filter(event => event.type === 'finish').length, 4);
      assert(maximumActive >= 2, 'Safe tool calls were serialized');
      if (mode === 'streaming' && scenario === 'overlap') {
        assert(events[0].atMs < streamEndMs, 'No tool started before the response ended');
      }
      if (mode === 'buffered') assert(events[0].atMs >= streamEndMs);
    }
    return { wallMs: elapsed(started), apiMs: results[0].duration_api_ms, requests, permissions,
      maximumActive, executionOrder: calls, streamEndMs, events };
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
};
const fingerprint = createHash('sha256');
const fingerprintFiles = ['index.js', 'core/query-loop.js', 'core/streaming-turn.js',
  'core/tool-scheduler.js', 'core/tool-execution.js'];
for (const file of fingerprintFiles) fingerprint.update(file).update(await readFile(new URL(`../dist/${file}`, import.meta.url)));
const samples = { streaming: [], buffered: [] };
for (let repetition = -warmup; repetition < repetitions; repetition++) {
  for (const mode of repetition % 2 === 0 ? ['streaming', 'buffered'] : ['buffered', 'streaming']) {
    const result = await run(mode);
    if (repetition >= 0) samples[mode].push(result);
  }
}
const streamingMs = median(samples.streaming.map(sample => sample.wallMs));
const bufferedMs = median(samples.buffered.map(sample => sample.wallMs));
const report = {
  checkedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  buildFingerprint: fingerprint.digest('hex'), fingerprintFiles, repetitions, warmup,
  workload: { tools: 4, toolMs: 220, staggerMs: 40, streamTailMs: 160, permissionCallback: true },
  comparison: 'Same compiled SDK and scripted events; buffered control withholds events until the response ends.',
  medianWallMs: { streaming: streamingMs, buffered: bufferedMs },
  improvementPercent: Math.round((1 - streamingMs / bufferedMs) * 1000) / 10,
  samples,
  checks: { exclusiveBarrier: await run('streaming', 'barrier'), cancellation: await run('streaming', 'cancel') },
};
if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
