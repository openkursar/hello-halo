import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/windows-stop-workload.mjs', import.meta.url));
const observerScript = fileURLToPath(new URL('./fixtures/windows-stop-observer.ps1', import.meta.url));
const kinds = ['sleep', 'native-tree', 'churn'];
const readyMs = 45_000, receiptMs = 30_000, cleanupMs = 30_000;
const quote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
const fixtureCommand = role => `${quote(process.execPath)} ${quote(fixture)} ${role}`;
const exists = async path => { try { await access(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const bounded = async (promise, ms, fallback) => {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })]); }
  finally { clearTimeout(timer); }
};
async function until(check, ms) {
  const end = performance.now() + ms;
  do { if (await check()) return true; await delay(30); } while (performance.now() < end);
  return false;
}

export function classify(result, requested) {
  if (!result || typeof result.content !== 'string' || typeof result.isError !== 'boolean') return 'missing-receipt';
  if (!result.isError) return 'command-completed';
  if (!requested) return 'command-error';
  if (result.content.startsWith('Command was stopped, but not every process it started could be confirmed stopped.')) return 'cancel-unconfirmed';
  // Foreground Bash represents an explicit abort with 130. These finite fixtures never exit with 130 themselves.
  if (/^Command exited with code 130(?:\n|$)/.test(result.content)) return 'cancel-confirmed';
  return 'command-error';
}

export function plan(concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 10 || concurrency > 20) throw Error('Invalid concurrency');
  return { schemaVersion: 1, phase: 'planned', outcome: 'incomplete', nodeVersion: process.versions.node,
    concurrency, coverage: 'registered-fixture-members-only', shellIdentity: 'msys-bash-winpid-not-outer-launcher',
    neighbourScope: 'separate-direct-tool-owner', passiveFallbackSeconds: {sleep: 150, actor: 180},
    groups: kinds.flatMap(kind => [1, concurrency].map(width => ({
      kind, width, phase: 'planned', neighbour: 'not-started', neighbourWriteDuringStop: 'not-sampled', observer: 'not-started', fixtureRelease: 'not-started',
      samples: Array.from({length: width}, (_, index) => ({ index, ready: false, requested: false, receipt: 'not-requested',
        requestToReceiptMs: null, receiptSinceFirstRequestMs: null, observationLagMs: null, residuals: null })),
    }))) };
}

export function summarize(group) {
  const received = group.samples.filter(s => s.requested && Number.isFinite(s.receiptSinceFirstRequestMs));
  const valid = received.filter(s => s.receipt === 'cancel-confirmed' || s.receipt === 'cancel-unconfirmed');
  const latencies = valid.map(s => s.requestToReceiptMs).filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => latencies.length ? latencies[Math.ceil(latencies.length * p) - 1] : null;
  const confirmed = valid.filter(s => s.receipt === 'cancel-confirmed').length;
  const residual = key => group.samples.reduce((n, s) => n + (s.residuals?.[key] ?? 0), 0);
  return {
    planned: group.width, requested: group.samples.filter(s => s.requested).length, received: received.length,
    missingReceipt: group.samples.filter(s => s.requested && !Number.isFinite(s.receiptSinceFirstRequestMs)).length,
    notRequested: group.samples.filter(s => !s.requested).length, invalidStopResults: received.length - valid.length,
    rateDenominator: valid.length, confirmed, unconfirmed: valid.length - confirmed,
    confirmedRate: valid.length ? confirmed / valid.length : null, unconfirmedRate: valid.length ? (valid.length - confirmed) / valid.length : null,
    batchWallMs: received.length === group.width ? Math.max(...received.map(s => s.receiptSinceFirstRequestMs)) : null,
    validStopLatencyMs: { count: latencies.length, min: latencies[0] ?? null, p50: percentile(0.5), p95: percentile(0.95), max: latencies.at(-1) ?? null },
    observedMembers: { exited: residual('exited'), running: residual('running'), unknown: residual('unknown'),
      samplesNotObserved: group.samples.filter(s => !s.residuals).length },
  };
}

