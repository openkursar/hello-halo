const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const configuration = JSON.parse(process.argv[1]);
let stopping = false;
let grace;
function terminateGroup() {
  if (grace) clearTimeout(grace);
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).once('close', () => process.exit(1));
  } else {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
  }
}
const target = configuration.supervisorPath || configuration.workerPath;
const args = target ? [target, JSON.stringify(configuration)] : ['-e', configuration.adapterSource, JSON.stringify(configuration)];
const backend = spawn(process.execPath, args, { env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
backend.stderr.pipe(process.stderr);
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
backend.on('message', send);
backend.once('error', () => { send({ type: 'error', sdkError: { token: configuration.ownedErrorToken, kind: 'launch_failed' } }); terminateGroup(); });
backend.once('close', (code, signal) => {
  if (!stopping) send({ type: 'error', sdkError: { token: configuration.ownedErrorToken, kind: 'worker_exited', status: String(signal ?? code ?? 'unknown') } });
  terminateGroup();
});
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { send({ type: 'error', sdkError: { token: configuration.ownedErrorToken, kind: 'invalid_request' } }); terminateGroup(); return; }
  if (request.type === 'close') {
    stopping = true;
    if (request.force) { terminateGroup(); return; }
    grace = setTimeout(terminateGroup, 1000);
    grace.unref();
  }
  if (!backend.connected) { terminateGroup(); return; }
  backend.send(request, error => { if (error) { send({ type: 'error', sdkError: { token: configuration.ownedErrorToken, kind: 'ipc_closed' } }); terminateGroup(); } });
});
input.once('close', terminateGroup);
process.once('SIGTERM', terminateGroup);
process.once('SIGINT', terminateGroup);
