import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { startWireServer, plan } from './wire-server.mjs';
import { measurePreviewMemory } from './preview-memory.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = data => { if (process.connected) process.send(data); };
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
let sessions = new Set();
let wire;
let results = 0;
let toolCalls = 0;
let compactions = 0;
let thinkingBlocks = 0;
let expectNoThinking = false;
let usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
const sample = async label => {
  if (label) global.gc?.();
  send({ type: 'sample', label, time: Date.now(), ...process.memoryUsage(),
    eventLoopMaxMs: lag.max / 1e6, results, toolCalls, usage, activeSessions: sessions.size });
  lag.reset();
  if (label) await new Promise(resolve => {
    const acknowledge = message => {
      if (message.type === 'sample-ack' && message.label === label) { process.off('message', acknowledge); resolve(); }
    };
    process.on('message', acknowledge);
  });
};
const timer = setInterval(() => sample(), 2000);

async function turn(session, prompt, allowError = false) {
  await session.send(prompt);
  let outcome;
  const calls = [];
  const toolErrors = [];
  try {
  for await (const message of session.stream()) {
    if (message.type === 'system' && message.subtype === 'compact_boundary') compactions++;
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          thinkingBlocks++;
          assert.equal(expectNoThinking, false, 'Provider returned thinking after it was explicitly disabled');
        }
        if (block.type === 'tool_use') { calls.push(block.name); toolCalls++; }
      }
    }
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_result' && block.is_error) toolErrors.push(String(block.content).slice(0, 4096));
      }
    }
    if (message.type === 'result') { outcome = message; break; }
  }
  } catch (error) {
    if (allowError && error.name === 'AbortError') return { text: '', calls, aborted: true };
    throw error;
  }
  if (!outcome && allowError) return { text: '', calls, closed: true };
  assert.ok(outcome, 'Turn must emit a terminal result');
  results++;
  usage.input += outcome.usage?.input_tokens ?? 0;
  usage.output += outcome.usage?.output_tokens ?? 0;
  usage.cacheRead += outcome.usage?.cache_read_input_tokens ?? 0;
  usage.cacheCreation += outcome.usage?.cache_creation_input_tokens ?? 0;
  if (!allowError) assert.equal(outcome.is_error, false, `Turn failed: ${outcome.result}`);
  return { text: outcome.result, calls, outcome, toolErrors };
}

async function close(session) {
  session.close();
  await session.flush();
  sessions.delete(session);
}

async function waitFile(file, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = (await fs.readFile(file, 'utf8')).trim();
      if (/^[1-9]\d*$/.test(value)) return value;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(50);
  }
  throw new Error('Expected process readiness file was never created');
}

async function registerChild(pid) {
  await new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timeout);
      process.off('message', acknowledge);
      if (error) reject(error); else resolve();
    };
    const acknowledge = message => {
      if (message.type === 'child-ack' && message.pid === pid) {
        finish(message.owned ? undefined : new Error('The supervisor could not verify subprocess ownership'));
      }
    };
    const timeout = setTimeout(() => finish(new Error('Subprocess ownership verification timed out')), 10000);
    process.on('message', acknowledge);
    send({ type: 'owned-child', pid });
  });
}