export function outcome(report) {
  if (!report.groups.length) return 'incomplete';
  if (report.groups.some(g => g.neighbour === 'failed' || g.samples.some(s => s.requested && (
    s.receipt === 'command-completed' || s.receipt === 'command-error' || (s.receipt === 'cancel-confirmed' && s.residuals?.running > 0))))) return 'failed';
  if (report.groups.some(g => g.phase !== 'finished' || g.fixtureRelease !== 'released' || g.observer !== 'available' || g.neighbour !== 'continued' ||
    g.reason || summarize(g).rateDenominator !== g.width || !g.samples.some(s => s.residuals?.boundHandles > 0))) return 'incomplete';
  if (report.groups.some(g => g.samples.some(s => !s.ready || !s.requested || s.receipt !== 'cancel-confirmed' || !s.residuals || s.residuals.unknown > 0))) return 'measured-with-uncertainty';
  return 'measured';
}

// One private observer per group. Only opaque labels and states, never IDs, images or paths, go into the report.
async function startObserver() {
  const exe = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const proc = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', observerScript], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const lines = createInterface({ input: proc.stdout });
  let seq = 0, unavailable = false;
  const pending = new Map();
  const ready = new Promise(resolve => pending.set(0, resolve));
  const closed = new Promise(resolve => proc.once('close', resolve));
  const end = () => { unavailable = true; for (const finish of pending.values()) finish(null); pending.clear(); };
  proc.on('error', end); proc.stdin.on('error', end); lines.once('close', end);
  lines.on('line', line => {
    try {
      const frame = JSON.parse(line), id = frame.ready === true ? 0 : frame.id;
      pending.get(id)?.(frame); pending.delete(id);
    } catch { end(); }
  });
  if (!await bounded(ready, 20_000, null)) { proc.stdin.end(); proc.kill(); return null; }
  return {
    async request(cmd, members) {
      if (unavailable || !members.length) return [];
      const id = ++seq;
      const response = new Promise(resolve => pending.set(id, resolve));
      proc.stdin.write(`${JSON.stringify({id, cmd, members})}\n`);
      const frame = await bounded(response, 5000, null);
      pending.delete(id);
      return Array.isArray(frame?.states) && frame.states.length === members.length ? frame.states : [];
    },
    async close() {
      proc.stdin.end();
      if (!await bounded(closed.then(() => true), 3000, false)) proc.kill();
      return bounded(closed.then(() => true), 3000, false);
    },
  };
}

