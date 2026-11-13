import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

export function executionEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/API_KEY|TOKEN|SECRET|PASSWORD/i.test(name)));
}

export async function buildSdk(snapshot, source, logPath, controls = {}) {
  controls.signal?.throwIfAborted();
  const environment = executionEnvironment();
  environment.CARGO_TARGET_DIR = resolve(source, 'native', environment.CARGO_TARGET_DIR || 'target');
  const child = spawn(process.execPath, [join(snapshot, 'scripts/build.mjs')], {
    cwd: snapshot, env: environment, detached: process.platform !== 'win32',
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', bytes = 0, failure, force;
  const maximum = 4 * 1024 * 1024;
  const terminate = signal => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      const command = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      command.on('error', error => { failure ??= error; child.kill('SIGKILL'); });
    } else {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') { failure ??= error; child.kill(signal); } }
    }
  };
  const stop = error => {
    if (failure) return;
    failure = error;
    terminate('SIGTERM');
    force = setTimeout(() => terminate('SIGKILL'), 5000);
  };
  const capture = stream => {
    const decoder = new StringDecoder('utf8');
    stream.on('data', chunk => {
      const remaining = Math.max(0, maximum - bytes);
      output += decoder.write(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > maximum) stop(new Error('SDK build output exceeded its 4 MiB limit'));
    });
    stream.on('end', () => { output += decoder.end(); });
  };
  capture(child.stdout); capture(child.stderr);
  child.once('spawn', () => controls.onStart?.(child.pid));
  const abort = () => stop(controls.signal.reason ?? new Error('SDK build interrupted'));
  controls.signal?.addEventListener('abort', abort, { once: true });
  if (controls.signal?.aborted) abort();
  const deadline = setTimeout(() => stop(new Error('SDK build exceeded its external deadline')), controls.timeoutMs ?? BUILD_TIMEOUT_MS);
  let result;
  try {
    result = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept({ code, signal }));
    });
  } finally {
    clearTimeout(deadline); clearTimeout(force);
    controls.signal?.removeEventListener('abort', abort);
    await fs.writeFile(logPath, controls.scrub ? controls.scrub(output) : output);
  }
  if (failure) throw failure;
  if (result.code !== 0) throw new Error(`SDK build failed (${result.code ?? result.signal}); see build.log`);
  const native = JSON.parse(await fs.readFile(join(snapshot, 'dist/native/build-info.json'), 'utf8'));
  const artifact = native.artifacts?.find(artifact => artifact.platform === `${process.platform}-${process.arch}`);
  if (native.implementation !== 'rust' || !/^[0-9a-f]{64}$/.test(native.buildId ?? '') ||
      !Number.isInteger(native.abiVersion) || native.abiVersion < 1 || !artifact ||
      artifact.filename !== `halo-sdk.${process.platform}-${process.arch}.node`) {
    throw new Error('SDK build did not produce the current platform native manifest');
  }
  const binary = await fs.readFile(join(snapshot, 'dist/native', artifact.filename));
  if (createHash('sha256').update(binary).digest('hex') !== artifact.sha256) {
    throw new Error('SDK native artifact does not match its build manifest');
  }
  return native;
}