async function main(config) {
  expectNoThinking = config.live && (config.thinking ?? 'disabled') === 'disabled';
  const sdk = await import(pathToFileURL(join(config.sdk, 'dist/index.js')));
  wire = config.live ? undefined : await startWireServer();
  const provider = sdk.createProvider(config.live ? {
    type: config.providerType ?? 'anthropic', baseUrl: config.baseUrl ?? 'https://api.deepseek.com/anthropic',
    apiKey: config.key, defaultModel: config.model,
    ...(config.providerType === 'openai-compat' ? { quirks: { includeUsageInStream: true, reasoningField: 'reasoning_content', reasoningEffort: !!config.effort } } : {}),
  } : { type: 'openai-compat', baseUrl: wire.url, apiKey: 'fixture', defaultModel: 'wire-fixture', quirks: { includeUsageInStream: true } });
  const options = cwd => ({ provider, model: config.live ? config.model : 'wire-fixture', cwd,
    env: { SDK_VALIDATION_CONFIG: join(config.sandbox, 'state') },
    conventions: { configDirEnv: 'SDK_VALIDATION_CONFIG', memoryFiles: [], memorySubdirs: [], agentDirs: [] },
    permissionMode: 'bypassPermissions', toolCallingMode: 'native', thinking: { type: config.thinking ?? 'disabled' },
    ...(config.effort ? { effort: config.effort } : {}),
    maxOutputTokens: config.maxOutputTokens ?? 2048, maxTurns: 12, contextWindow: config.contextWindow,
    turnEndChecks: { openWork: false, completion: false },
    tools: ['Read', 'Write', 'Edit', 'Bash', 'spawn_agent', 'TaskOutput', 'TaskStop'],
    systemPrompt: 'Perform the requested test task using the named tools. Work only in the working directory. Be concise. Never claim success without executing the requested operations.',
  });
  const open = async (cwd, resume, overrides = {}) => {
    const session = await sdk.createSession({ ...options(cwd), ...overrides, ...(resume ? { resume } : {}) });
    sessions.add(session);
    return session;
  };
  const prompt = (live, calls, result) => config.live ? live : plan(calls, result);
  await fs.mkdir(config.sandbox, { recursive: true });

  if (config.scenario === 'recovery') {
    const cwd = join(config.sandbox, 'recovery');
    await fs.mkdir(cwd, { recursive: true });
    const nonce = randomUUID();
    const session = await open(cwd);
    const reply = await turn(session, prompt(`Remember this value: ${nonce}. Use Write to create receipt.txt containing exactly that value. Then reply DONE.`,
      [{ name: 'Write', input: { file_path: join(cwd, 'receipt.txt'), content: nonce } }], nonce));
    assert.ok(reply.calls.includes('Write'));
    await session.flush();
    send({ type: 'crash-ready', sessionId: session.sessionId, cwd, nonce });
    await new Promise(() => {});
  }

  if (config.scenario === 'resume') {
    const { cwd, nonce, sessionId } = config.recovery;
    assert.equal(await fs.readFile(join(cwd, 'receipt.txt'), 'utf8'), nonce);
    const session = await open(cwd, sessionId);
    const reply = await turn(session, prompt('Reply with only the remembered value from the previous turn. Do not use any tools.', [], nonce));
    assert.ok(reply.text.includes(nonce), 'A new process must recover the completed turn');
    assert.equal(reply.calls.length, 0);
    await close(session);
    return;
  }

  // Warm lazy SDK/provider caches before measuring retained memory.
  const warm = await open(config.sandbox);
  await turn(warm, prompt('Reply only READY.', [], 'READY'));
  await close(warm);
  await sample('baseline');
  const deadline = performance.now() + config.durationSeconds * 1000;
  let rounds = 0;
  const workers = await Promise.all(Array.from({ length: config.concurrency }, async (_, index) => {
    const cwd = join(config.sandbox, `session-${index}`);
    await fs.mkdir(cwd, { recursive: true });
    return { cwd, nonce: '', session: await open(cwd, undefined, { tools: ['Read', 'Write'] }) };
  }));
  do {
    const roundStarted = performance.now();
    await Promise.all(workers.map(async worker => {
      worker.nonce = randomUUID();
      const input = join(worker.cwd, 'seed.txt');
      await fs.writeFile(input, worker.nonce);
      const output = join(worker.cwd, `result-${rounds}.txt`);
      const value = `${worker.nonce}:${rounds}`;
      const reply = await turn(worker.session, prompt(
        `The input file changed for this round. Use Read to read ${input}. Use Write to create ${output} containing the new seed value followed by :${rounds}. A final newline is allowed. Reply DONE.`,
        [{ name: 'Read', input: { file_path: input } },
          { name: 'Write', input: { file_path: output, content: value } }], 'DONE'));
      assert.ok(reply.calls.includes('Read') && reply.calls.includes('Write'), 'The model must use real file tools');
      assert.equal((await fs.readFile(output, 'utf8')).trim(), value, 'Session data must not cross conversation boundaries');
      await fs.rm(output);
      if (rounds % 5 === 4) {
        const id = worker.session.sessionId;
        await close(worker.session);
        worker.session = await open(worker.cwd, id, { tools: ['Read', 'Write'] });
        const recall = await turn(worker.session, prompt('What is the most recent seed value you read? Reply with only that value; use no tools.', [], worker.nonce));
        assert.ok(recall.text.includes(worker.nonce));
        assert.equal(recall.calls.length, 0);
      }
    }));
    rounds++;
    await sample(`round-${rounds}`);
    send({ type: 'progress', rounds, results, toolCalls, usage });
    if (rounds >= config.rounds && performance.now() >= deadline) break;
    const remaining = rounds >= config.rounds ? Math.max(0, deadline - performance.now()) : Infinity;
    const pause = Math.min(remaining, (config.roundIntervalSeconds ?? 0) * 1000 - (performance.now() - roundStarted));
    if (pause > 0) await delay(pause);
  } while (rounds < config.rounds || (config.durationSeconds > 0 && performance.now() < deadline));
  for (const worker of workers) await close(worker.session);

  const cwd = join(config.sandbox, 'lifecycle');
  await fs.mkdir(cwd, { recursive: true });
  const boundarySession = await open(cwd);
  const fixtures = join(config.sandbox, 'fixtures');
  await fs.mkdir(fixtures, { recursive: true });
  const large = join(fixtures, 'large.bin');
  const file = await fs.open(large, 'w');
  await file.truncate(1024 ** 3);
  await file.close();
  const refused = await turn(boundarySession, prompt(
    `Use Read with limit 1 to read ${large}. If it refuses the file size, report that refusal. Do not try a different tool or read the file with Bash.`,
    [{ name: 'Read', input: { file_path: large, limit: 1 } }], 'REFUSED'));
  assert.ok(refused.calls.includes('Read'));
  assert.ok(refused.toolErrors.some(error => error.includes('limit')), 'Oversized file must be rejected by the real tool');
  await fs.rm(large);
  const flood = join(cwd, 'flood.mjs');
  await fs.writeFile(flood, "for(let i=0;i<512;i++)process.stdout.write('x'.repeat(65536));process.stdout.write('FINAL_MARKER');");
  const floodCommand = `${quote(process.execPath)} ${quote(flood)}`;
  const flooded = await turn(boundarySession, prompt(
    `Use Bash with run_in_background=true to run this exact command: ${floodCommand}. Then use TaskOutput with block=true to wait for that task. Report whether its output was truncated. Do not read the output file or rerun the command.`,
    [{ name: 'Bash', input: { command: floodCommand, run_in_background: true } },
      { name: 'TaskOutput', input: { task_id: '$LAST_TASK', block: true, timeout: 30000 } }], 'TRUNCATED'));
  assert.ok(flooded.calls.includes('Bash') && flooded.calls.includes('TaskOutput'));
  const outputDirectory = join(config.sandbox, 'state', 'bash-output');
  const outputs = (await fs.readdir(outputDirectory)).filter(name => name.endsWith('.output'));
  assert.ok(outputs.length > 0);
  for (const name of outputs) {
    const path = join(outputDirectory, name);
    const size = (await fs.stat(path)).size;
    assert.ok(size <= 8 * 1024 * 1024);
    const handle = await fs.open(path, 'r');
    const tail = Buffer.alloc(256);
    const read = await handle.read(tail, 0, tail.length, Math.max(0, size - tail.length));
    await handle.close();
    assert.ok(tail.subarray(0, read.bytesRead).toString('utf8').includes('Output truncated'));
  }
  await close(boundarySession);
  const helper = join(cwd, 'wait.mjs');
  const pidFile = join(cwd, 'child.pid');
  await fs.writeFile(helper, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{}, 1000);`);
  for (let iteration = 0; iteration < config.cancelCycles; iteration++) {
    await fs.rm(pidFile, { force: true });
    const session = await open(cwd);
    const command = `${quote(process.execPath)} ${quote(helper)}`;
    const pending = turn(session, prompt(`Use Bash to run this exact command in the foreground: ${command}. Wait for it to finish.`,
      [{ name: 'Bash', input: { command, timeout: 120_000 } }], 'STOPPED'), true);
    // Observe execution before cancellation; no sleep-based assumption about model latency.
    const pid = Number(await waitFile(pidFile));
    await registerChild(pid);
    const before = Date.now();
    if (iteration % 2 === 0) await session.interrupt();
    else await close(session);
    const stopped = await pending;
    if (iteration % 2 === 0) {
      assert.equal(stopped.outcome?.subtype, 'error_during_execution', 'Interrupt must settle the turn with a terminal result');
      assert.ok(stopped.toolErrors?.some(error => error.includes('Interrupted by user')), 'Interrupted tool calls must receive matching results');
    }
    assert.ok(Date.now() - before < 12_000, 'Cancellation must finish within its grace period');
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
      if (i === 99) throw new Error('Cancelled command left a child process alive');
      await delay(50);
    }
    const recoveredSession = iteration % 2 === 0 ? session : await open(cwd);
    const reply = await turn(recoveredSession, prompt('Reply only RECOVERED.', [], 'RECOVERED'));
    assert.ok(reply.text.includes('RECOVERED'));
    await close(recoveredSession);
  }

  if (wire) {
    const stalled = await open(cwd);
    const pending = turn(stalled, plan([], 'UNREACHABLE', { stall: true }), true);
    const deadline = Date.now() + 5000;
    while (wire.metrics().active === 0 && Date.now() < deadline) await delay(20);
    assert.ok(wire.metrics().active > 0, 'The provider request must actually reach the peer');
    await stalled.interrupt();
    await pending;
    await close(stalled);
    await delay(100);
    assert.equal(wire.metrics().active, 0, 'Cancellation must close the stalled HTTP stream');
    const truncated = await open(cwd);
    const timeout = setTimeout(() => { void truncated.interrupt(); }, 30000);
    try {
      const reply = await turn(truncated, plan([], 'UNREACHABLE', { truncate: true }), true);
      assert.ok(reply.outcome?.is_error, 'Truncated SSE must emit an error, never a successful partial answer');
    } finally { clearTimeout(timeout); await close(truncated); }
  }

  const session = await open(cwd);
  const collaboratorFile = join(cwd, 'collaborator-result.txt');
  const collaboratorNonce = randomUUID();
  const childPrompt = prompt(`Use Write to create ${collaboratorFile} containing exactly ${collaboratorNonce}. Reply with that value.`,
    [{ name: 'Write', input: { file_path: collaboratorFile, content: collaboratorNonce } }], collaboratorNonce);
  const reply = await turn(session, prompt(`Use spawn_agent to delegate this task to a collaborator: ${childPrompt}. After it finishes, report its result.`,
    [{ name: 'mcp__halo-team__spawn_agent', input: { name: 'writer', prompt: childPrompt } }], collaboratorNonce));
  assert.ok(reply.calls.includes('mcp__halo-team__spawn_agent'));
  assert.equal((await fs.readFile(collaboratorFile, 'utf8')).trim(), collaboratorNonce);
  await close(session);
  const previewMemory = await measurePreviewMemory(sdk, join(config.sandbox, 'fixtures'));
  assert.ok(previewMemory.retainedHeapGrowthBytes <= previewMemory.limitBytes,
    'Small file previews must not retain the full source allocations');
  await delay(250);
  if (expectNoThinking) assert.equal(thinkingBlocks, 0, 'The requested disabled thinking mode must be honored by the provider');
  if (config.requireCompaction) assert.ok(compactions > 0, 'The configured test must actually trigger model compaction');
  await sample('final');
  send({ type: 'checks', passed: ['concurrent-file-work', 'session-isolation', 'cancel-recreate', 'collaborator-delegation', 'large-file-refusal', 'bounded-background-output'], rounds,
    requests: wire?.metrics().requests, results, toolCalls, usage, previewMemory, compactions, thinkingBlocks });
}

let finishing = false;
process.once('disconnect', async () => {
  if (finishing) return;
  finishing = true;
  process.exitCode = 1;
  console.error('Validation supervisor disconnected; closing owned sessions');
  const deadline = setTimeout(() => process.exit(1), 12000);
  try {
    await Promise.allSettled([...sessions].map(session => close(session)));
    await wire?.close();
  } finally {
    clearTimeout(deadline);
    process.exit(1);
  }
});

process.once('message', async config => {
  try {
    await main(config);
    send({ type: 'done' });
  } catch (error) {
    send({ type: 'failure', error: error.stack?.replaceAll(config.key || '\0', '[REDACTED]') ?? String(error) });
    process.exitCode = 1;
  } finally {
    finishing = true;
    for (const session of sessions) await close(session);
    await wire?.close();
    clearInterval(timer);
    lag.disable();
    if (process.connected) process.disconnect();
  }
});
