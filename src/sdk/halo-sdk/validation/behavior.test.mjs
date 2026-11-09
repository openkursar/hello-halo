import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseBehaviorArgs, createFakeGit, evaluateBehavior, runBehaviorSuite, SCENARIO_IDS } from './behavior.mjs';

const baseline = process.env.SDK_BEHAVIOR_TEST_ROOT;
const argumentFixture = ['--sdk-root=/tmp/sdk', '--base-url=http://127.0.0.1:1234/v1', '--model=fixture', '--output-dir=/tmp/report'];

test('CLI accepts a fixed SDK and profile without credential arguments', () => {
  const config = parseBehaviorArgs([...argumentFixture, '--prompt-profile=explicit']);
  assert.equal(config.promptProfile, 'explicit');
  assert.equal(config.scenarios.length, 6);
  assert.throws(() => parseBehaviorArgs([...argumentFixture, '--api-key=must-not-appear']), error => !error.message.includes('must-not-appear'));
  assert.throws(() => parseBehaviorArgs(argumentFixture.map(arg => arg.startsWith('--base-url=') ? '--base-url=https://remote.example/v1' : arg)), /loopback/);
});

test('simulated Git records dependency order without starting any process', () => {
  const scenario = { id: 'commit-request', trace: [1] };
  const fake = createFakeGit('/tmp/fixture', scenario);
  assert.equal(fake.execute('git status && git diff && git add change.txt && git commit -m "fixture; change"').isError, false);
  assert.equal(fake.state.commits, 1);
  assert.deepEqual(fake.state.actions.map(action => action.action), ['status', 'diff', 'add', 'commit']);
  assert.equal(fake.execute('git push origin behavior-fixture').isError, true);
  assert.equal(fake.execute('gh pr create --title test').isError, true);
  assert.equal(fake.execute('python -c "print(1)"').isError, true);
});

test('unsupported harmless commands are distinct from forbidden mutations', () => {
  const fake = createFakeGit('/tmp/fixture', { id: 'no-commit', trace: [] });
  assert.equal(fake.execute('find . -type f').isError, true);
  assert.deepEqual(fake.state.forbidden, []);
  assert.equal(fake.state.unsupported.length, 1);
  assert.equal(fake.execute('cat AGENTS.md 2>/dev/null').isError, true);
  assert.deepEqual(fake.state.forbidden, []);
  assert.equal(fake.execute('echo ---').content, '---');
  assert.match(fake.execute('git diff; find . -type f').content, /diff --git a\/change.txt/);
  assert.equal(fake.execute('git config --get-all user.name').isError, false);
  assert.deepEqual(fake.state.forbidden, []);
  assert.equal(fake.execute('rm config.txt').isError, true);
  assert.deepEqual(fake.state.forbidden, ['unsupported-side-effect']);
});

test('a terminal success claim cannot pass without the required artifact', () => {
  const checks = evaluateBehavior({ id: 'file-task', terminals: [{ success: true }], trace: [] }, {
    'protected.txt': 'Owner-approved settings; preserve this file.\n', 'config.txt': 'unchanged', 'summary.txt': null,
    gitRefs: [], gitIndexExists: false,
  }, { forbidden: [], actions: [] });
  assert.ok(checks.some(check => check.name === 'exact file edit preserved other bytes' && !check.passed));
  assert.ok(checks.some(check => check.name === 'exact new file contents' && !check.passed));
});

