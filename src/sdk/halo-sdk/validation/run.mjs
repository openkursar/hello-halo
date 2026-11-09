import { promises as fs, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { fork, execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { promisify, parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import { writeReport } from './report.mjs';
import { once } from 'node:events';
import { processTree, processTable, processIdentity, descriptorCount, diskUsage, evaluate } from './metrics.mjs';

const exec = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const source = dirname(directory);
const args = process.argv.slice(2);
const parsedArguments = parseArgs({ args, strict: true, allowPositionals: false, options: {
  profile: { type: 'string' }, model: { type: 'string' }, live: { type: 'boolean' },
  'provider-type': { type: 'string' }, 'base-url': { type: 'string' }, thinking: { type: 'string' },
  'max-output-tokens': { type: 'string' },
  effort: { type: 'string' },
  rounds: { type: 'string' }, concurrency: { type: 'string' }, 'duration-seconds': { type: 'string' },
  'cancel-cycles': { type: 'string' }, 'round-interval-seconds': { type: 'string' }, 'context-window': { type: 'string' }, output: { type: 'string' },
  'require-compaction': { type: 'boolean' }, 'key-stdin': { type: 'boolean' },
  'keep-sandbox': { type: 'boolean' }, help: { type: 'boolean' },
  background: { type: 'boolean' },
} });
if (parsedArguments.values.help) {
  console.log('SDK validation: --profile smoke|soak [--live] [--key-stdin] [--background] [--provider-type anthropic|openai-compat] [--base-url URL] [--model ID] [--thinking disabled|adaptive] [--effort low|medium|high|max] [--max-output-tokens N] [--rounds N] [--concurrency N] [--duration-seconds N] [--round-interval-seconds N] [--context-window N] [--require-compaction] [--output PATH] [--keep-sandbox]. See validation/README.md.');
  process.exit(0);
}
const value = (name, fallback) => parsedArguments.values[name.slice(2)] ?? fallback;
const number = (name, fallback, min, max) => {
  const result = Number(value(name, fallback));
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`Invalid ${name}: expected ${min}..${max}`);
  return result;
};
const profile = value('--profile', 'smoke');
if (!['smoke', 'soak'].includes(profile)) throw new Error('Profile must be smoke or soak');
const live = args.includes('--live');
if (parsedArguments.values.background && process.platform === 'win32') throw new Error('Background validation currently requires macOS or Linux');
const providerType = value('--provider-type', 'anthropic');
if (!['anthropic', 'openai-compat'].includes(providerType)) throw new Error('Provider type must be anthropic or openai-compat');
if (providerType === 'openai-compat' && (!parsedArguments.values['base-url'] || !parsedArguments.values.model)) {
  throw new Error('OpenAI-compatible validation requires explicit --base-url and --model');
}
const baseUrl = value('--base-url', 'https://api.deepseek.com/anthropic').replace(/\/+$/, '');
const endpoint = new URL(baseUrl);
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
  throw new Error('Provider URL must use HTTPS or local HTTP, without credentials, query or fragment');
}
const thinking = value('--thinking', 'disabled');
if (!['disabled', 'adaptive'].includes(thinking)) throw new Error('Thinking mode must be disabled or adaptive');
const effort = value('--effort', undefined);
if (effort && !['low', 'medium', 'high', 'max'].includes(effort)) throw new Error('Effort must be low, medium, high or max');
const legacyKey = baseUrl === 'https://api.deepseek.com/anthropic' ? process.env.DEEPSEEK_API_KEY : undefined;
let key = live ? (process.env.SDK_TEST_API_KEY ?? legacyKey ?? '') : '';
if (live && args.includes('--key-stdin')) {
  const input = readline.createInterface({ input: process.stdin });
  console.log('Waiting for test credential on stdin (not saved)');
  [key] = await once(input, 'line');
  input.close();
  key = key.trim();
}
if (live && !key) throw new Error('Live validation requires SDK_TEST_API_KEY; missing credentials never count as a pass');
const settings = { live, model: value('--model', 'deepseek-flash'), providerType, baseUrl, thinking, effort,
  maxOutputTokens: number('--max-output-tokens', 2048, 256, 32768),
  contextWindow: number('--context-window', 64_000, 4096, 1_000_000),
  requireCompaction: args.includes('--require-compaction'),
  concurrency: number('--concurrency', profile === 'soak' ? 4 : 2, 1, 16),
  rounds: number('--rounds', profile === 'soak' ? 30 : 5, 1, 1000),
  durationSeconds: number('--duration-seconds', profile === 'soak' ? 1800 : 0, 0, 86_400),
  roundIntervalSeconds: number('--round-interval-seconds', 0, 0, 3600),
  cancelCycles: number('--cancel-cycles', profile === 'soak' ? 5 : 2, 1, 50) };
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDirectory = resolve(value('--output', join(directory, 'results', stamp)));
await fs.mkdir(reportDirectory, { recursive: true });
if (parsedArguments.values.background) {
  const forwarded = Object.entries(parsedArguments.values).flatMap(([name, setting]) =>
    ['background', 'key-stdin', 'output'].includes(name) || setting === false || setting === undefined
      ? [] : setting === true ? [`--${name}`] : [`--${name}`, setting]);
  forwarded.push('--output', reportDirectory);
  if (live) forwarded.push('--key-stdin');
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD/i.test(name)) delete env[name];
  const consoleFile = await fs.open(join(reportDirectory, 'console.log'), 'ax', 0o600);
  let child;
  try {
    const command = process.platform === 'darwin' ? '/usr/bin/caffeinate' : process.execPath;
    const parameters = [...(process.platform === 'darwin' ? ['-i', process.execPath] : []), fileURLToPath(import.meta.url), ...forwarded];
    child = spawn(command, parameters, { cwd: source, env, detached: true, stdio: ['pipe', consoleFile.fd, consoleFile.fd] });
    await once(child, 'spawn');
    await new Promise((resolve, reject) => {
      child.stdin.once('error', reject);
      child.stdin.end(live ? `${key}\n` : '', resolve);
    });
    child.stdin.destroy();
    const background = { pid: child.pid, identity: await processIdentity(child.pid), startedAt: new Date().toISOString(), reportDirectory, settings };
    await fs.writeFile(join(reportDirectory, 'background.json'), JSON.stringify(background, null, 2), { mode: 0o600 });
    child.unref();
    console.log(`Background validation started: PID ${child.pid}. Results: ${reportDirectory}`);
  } catch (error) {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch (killError) { if (killError.code !== 'ESRCH') console.error('Failed to stop background validation after launch failure:', killError.message); } }
    throw error;
  } finally { await consoleFile.close(); }
  process.exit(0);
}
const temporary = await fs.mkdtemp(join(tmpdir(), 'halo-sdk-validation-'));
const snapshot = join(temporary, 'sdk');
const sandbox = join(temporary, 'sandbox');
const report = { startedAt: new Date().toISOString(), profile, settings, platform: process.platform,
  arch: process.arch, node: process.version, source: {}, scenarios: [], passed: false };