// $! is an MSYS PID, not a Win32 PID. Only the Git installation's /proc mapping is passed to OpenProcess.
const shellIdentity = 'cat /proc/$$/winpid > shell.pid 2>/dev/null || :; ';
const sleepCommand = 'sleep 150 & sleeper=$!; cat /proc/$sleeper/winpid > sleep.pid 2>/dev/null || :; kill -0 "$sleeper" 2>/dev/null && printf 1 > ready; wait "$sleeper"';
async function membersFor(dir, index, kind) {
  const names = await readdir(dir);
  const children = names.filter(n => /^launch-\d+$/.test(n)).map(n => Number(n.slice(7)));
  const roles = ['shell', ...(kind === 'sleep' ? ['sleep'] : ['parent', ...(children.length ? children : [0]).map(n => `child-${n}`)])];
  const members = [];
  for (const role of roles) {
    const msys = role === 'shell' || role === 'sleep';
    let pid;
    try { const text = (await readFile(join(dir, `${role}.pid`), 'utf8')).trim(); if (/^[1-9]\d{0,9}$/.test(text) && Number(text) <= 0xffffffff) pid = Number(text); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    members.push({ key: `${index}:${role}`, role, pid, msys, marker: join(dir, `${role}.pid`), image: role === 'shell' ? 'bash.exe' : role === 'sleep' ? 'sleep.exe' : basename(process.execPath),
      naturallyExited: role.startsWith('child-') && names.includes(`exit-${role.slice(6)}`) });
  }
  return members;
}

export function residuals(members, states) {
  const result = { expectedMembers: members.length, boundHandles: 0, exited: 0, running: 0, unknown: 0, msysMapped: 0, msysUnmapped: 0 };
  for (const m of members) {
    if (m.msys) result[m.pid ? 'msysMapped' : 'msysUnmapped']++;
    const state = states.get(m.key);
    if (state === 'running' || state === 'exited') result.boundHandles++;
    if (state === 'running' && m.naturallyExited) result.unknown++;
    else if (m.naturallyExited) result.exited++;
    else if (state === 'exited' || state === 'running') result[state]++;
    else result.unknown++;
  }
  return result;
}

async function measureGroup(group, root, sdk, release, save) {
  const bash = sdk.findToolByName(sdk.getAllTools(), 'Bash');
  const observer = await startObserver();
  group.observer = observer ? 'available' : 'unavailable';
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'SYSTEMDRIVE', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'AGENT_SHELL', 'AGENT_GIT_BASH_PATH']);
  const env = Object.fromEntries(Object.keys(process.env).filter(key => !allowed.has(key.toUpperCase())).map(key => [key, undefined]));
  Object.assign(env, { HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root, CLAUDE_CONFIG_DIR: root });
  const tasks = [];
  let neighbour;
  const launch = async (dir, command) => {
    await mkdir(dir);
    const ctl = new AbortController(), sessionId = randomUUID();
    const task = { dir, ctl, sessionId, done: false };
    // Keep tool errors and raw output in memory only, never in the JSON or workflow console.
    task.pending = Promise.resolve().then(() => bash.execute({ command, timeout: 240_000 }, {
      cwd: dir, env,
      sessionId, abortSignal: ctl.signal, costTracker: new sdk.CostTracker('fixture'), currentTurn: 1, readFileState: new Map(),
    })).then(result => ({ result, ended: performance.now() }), () => ({ result: null, ended: performance.now() }))
      .then(receipt => { task.done = true; return receipt; });
    return task;
  };
  try {
    group.phase = 'starting'; await save();
    neighbour = await launch(join(root, 'neighbour'), fixtureCommand('neighbour'));
    for (const s of group.samples) tasks.push(await launch(join(root, String(s.index)), shellIdentity + (group.kind === 'sleep' ? sleepCommand : fixtureCommand(group.kind))));
    const ready = await until(async () => {
      await Promise.all(group.samples.map(async (s, i) => { s.ready = await exists(join(tasks[i].dir, 'ready')); }));
      return tasks.some(t => t.done) || neighbour.done || (group.samples.every(s => s.ready) && await exists(join(neighbour.dir, 'before')));
    }, readyMs);
    const observe = async (cmd, members) => {
      const known = members.filter(m => m.pid), values = await observer?.request(cmd, known) ?? [];
      if (observer && known.length && values.length !== known.length) group.observer = 'interrupted';
      return new Map(known.map((m, i) => [m.key, values[i]]));
    };
    if (ready && !tasks.some(t => t.done) && !neighbour.done && group.samples.every(s => s.ready) && await exists(join(neighbour.dir, 'before'))) {
      const before = await Promise.all(tasks.map((task, i) => membersFor(task.dir, i, group.kind)));
      await observe('bind', before.flat());
      group.phase = 'ready'; await save();
      const neighbourLostBeforeStop = neighbour.done;
      if (neighbourLostBeforeStop) group.neighbour = 'failed';
      if (!tasks.some(t => t.done) && !neighbourLostBeforeStop) {
        let firstRequest;
        const pending = tasks.map(async (task, i) => {
          const s = group.samples[i];
          s.requested = true; const start = performance.now(); firstRequest ??= start; task.ctl.abort();
          const receipt = await bounded(task.pending, receiptMs, null);
          s.receipt = classify(receipt?.result, true);
          if (receipt && s.receipt !== 'missing-receipt') {
            s.requestToReceiptMs = Math.max(0, Math.round(receipt.ended - start));
            s.receiptSinceFirstRequestMs = Math.max(0, Math.round(receipt.ended - firstRequest));
          }
          const after = await membersFor(task.dir, i, group.kind);
          const states = await observe('sample', after);
          if (receipt) s.observationLagMs = Math.max(0, Math.round(performance.now() - receipt.ended));
          s.residuals = residuals(after, states);
          await save();
        });
        const settled = Promise.allSettled(pending);
        group.phase = 'stop-requested';
        await writeFile(join(neighbour.dir, 'observe-stop'), '1');
        await save();
        group.neighbourWriteDuringStop = 'not-observed';
        await until(async () => {
          const written = await exists(join(neighbour.dir, 'during'));
          if (written && tasks.some(task => !task.done)) group.neighbourWriteDuringStop = 'observed';
          return written || tasks.every(task => task.done);
        }, receiptMs);
        if ((await settled).some(r => r.status === 'rejected')) group.reason = 'sample-unavailable';
        await writeFile(join(neighbour.dir, 'go'), '1');
        const answer = await bounded(neighbour.pending, receiptMs, null);
        const markers = await Promise.all(['during', 'after'].map(name => readFile(join(neighbour.dir, name), 'utf8').catch(() => '')));
        group.neighbour = !answer?.result ? 'unconfirmed' : answer.result.isError === false && markers.every(value => value === '1') ? 'continued' : 'failed';
      }
    }
    for (const [i, task] of tasks.entries()) if (!group.samples[i].requested && task.done) group.samples[i].receipt = classify((await task.pending).result, false);
    group.phase = 'measured'; await save();
  } finally {
    let cleaned = true;
    const owned = [...tasks, ...(neighbour ? [neighbour] : [])];
    // Recovery is not a measurement. Release only this group's private fixtures and SDK owners.
    for (const t of owned) { await writeFile(join(t.dir, 'finish'), '1').catch(() => { cleaned = false; }); if (!t.done) t.ctl.abort(); }
    const drained = await bounded(Promise.allSettled(owned.map(t => t.pending)).then(() => true), cleanupMs, false);
    cleaned = cleaned && drained;
    const releases = await bounded(Promise.allSettled(owned.map(t => release(t.sessionId))), cleanupMs, null);
    cleaned = cleaned && !!releases && releases.every(r => r.status === 'fulfilled');
    if (observer && !await observer.close()) cleaned = false;
    await rm(root, { recursive: true, force: true, maxRetries: 2 }).catch(() => { cleaned = false; });
    // Release describes the fixture/SDK owners only, not the absence of descendants after sampling.
    group.fixtureRelease = cleaned ? 'released' : 'unconfirmed';
  }
  group.phase = 'finished';
}

