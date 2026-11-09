import { spawn } from 'node:child_process';
import { killProcessTree } from '../utils/processes.js';
import type { WorkerConfiguration, WorkerRequest, WorkerResponse } from './protocol.js';

// The backend shares this process group, but cannot block this event loop.
const configuration = JSON.parse(process.argv[2]) as WorkerConfiguration;
let stopping = false;
let grace: ReturnType<typeof setTimeout> | undefined;
function terminateGroup(): void {
  if (grace) clearTimeout(grace);
  void killProcessTree(process.pid, 'SIGKILL').finally(() => process.exit(1));
}
process.on('disconnect', terminateGroup);
process.on('SIGTERM', terminateGroup);
process.on('SIGINT', terminateGroup);

if (!process.connected) terminateGroup();
else {
  const backend = spawn(process.execPath, [configuration.workerPath, JSON.stringify(configuration)], {
    env: process.env, windowsHide: true, detached: false, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  backend.stderr?.pipe(process.stderr);
  const fail = (message: string) => {
    if (process.connected) process.send?.({ type: 'error', message } satisfies WorkerResponse, () => terminateGroup());
    else terminateGroup();
  };
  backend.on('error', () => fail('The code search backend could not be launched.'));
  backend.on('message', (message: unknown) => {
    if (process.connected) process.send?.(message as WorkerResponse, error => { if (error) terminateGroup(); });
  });
  backend.on('close', (code, signal) => {
    if (stopping) terminateGroup();
    else fail(`The code search worker exited before completing its request (${signal ?? code ?? 'unknown'}).`);
  });
  process.on('message', (request: WorkerRequest) => {
    if (request?.type === 'close') {
      stopping = true;
      if (request.force) { terminateGroup(); return; }
      grace = setTimeout(terminateGroup, 1000);
      grace.unref();
    }
    if (!backend.connected) { terminateGroup(); return; }
    backend.send(request, error => { if (error) fail('The code search backend IPC channel closed.'); });
  });
}