const scrub = text => key ? text.replaceAll(key, '[REDACTED]') : text;
let interrupted = false;
let activeChild;
const journalPath = join(reportDirectory, 'events.jsonl');
writeFileSync(journalPath, '', { flag: 'wx', mode: 0o600 });
let journalBytes = 0;
const record = (type, data) => {
  const line = scrub(JSON.stringify({ type, time: new Date().toISOString(), ...data })) + '\n';
  journalBytes += Buffer.byteLength(line);
  if (journalBytes > 64 * 1024 * 1024) throw new Error('Validation journal exceeded its 64 MiB limit');
  appendFileSync(journalPath, line);
};
const runState = { pid: process.pid, parentPid: process.ppid, startedAt: report.startedAt, settings, snapshot, sandbox };
const checkpointState = changes => {
  Object.assign(runState, changes, { updatedAt: new Date().toISOString() });
  const path = join(reportDirectory, 'run-state.tmp');
  writeFileSync(path, scrub(JSON.stringify(runState, null, 2)), { mode: 0o600 });
  renameSync(path, join(reportDirectory, 'run-state.json'));
};
record('supervisor-start', runState);
checkpointState({ status: 'building' });
process.once('uncaughtExceptionMonitor', error => {
  try { record('supervisor-error', { error: scrub(error.stack ?? String(error)) }); } catch { /* The uncaught error still reaches console.log. */ }
  activeChild?.kill('SIGTERM');
});
process.once('exit', code => {
  try {
    record('supervisor-exit', { code });
    checkpointState({ status: 'exited', exitCode: code, passed: code === 0 && report.passed, interrupted, actorPid: null });
  } catch { /* A failed record cannot become a passing final report. */ }
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  record('supervisor-signal', { signal });
  interrupted = true;
  activeChild?.kill('SIGTERM');
});