async function main(args) {
  const outputFlag = args.indexOf('--output');
  if (outputFlag < 0 || !args[outputFlag + 1]) throw Error('Missing --output');
  const output = resolve(args[outputFlag + 1]);
  let report = { schemaVersion: 1, phase: 'planned', outcome: 'incomplete', groups: [] };
  const stage = `${output}.${randomUUID()}.tmp`;
  // Serialize checkpoints; all stop requests still start together, without waiting for report I/O.
  let writes = Promise.resolve();
  const save = () => {
    const json = JSON.stringify({ ...report, groups: report.groups.map(g => ({ ...g, summary: summarize(g) })) }, null, 2) + '\n';
    writes = writes.then(async () => {
      await writeFile(stage, json, { encoding: 'utf8', mode: 0o600 });
      await rename(stage, output);
    });
    return writes;
  };
  await mkdir(dirname(output), { recursive: true });
  await save();
  try {
    const { values } = (await import('node:util')).parseArgs({ args, options: {output:{type:'string'}, concurrency:{type:'string', default:'12'}} });
    report = plan(Number(values.concurrency)); await save();
    if (process.platform !== 'win32') { report.reason = 'windows-required'; return 2; }
    const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
    const sdk = await import(pathToFileURL(join(compiled, 'native/index.js')).href);
    const { releaseNativeToolOwner } = await import(pathToFileURL(join(compiled, 'native/tools.js')).href);
    const logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger, isLevelEnabled: () => false };
    sdk.setLogger(logger);
    const buildId = sdk.runtimeInfo().buildId;
    if (/^[0-9a-f]{64}$/.test(buildId)) report.buildId = buildId;
    report.phase = 'running';
    for (const group of report.groups) {
      const dir = await mkdtemp(join(tmpdir(), 'sdk-stop-'));
      await measureGroup(group, dir, sdk, releaseNativeToolOwner, save);
      await save();
    }
    report.phase = 'finished'; report.outcome = outcome(report);
    return report.outcome === 'failed' ? 1 : report.outcome === 'incomplete' ? 2 : 0;
  } catch { report.reason = 'measurement-error'; return 2; }
  finally { await save(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The durable report is complete even if a timed-out SDK owner still references the event loop.
  main(process.argv.slice(2)).then(code => process.exit(code), () => { console.error('Could not write Windows stop measurement report.'); process.exit(2); });
}
