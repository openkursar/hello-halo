import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

const args = process.argv.slice(2);
const value = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const mode = value('mode');
if (!mode) {
  const runs = [];
  for (const execution of ['direct', 'workers']) {
    runs.push(await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args, `--mode=${execution}`], {
        stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, AGENT_SDK_LOG_LEVEL: 'silent' }, windowsHide: true,
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('exit', code => {
        if (code !== 0) reject(new Error(`Benchmark ${execution} exited with ${code}`));
        else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } }
      });
    }));
  }
  console.log(JSON.stringify({ note: 'Local mock model; compare on the same machine. Not a model-speed or release acceptance claim.', runs }, null, 2));
} else {
  if (!['direct', 'workers'].includes(mode)) throw new Error('mode must be direct or workers');
  process.env.AGENT_SDK_LOG_LEVEL = 'silent';
  const count = Number(value('sessions', '10'));
  const chars = Number(value('chars', '131072'));
  const rounds = Number(value('rounds', '3'));
  if (![count, chars, rounds].every(number => Number.isSafeInteger(number) && number > 0)) throw new Error('Invalid benchmark size');
  const directory = await mkdtemp(join(tmpdir(), 'sdk-worker-benchmark-'));
  const sent = new Map();
  const firstRequest = new Map();
  const server = createServer((req, res) => {
    const id = String(req.headers['x-benchmark-session']);
    if (!firstRequest.has(id)) firstRequest.set(id, performance.now() - sent.get(id));
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'message_start', message: { id: 'benchmark', type: 'message', role: 'assistant', model: 'benchmark', content: [], usage: { input_tokens: chars / 4, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'complete' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ];
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let runtime;
  const sessions = [];
  const loop = monitorEventLoopDelay({ resolution: 10 });
  let peakRss = process.memoryUsage().rss;
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 25);
  const cpuStart = process.cpuUsage();
  try {
    const coldStart = performance.now();
    const sdk = await import(mode === 'workers' ? '../dist/worker/index.js' : '../dist/index.js');
    if (mode === 'workers') { runtime = sdk.createWorkerRuntime(); await runtime.initialize(); }
    const coldReadyMs = performance.now() - coldStart;
    const create = options => runtime ? runtime.createSession(options, { group: 'benchmark' }) : sdk.createSession(options);
    const config = index => ({ model: 'benchmark', apiKey: 'benchmark', anthropicBaseUrl: `http://127.0.0.1:${server.address().port}`,
      cwd: directory, env: { CLAUDE_CONFIG_DIR: directory }, tools: [], settingSources: [], systemPrompt: 'Benchmark assistant.',
      contextWindow: 2_000_000, persistSession: index === 0, turnEndChecks: { openWork: false, completion: false },
      requestIdentity: { headers: { 'x-benchmark-session': String(index) } } });
    const creationMs = await Promise.all(Array.from({ length: count }, async (_, index) => {
      const start = performance.now();
      sessions[index] = await create(config(index));
      return performance.now() - start;
    }));
    loop.enable();
    await new Promise(resolve => setTimeout(resolve, 30));
    const workStart = performance.now();
    for (let round = 0; round < rounds; round++) {
      await Promise.all(sessions.map(async (session, index) => {
        if (!round) sent.set(String(index), performance.now());
        await session.send(`Synthetic input ${round}: ${'a'.repeat(chars)}`);
        for await (const event of session.stream()) if (event.type === 'result' && event.is_error) throw new Error('Benchmark turn failed');
      }));
    }
    const workMs = performance.now() - workStart;
    loop.disable();
    const sessionId = sessions[0].sessionId;
    await Promise.all(sessions.map(async session => { session.close(); await session.flush(); }));
    const restoreStart = performance.now();
    const restored = await create({ ...config(0), resume: sessionId });
    const restoreMs = performance.now() - restoreStart;
    restored.close(); await restored.flush();
    const cpu = process.cpuUsage(cpuStart);
    const sorted = values => [...values].sort((a, b) => a - b);
    const median = values => sorted(values)[Math.floor(values.length / 2)];
    console.log(JSON.stringify({ mode, platform: process.platform, arch: process.arch, node: process.version,
      cpu: cpus()[0]?.model, sessions: count, inputChars: chars, rounds, coldReadyMs,
      createMedianMs: median(creationMs), restoreMs, firstRequestArrivalMedianMs: median([...firstRequest.values()]),
      workMs, mainLoopP99Ms: loop.percentile(99) / 1e6, mainLoopMaxMs: loop.max / 1e6,
      processPeakRssMb: peakRss / 1024 / 1024, processCpuMs: (cpu.user + cpu.system) / 1000,
      workers: runtime?.diagnostics().workers.length ?? 0,
    }));
  } finally {
    clearInterval(sample); loop.disable();
    await runtime?.close();
    for (const session of sessions) { session.close(); await session.flush(); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