async function buildSnapshot() {
  const { stdout } = await exec('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { cwd: source, maxBuffer: 4 * 1024 * 1024 });
  const files = [...new Set(stdout.split('\0').filter(Boolean))].filter(file =>
    !file.startsWith('validation/results/') && !file.startsWith('node_modules/') && !file.startsWith('dist/') &&
    !file.startsWith('swe-bench-eval/') && !file.split('/').some(part => part.startsWith('.env')));
  const hash = createHash('sha256');
  let copiedFiles = 0;
  for (const file of files.sort()) {
    const input = join(source, file);
    let stat;
    try { stat = await fs.lstat(input); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) continue;
    const bytes = await fs.readFile(input);
    hash.update(file).update('\0').update(bytes);
    const output = join(snapshot, file);
    await fs.mkdir(dirname(output), { recursive: true });
    await fs.writeFile(output, bytes);
    copiedFiles++;
  }
  report.source = { head: (await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim(),
    snapshotSha256: hash.digest('hex'), files: copiedFiles,
    dirtyPaths: (await exec('git', ['status', '--short'], { cwd: source })).stdout.trim().split('\n') };
  record('source', report.source);
  checkpointState({ source: report.source });
  await fs.symlink(join(source, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
  try {
    const build = await exec(process.execPath, [join(source, 'node_modules/typescript/bin/tsc'), '-p', join(snapshot, 'tsconfig.json')],
      { cwd: snapshot, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    await fs.writeFile(join(reportDirectory, 'build.log'), scrub(build.stdout + build.stderr));
  } catch (error) {
    await fs.writeFile(join(reportDirectory, 'build.log'), scrub((error.stdout ?? '') + (error.stderr ?? '')));
    throw error;
  }
  console.log(`Built isolated SDK snapshot ${report.source.snapshotSha256.slice(0, 12)}`);
}

async function runScenario(scenario, extra = {}) {
  if (interrupted) throw new Error('Validation interrupted');
  const entry = { scenario, startedAt: new Date().toISOString(), samples: [], osSamples: [], checks: [], errors: [], ownedChildren: [] };
  report.scenarios.push(entry);
  await fs.mkdir(sandbox, { recursive: true });
  const env = { ...process.env, AGENT_SDK_LOG_LEVEL: 'warn' };
  for (const name of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD/i.test(name)) delete env[name];
  const child = fork(join(snapshot, 'validation/actor.mjs'), [], { execArgv: ['--expose-gc'], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  await once(child, 'spawn');
  activeChild = child;
  record('scenario-start', { scenario, actorPid: child.pid });
  checkpointState({ status: 'running', scenario, actorPid: child.pid });
  let log = '';
  const logPath = join(reportDirectory, `${scenario}.log`);
  writeFileSync(logPath, '', { mode: 0o600 });
  const appendLog = text => {
    const part = text.slice(0, Math.max(0, 1024 * 1024 - log.length));
    if (part) { log += part; appendFileSync(logPath, part); }
  };
  const decoder = new StringDecoder('utf8');
  let pendingLog = '';
  const capture = bytes => {
    pendingLog = scrub(pendingLog + decoder.write(bytes));
    const cut = Math.max(0, pendingLog.length - Math.max(0, key.length - 1));
    appendLog(pendingLog.slice(0, cut));
    pendingLog = pendingLog.slice(cut);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  let recovery;
  let done = false;
  let collecting = false;
  const tracked = new Map();
  const ownershipChecks = [];
  const collect = async label => {
    if (collecting && !label) return;
    while (collecting) await new Promise(resolve => setTimeout(resolve, 20));
    if (child.exitCode !== null || child.signalCode) return;
    collecting = true;
    try {
      const [tree, descriptors, disk] = await Promise.all([processTree(child.pid), descriptorCount(child.pid), diskUsage(sandbox)]);
      for (const item of tree.processes) if (item.pid !== child.pid) tracked.set(item.pid, item.identity);
      const measurement = { label, time: Date.now(), treeRss: tree.processes.reduce((sum, item) => sum + item.rss, 0),
        children: tree.processes.filter(item => item.pid !== child.pid).length, descriptors, disk };
      entry.osSamples.push(measurement);
      record('os-sample', { scenario, measurement });
    } catch (error) {
      if (child.exitCode === null && !child.signalCode) entry.errors.push(`Resource sampling failed: ${error.message}`);
    } finally { collecting = false; }
  };
  child.on('message', message => {
    record('actor-event', { scenario, message });
    if (message.type === 'sample') {
      entry.samples.push(message);
      if (message.label) void collect(message.label).finally(() => {
        if (child.connected) child.send({ type: 'sample-ack', label: message.label }, error => {
          if (error && child.exitCode === null) entry.errors.push(`Sample acknowledgement failed: ${error.message}`);
        });
      });
    }
    if (message.type === 'progress') {
      console.log(`${scenario}: rounds=${message.rounds}, results=${message.results}, toolCalls=${message.toolCalls}`);
      try {
        const checkpoint = { scenario, time: new Date().toISOString(), rounds: message.rounds, results: message.results,
          toolCalls: message.toolCalls, sample: entry.samples.at(-1), resources: entry.osSamples.at(-1) };
        const temporaryProgress = join(reportDirectory, 'progress.tmp');
        writeFileSync(temporaryProgress, JSON.stringify(checkpoint, null, 2));
        renameSync(temporaryProgress, join(reportDirectory, 'progress.json'));
        checkpointState({ rounds: message.rounds, results: message.results, toolCalls: message.toolCalls });
      } catch (error) { entry.errors.push(`Progress checkpoint failed: ${error.message}`); child.kill('SIGTERM'); }
    }
    if (message.type === 'checks') entry.checks.push(message);
    if (message.type === 'owned-child') {
      entry.ownedChildren.push(message.pid);
      ownershipChecks.push(processTree(child.pid).then(tree => {
        const owned = tree.processes.find(item => item.pid === message.pid && item.pid !== child.pid);
        if (owned) tracked.set(owned.pid, owned.identity);
        else entry.errors.push('A reported subprocess could not be verified as an SDK descendant');
        if (child.connected) child.send({ type: 'child-ack', pid: message.pid, owned: !!owned }, error => {
          if (error && child.exitCode === null) entry.errors.push(`Child acknowledgement failed: ${error.message}`);
        });
      }).catch(error => entry.errors.push(`Child identity sampling failed: ${error.message}`)));
    }
    if (message.type === 'failure') entry.errors.push(scrub(message.error));
    if (message.type === 'done') done = true;
    if (message.type === 'crash-ready') { recovery = message; child.kill('SIGKILL'); }
  });
  const timeoutMs = (settings.durationSeconds + 600) * 1000;
  const watchdog = setTimeout(() => { entry.errors.push('Scenario exceeded external deadline'); child.kill('SIGKILL'); }, timeoutMs);
  const sampler = setInterval(() => { void collect(); }, 2000);
  const exit = once(child, 'close');
  child.send({ ...settings, key, sdk: snapshot, sandbox, scenario, ...extra }, error => {
    if (error) { entry.errors.push(`Scenario startup failed: ${error.message}`); child.kill('SIGTERM'); }
  });
  const [code, signal] = await exit;
  appendLog(scrub(pendingLog + decoder.end()));
  record('scenario-exit', { scenario, code, signal });
  clearTimeout(watchdog);
  clearInterval(sampler);
  while (collecting) await new Promise(resolve => setTimeout(resolve, 20));
  activeChild = undefined;
  entry.exit = { code, signal };
  if (interrupted) entry.errors.push('Validation interrupted');
  await Promise.all(ownershipChecks);
  const remaining = new Map((await processTable()).processes.map(process => [process.pid, process.identity]));
  for (const [pid, identity] of tracked) {
    if (remaining.get(pid) !== identity) continue;
    try {
      if (await processIdentity(pid) !== identity) continue;
      process.kill(pid, 0);
      entry.errors.push(`Owned subprocess survived scenario exit: ${pid}`);
      process.kill(pid, 'SIGKILL');
    } catch (error) { if (error.code !== 'ESRCH') entry.errors.push(`Subprocess verification failed: ${error.message}`); }
  }
  if (scenario === 'workload') {
    entry.compactionBudgetFailures = (log.match(/automatic compaction failed[^\n]*summary exceeded its output budget/g) ?? []).length;
    if (entry.compactionBudgetFailures > 0) {
      entry.errors.push(`Compaction exceeded its output budget ${entry.compactionBudgetFailures} times`);
    }
    entry.resources = evaluate(entry.samples, entry.osSamples, profile);
    entry.errors.push(...entry.resources.failures);
  }
  if (!(scenario === 'recovery' && recovery) && (!done || code !== 0)) entry.errors.push('Scenario did not finish successfully');
  entry.passed = entry.errors.length === 0;
  entry.finishedAt = new Date().toISOString();
  record('scenario-result', { scenario, passed: entry.passed, errors: entry.errors, resources: entry.resources });
  await fs.writeFile(join(reportDirectory, `${scenario}.log`), log);
  console.log(`${scenario}: ${entry.passed ? 'PASS' : 'FAIL'}`);
  return recovery;
}

try {
  await buildSnapshot();
  await runScenario('workload');
  const recovery = await runScenario('recovery');
  if (recovery) await runScenario('resume', { recovery });
  report.passed = report.scenarios.length === 3 && report.scenarios.every(entry => entry.passed);
} catch (error) {
  report.error = scrub(error.stack ?? String(error));
  console.error(scrub(error.message));
} finally {
  report.finishedAt = new Date().toISOString();
  if (args.includes('--keep-sandbox')) report.sandbox = temporary;
  await fs.writeFile(join(reportDirectory, 'report.json'), JSON.stringify(report, null, 2));
  await writeReport(report, reportDirectory);
  checkpointState({ status: 'finished', passed: report.passed, finishedAt: report.finishedAt, actorPid: null });
  if (!args.includes('--keep-sandbox')) await fs.rm(temporary, { recursive: true, force: true });

  console.log(`Report: ${join(reportDirectory, 'report.json')}`);
  process.exitCode = report.passed ? 0 : 1;
}