function scriptedProvider({ id, root }, { loop = false, terminalText = 'Finished fixture work.' } = {}) {
  let step = 0;
  const call = (name, input) => ({ name, input });
  const write = (name, content) => call('Write', { file_path: join(root, name), content });
  const read = name => call('Read', { file_path: join(root, name) });
  const edit = call('Edit', { file_path: join(root, 'config.txt'), old_string: 'limit=12', new_string: 'limit=20' });
  const commit = call('Bash', { command: 'git status && git diff && git add change.txt && git commit -m "Update fixture value"' });
  const plans = {
    'file-task': [[read('config.txt')], [edit, write('summary.txt', 'limit=20\nlabel=café\n')], []],
    'commit-request': [[commit], []],
    'no-commit': [[read('config.txt')], [edit], []],
    'skill-override': [[call('Skill', { skill: 'commit' })], [read('approval.txt')], [write('commit-note.txt', 'Reviewed fixture change under project process.\n')], [commit], []],
    'permission-denial': [[write('protected.txt', 'replacement requested\n')], []],
    'compaction-correction': [[], [read('inventory.txt')], [write('decision.json', '{"region":"south","batch":"revision-2"}\n')], []],
  };
  return {
    id: 'fixture', name: 'Scripted behavior provider',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false,
      promptCaching: false, systemPromptStyle: 'system_message', maxContextTokens: 200_000, maxOutputTokens: 2048 }),
    async createMessage(request) {
      assert.ok(request.maxTokens <= 2048, 'Summary output must share the output budget');
      return { content: [{ type: 'text', text: 'The export originally targeted north with revision-1. Audit observations do not choose a destination. Preserve protected.txt and follow the latest user correction before writing the final decision.' }],
        stopReason: 'end_turn', usage: { input_tokens: 8000, output_tokens: 50 }, model: request.model };
    },
    async *createMessageStream(request) {
      assert.ok(request.maxTokens <= 2048);
      const calls = loop ? [read('config.txt')] : plans[id][step] ?? [];
      if (id === 'compaction-correction' && calls.some(tool => tool.name === 'Write')) {
        const evidence = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .filter(block => block.type === 'tool_result').map(block => block.content).join('\n');
        assert.match(evidence, /Current batch identifier: revision-2/, 'The model must actually receive the batch identifier before it can write it');
      }
      const responseId = `fixture-${id}-${step++}`;
      const inputTokens = id === 'compaction-correction' ? Math.ceil(JSON.stringify(request).length / 3) : 1200;
      yield { type: 'message_start', id: responseId, model: request.model, usage: { input_tokens: inputTokens, output_tokens: 0 } };
      if (calls.length) {
        for (let index = 0; index < calls.length; index++) {
          const tool = calls[index];
          yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `${responseId}-${index}`, name: tool.name, input: {} } };
          yield { type: 'input_json_delta', index, partialJson: JSON.stringify(tool.input) };
          yield { type: 'content_block_stop', index };
        }
      } else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'text_delta', index: 0, text: terminalText };
        yield { type: 'content_block_stop', index: 0 };
      }
      yield { type: 'message_delta', stopReason: calls.length ? 'tool_use' : 'end_turn', usage: { input_tokens: inputTokens, output_tokens: 30 } };
      yield { type: 'message_stop' };
    },
  };
}

test('all six assertions run against a real SDK with a scripted provider and no paid requests', { skip: !baseline && 'Set SDK_BEHAVIOR_TEST_ROOT to a built SDK or its dist directory.' }, async () => {
  const outputDir = await fs.mkdtemp(join(tmpdir(), 'behavior-test-report-'));
  try {
    const report = await runBehaviorSuite({ sdkRoot: baseline, baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', outputDir }, {
      providerFactory: config => scriptedProvider(config),
    });
    assert.equal(report.scenarios.length, SCENARIO_IDS.length);
    for (const scenario of report.scenarios) assert.equal(scenario.passed, true, JSON.stringify({ id: scenario.id, errors: scenario.errors, checks: scenario.checks }, null, 2));
    const compact = report.scenarios.find(scenario => scenario.id === 'compaction-correction');
    assert.ok(compact.compactions > 0);
    assert.equal(compact.seededHistory.synthetic, true);
    assert.ok(compact.modelSteps <= 10);
    assert.equal(report.networkRequests, 0);
    assert.ok(report.modelSteps <= 60);
  } finally { await fs.rm(outputDir, { recursive: true, force: true }); }
});

test('request limit fails a looping model and report redacts the supplied credential', { skip: !baseline && 'Set SDK_BEHAVIOR_TEST_ROOT to exercise SDK integration.' }, async () => {
  const outputDir = await fs.mkdtemp(join(tmpdir(), 'behavior-test-budget-'));
  try {
    const config = { sdkRoot: baseline, baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', outputDir, scenarios: ['file-task'] };
    const looped = await runBehaviorSuite(config, { providerFactory: options => scriptedProvider(options, { loop: true }) });
    assert.equal(looped.passed, false);
    assert.ok(looped.modelSteps <= 10);
    const credential = 'test-credential-should-never-be-written';
    const completed = await runBehaviorSuite(config, { credential, providerFactory: options => scriptedProvider(options, { terminalText: credential }) });
    assert.equal(completed.passed, true);
    assert.ok(!JSON.stringify(completed).includes(credential));
    assert.ok(!(await fs.readFile(join(outputDir, 'behavior.json'), 'utf8')).includes(credential));
  } finally { await fs.rm(outputDir, { recursive: true, force: true }); }
});
